// A map as a PNG, drawn once per view from OpenFreeMap's tiles (see map-drawing.ts), for contours
// with Mapterhorn's elevation tiles too (see terrain-tiles.ts and contours.ts), and kept:
// in memory until restart, and where state is saved (state/maps/), so restarts and deploys don't
// fetch the tiles again. A map is never drawn again by itself; deleting its file (or a new
// STYLE_VERSION) gets a fresh one at the next restart.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import sharp from "sharp";
import { canonicalKey, defineSource, paramsOf } from "../define-source.ts";
import { fourGrayPng } from "../four-grays.ts";
import { contourInterval, contourLines, slopeInterval } from "../contours.ts";
import {
  buildMapSvg,
  STYLE_VERSION,
  tilesFor,
  type ContourLines,
  type MapView,
  type PlacedTile,
} from "../map-drawing.ts";
import { stateDirectory } from "../state-file.ts";
import { loadTiles, TOTAL_TIMEOUT_MS } from "./openfreemap.ts";
import { loadElevations, TERRAIN_TILE_SIZE } from "./terrain-tiles.ts";

// A map that couldn't be drawn is tried again after this long
const RETRY_MS = 5 * 60_000;

// One map drawn at a time: a draw holds all its tiles in memory (about 30 MB at the default zoom),
// so two at once would double that. Reading a saved map doesn't wait.
let drawing: Promise<unknown> = Promise.resolve();

/** Runs `draw` once the draws before it have finished, whether they worked or not. */
export function oneAtATime<T>(draw: () => Promise<T>): Promise<T> {
  const result = drawing.then(draw, draw);
  // Keeps only the order, not the result
  drawing = result.then(
    () => {},
    () => {},
  );
  return result;
}

export interface MapResult {
  /** The map's PNG, the view's size; undefined if it couldn't be drawn */
  png?: Buffer;
  /** Why not, if it couldn't */
  error?: string;
}

/** The view's file, if state is saved: named after the view and the style, which it was drawn with. */
function cacheFile(view: MapView) {
  const dir = stateDirectory();
  if (!dir) return undefined;
  const hash = createHash("sha256")
    .update(canonicalKey({ ...view, style: STYLE_VERSION }))
    .digest("hex");
  return join(dir, "maps", `${hash.slice(0, 20)}.png`);
}

/** A saved map, if there is one that's a PNG of the view's size: anything else is drawn again. */
async function readCached(file: string | undefined, view: MapView) {
  if (!file) return undefined;
  let png;
  try {
    png = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`Can't read ${file}: ${(error as Error).message}`);
    return undefined;
  }
  try {
    const { format, width, height } = await sharp(png).metadata();
    if (format === "png" && width === view.width && height === view.height) return png;
  } catch {
    // Not an image at all, e.g. empty after a full disk
  }
  console.error(`Ignoring ${file}, which isn't a map of the right size: drawing it again`);
  return undefined;
}

/** Saves a drawn map; a failure only means it's drawn again after the next restart. */
async function writeCached(file: string | undefined, png: Buffer) {
  if (!file) return;
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(`${file}.tmp`, png);
    await rename(`${file}.tmp`, file);
  } catch (error) {
    console.error(`Could not save ${file}: ${(error as Error).message}`);
  }
}

export const loadMap = defineSource({
  name: "map",
  params: paramsOf<MapView>(),
  async load(view): Promise<MapResult> {
    const file = cacheFile(view);
    const cached = await readCached(file, view);
    if (cached) return { png: cached };
    // The time limit counts from now, waiting included: a device waiting for this load gets "Map
    // unavailable" (tried again later) rather than its own timeout, however many maps are queued
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    return oneAtATime(() => draw(view, file, deadline));
  },
  maxAge: (map) => (map.png ? Infinity : RETRY_MS),
  // Never shown stale (a drawn map never expires), but this makes maps ones to warm: drawn ahead
  // of need, at startup, check-ins, browser renders, moves and window changes (see screen.ts),
  // rather than in a device's request
  staleUntil: () => 0,
});

