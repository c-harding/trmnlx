// Elevations from Mapterhorn (mapterhorn.com): free, without an API key, in the same Web Mercator
// tiles as the map's, each a 512 × 512 WebP whose colours hold the height of each pixel's place
// (Terrarium encoding). Copernicus's 30 m model everywhere, national ones where open: 1 m LiDAR in
// England, Wales and Bavaria, 10 m in Austria and Italy, … So summits keep their height (Yr Wyddfa
// 1085 m, where AWS's Terrain Tiles had 1045) and borders don't show as a change in detail. Its
// sources, several under CC BY, are listed at TERRAIN_ATTRIBUTION_URL.
import sharp from "sharp";
import type { PlacedTile } from "../map-drawing.ts";
import { USER_AGENT } from "../version.ts";

const URL_TEMPLATE = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
export const TERRAIN_ATTRIBUTION_URL = "https://mapterhorn.com/attribution";
// Mapterhorn's tiles are 512 px across; each is averaged down to the map tiles' 256, as a tile covers
// at most 256 of the map's pixels (see tileZoom): still a sample per pixel or more, but a quarter of
// the memory, and half the contour points, for the same lines
const SOURCE_SIZE = 512;
export const TERRAIN_TILE_SIZE = 256;
// As for the map's tiles: per request, and a few at once
const REQUEST_TIMEOUT_MS = 4_000;
const CONCURRENT_TILES = 4;

/**
 * One tile's elevations in metres, row by row; undefined if Mapterhorn has no tile there at that zoom
 * (404: its global data ends at zoom 12, finer ones are only where a national model is). Throws (with
 * a message short enough for the screen) if it can't be fetched.
 */
async function loadElevation({ z, x, y }: PlacedTile, signal: AbortSignal): Promise<Float32Array | undefined> {
  // Its own controller and timer, combined with `signal` by hand (see openfreemap.ts's get)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Mapterhorn didn't answer in time")), REQUEST_TIMEOUT_MS);
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const url = URL_TEMPLATE.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    const res = await fetch(url, { headers: { Accept: "image/webp", "User-Agent": USER_AGENT }, signal: controller.signal });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Mapterhorn answered ${res.status}`);
    const { data } = await sharp(new Uint8Array(await res.arrayBuffer())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Terrarium: red × 256 + green + blue / 256 − 32768
    const height = (x: number, y: number) => {
      const i = (y * SOURCE_SIZE + x) * 3;
      return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    };
    const heights = new Float32Array(TERRAIN_TILE_SIZE * TERRAIN_TILE_SIZE);
    for (let y = 0; y < TERRAIN_TILE_SIZE; y++) {
      for (let x = 0; x < TERRAIN_TILE_SIZE; x++) {
        heights[y * TERRAIN_TILE_SIZE + x] =
          (height(2 * x, 2 * y) + height(2 * x + 1, 2 * y) + height(2 * x, 2 * y + 1) + height(2 * x + 1, 2 * y + 1)) / 4;
      }
    }
    return heights;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if ((error as Error).message.startsWith("Mapterhorn answered")) throw error;
    throw new Error(`couldn't reach Mapterhorn (${(error as Error).message})`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/** The quarter (`qx`, `qy`: 0 or 1) of a tile's elevations, scaled up to a whole tile (bilinear). */
function quarter(parent: Float32Array, qx: number, qy: number): Float32Array {
  const size = TERRAIN_TILE_SIZE;
  const half = size / 2;
  const at = (x: number, y: number) => parent[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The child pixel's centre in the parent's pixels
      const px = qx * half + (x + 0.5) / 2 - 0.5;
      const py = qy * half + (y + 0.5) / 2 - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
      heights[y * size + x] =
        at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    }
  }
  return heights;
}

/**
 * A tile's elevations, from the nearest zoom at which Mapterhorn has them: the tile itself, or a
 * quarter of its parent's (and so on), scaled up. Fetches go through `fetched`, so tiles sharing a
 * parent fetch it once.
 */
async function elevationOf(tile: PlacedTile, signal: AbortSignal, fetched: Map<string, Promise<Float32Array | undefined>>): Promise<Float32Array> {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  if (!fetched.has(key)) fetched.set(key, loadElevation(tile, signal));
  const own = await fetched.get(key)!;
  if (own) return own;
  if (tile.z === 0) throw new Error("Mapterhorn has no elevations here");
  const parent = await elevationOf({ z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 }, signal, fetched);
  return quarter(parent, tile.x & 1, tile.y & 1);
}

/**
 * The tiles' elevations, in the same order, fetched a few at a time (where a zoom has none, from a
 * zoom further out, see elevationOf). Throws if any can't be fetched,
 * stopping the others, or if it isn't done by `deadline` (ms since the epoch).
 */
export async function loadElevations(tiles: PlacedTile[], deadline: number): Promise<Float32Array[]> {
  const failed = new AbortController();
  const signal = failed.signal;
  const overall = setTimeout(() => failed.abort(new Error("Mapterhorn took too long")), Math.max(0, deadline - Date.now()));
  const tooSlow = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  tooSlow.catch(() => {});
  const results: Float32Array[] = [];
  const fetched = new Map<string, Promise<Float32Array | undefined>>();
  try {
    let next = 0;
    const worker = async () => {
      while (next < tiles.length && !signal.aborted) {
        const i = next++;
        results[i] = await elevationOf(tiles[i], signal, fetched);
      }
    };
    await Promise.race([Promise.all(Array.from({ length: Math.min(CONCURRENT_TILES, tiles.length) }, worker)), tooSlow]);
  } catch (error) {
    failed.abort(error);
    throw error;
  } finally {
    clearTimeout(overall);
    failed.abort(new Error("done"));
  }
  return results;
}