/** Draws a map from its tiles and saves it, or says why it couldn't. */
async function draw(view: MapView, file: string | undefined, deadline: number): Promise<MapResult> {
  try {
    const started = Date.now();
    const tiles = tilesFor(view);
    const [features, elevations] = await Promise.all([
      loadTiles(tiles, deadline),
      view.style === "contours" ? loadElevations(tiles, deadline) : undefined,
    ]);
    const contours = elevations && traceContours(view, tiles, elevations);
    const svg = buildMapSvg(
      view,
      tiles.map((tile, i) => ({ tile, features: features[i] })),
      contours,
    );
    // Reduced to 4 grays: a fifth of the size, and less to decode at every render
    const png = await fourGrayPng(sharp(Buffer.from(svg)));
    console.log(
      `Drew the map at ${view.lat}, ${view.lon} (zoom ${view.zoom})` +
        (contours
          ? `, contours every ${contours.interval} m${view.contourInterval ? " (set)" : ""},`
          : "") +
        ` from ${tiles.length} tiles in ${Date.now() - started} ms: ` +
        `${Math.round(svg.length / 1024)} KB of SVG, ${Math.round(png.length / 1024)} KB of PNG`,
    );
    await writeCached(file, png);
    return { png };
  } catch (error) {
    console.error(
      `Drawing the map at ${view.lat}, ${view.lon} failed: ${(error as Error).message}`,
    );
    return { error: (error as Error).message };
  }
}

/**
 * A contours map's lines: its tiles' elevations as one grid (columns counted on from the view's
 * longitude, so it can span 180°; corners without a tile, as they don't reach the map, at sea level,
 * so their edges' lines are off the map), traced every view.contourInterval metres, or by its
 * steepness (see slopeInterval).
 */
function traceContours(
  view: MapView,
  tiles: PlacedTile[],
  elevations: Float32Array[],
): ContourLines {
  const z = tiles[0]?.z ?? 0;
  const count = 2 ** z;
  const centreColumn = ((view.lon + 180) / 360) * count;
  const columns = tiles.map(
    (tile) => tile.x + count * Math.round((centreColumn - tile.x - 0.5) / count),
  );
  const left = Math.min(...columns);
  const top = Math.min(...tiles.map((tile) => tile.y));
  const across = Math.max(...columns) - left + 1;
  const down = Math.max(...tiles.map((tile) => tile.y)) - top + 1;
  const width = across * TERRAIN_TILE_SIZE;
  const grid = new Float32Array(width * down * TERRAIN_TILE_SIZE);
  tiles.forEach((tile, i) => {
    const x0 = (columns[i] - left) * TERRAIN_TILE_SIZE;
    const y0 = (tile.y - top) * TERRAIN_TILE_SIZE;
    for (let row = 0; row < TERRAIN_TILE_SIZE; row++) {
      grid.set(
        elevations[i].subarray(row * TERRAIN_TILE_SIZE, (row + 1) * TERRAIN_TILE_SIZE),
        (y0 + row) * width + x0,
      );
    }
  });
  // By its land's steepness, at the zoom's grid cells per screen pixel (the tiles are the zoom
  // rounded up, shown smaller), unless the view says
  const interval =
    view.contourInterval ??
    slopeInterval(grid, width, down * TERRAIN_TILE_SIZE, 2 ** (z - view.zoom)) ??
    contourInterval(view.zoom);
  const levels = contourLines(grid, width, down * TERRAIN_TILE_SIZE, interval);
  return {
    z,
    interval,
    levels: levels.map(({ level, index, lines }) => ({
      level,
      index,
      lines: lines.map((line) =>
        line.map((p) => ({ x: left + p.x / TERRAIN_TILE_SIZE, y: top + p.y / TERRAIN_TILE_SIZE })),
      ),
    })),
  };
}

/**
 * Deletes saved maps that aren't one of `views` in the current STYLE_VERSION: views no longer in
 * devices.yaml, or drawn in an older style. Called at startup with the views in use, as nothing else
 * ever deletes them (about 40 KB each).
 */
export async function removeUnusedMaps(views: MapView[]) {
  const dir = stateDirectory();
  if (!dir) return;
  const keep = new Set(views.map((view) => basename(cacheFile(view)!)));
  let files;
  try {
    files = await readdir(join(dir, "maps"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`Can't list saved maps: ${(error as Error).message}`);
    return;
  }
  // Leftover temporary files too (a write interrupted by a crash), but not one of a map in use: it may
  // be being drawn right now, by warming at startup
  const unused = files.filter(
    (file) =>
      (file.endsWith(".png") || file.endsWith(".png.tmp")) && !keep.has(file.replace(/\.tmp$/, "")),
  );
  await Promise.all(
    unused.map((file) =>
      unlink(join(dir, "maps", file)).catch((error) =>
        console.error(`Can't delete ${file}: ${error.message}`),
      ),
    ),
  );
  if (unused.length) console.log(`Deleted ${unused.length} saved map(s) no longer in use`);
}
