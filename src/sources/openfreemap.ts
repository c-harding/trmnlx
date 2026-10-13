// Vector tiles from OpenFreeMap (openfreemap.org): OpenStreetMap data in OpenMapTiles' schema, free
// and without an API key. Its tiles' URLs name the weekly build they come from, so the current one
// is looked up first (and again once a day); tiles themselves aren't cached here, as sources/map.ts
// keeps what's drawn from them.
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { defineSource, paramsOf } from "../define-source.ts";
import type { PlacedTile, TileFeature } from "../map-drawing.ts";
import { USER_AGENT } from "../version.ts";

const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
// Per request, and for loading all of a map's tiles (the TileJSON included): well under the 15 s
// a device waits for /api/display, so it gets "Map unavailable" rather than a timeout
const REQUEST_TIMEOUT_MS = 4_000;
export const TOTAL_TIMEOUT_MS = 10_000;
// Tiles fetched at once, to be polite to a free service
const CONCURRENT_TILES = 4;

const LAYERS = new Set<TileFeature["layer"]>(["water", "waterway", "transportation", "aeroway"]);

/**
 * A response's status and body, read with `read`, or an error short enough to show on the screen (no
 * URL): the screen says "Map unavailable: …" with it. The time limit covers reading the body too.
 * `signal` stops it early, e.g. when another tile failed.
 *
 * Its own controller and timer rather than AbortSignal.timeout combined with `signal` by
 * AbortSignal.any: in Node 24, such a combined signal is never freed if `signal` aborts it before the
 * timeout fires, a few KB a time.
 */
async function get<T>(
  url: string,
  accept: string,
  read: (res: Response) => Promise<T>,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const timeout = new Error("OpenFreeMap didn't answer in time");
  const timer = setTimeout(() => controller.abort(timeout), REQUEST_TIMEOUT_MS);
  const stop = () => controller.abort(signal!.reason);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const res = await fetch(url, {
      headers: { Accept: accept, "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenFreeMap answered ${res.status}`);
    return { status: res.status, body: await read(res) };
  } catch (error) {
    // Stopped by the caller, or our time limit: that reason; otherwise what fetch says
    if (controller.signal.aborted) throw controller.signal.reason;
    if ((error as Error).message.startsWith("OpenFreeMap answered")) throw error;
    throw new Error(`couldn't reach OpenFreeMap (${(error as Error).message})`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** The URL of the current build's tiles, with {z}, {x} and {y} to fill in. Throws if it can't be read. */
export const loadTileUrl = defineSource({
  name: "openfreemap.tiles",
  params: paramsOf<{}>(),
  async load(): Promise<string> {
    const { body: tileJson } = await get(
      TILEJSON_URL,
      "application/json",
      (res) => res.json() as Promise<{ tiles?: unknown }>,
    );
    const url = Array.isArray(tileJson.tiles) ? tileJson.tiles[0] : undefined;
    if (typeof url !== "string") throw new Error("OpenFreeMap's TileJSON names no tiles");
    return url;
  },
  maxAge: 24 * 60 * 60_000,
});

/** One tile's features in the layers drawn, with points from 0 to 1 across the tile. Throws if it can't be fetched. */
async function loadTile(
  urlTemplate: string,
  { z, x, y }: PlacedTile,
  signal: AbortSignal,
): Promise<TileFeature[]> {
  const url = urlTemplate
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
  const { status, body: data } = await get(
    url,
    "application/x-protobuf",
    async (res) => new Uint8Array(await res.arrayBuffer()),
    signal,
  );
  // No content: nothing there (e.g. open sea)
  if (status === 204 || data.length === 0) return [];
  const tile = new VectorTile(new PbfReader(data));
  const features: TileFeature[] = [];
  for (const layer of LAYERS) {
    const source = tile.layers[layer];
    if (!source) continue;
    for (let i = 0; i < source.length; i++) {
      const feature = source.feature(i);
      if (feature.type !== 2 && feature.type !== 3) continue;
      const extent = feature.extent;
      features.push({
        layer,
        type: feature.type,
        properties: feature.properties,
        geometry: feature
          .loadGeometry()
          .map((ring) => ring.map((p) => ({ x: p.x / extent, y: p.y / extent }))),
      });
    }
  }
  return features;
}

/**
 * The tiles' features, in the same order, fetched a few at a time. Throws if any can't be fetched,
 * stopping the others, or if it isn't done by `deadline` (ms since the epoch; by default
 * TOTAL_TIMEOUT_MS from now).
 */
export async function loadTiles(
  tiles: PlacedTile[],
  deadline = Date.now() + TOTAL_TIMEOUT_MS,
): Promise<TileFeature[][]> {
  // E.g. after waiting behind other maps' draws (see sources/map.ts)
  if (Date.now() >= deadline) throw new Error("too many maps to draw at once, trying again later");
  // Stops everything still running: on the first failure, at the deadline, or when done. A plain
  // controller with its own timer, for the reason given at get()
  const failed = new AbortController();
  const signal = failed.signal;
  const overall = setTimeout(
    () => failed.abort(new Error("OpenFreeMap took too long")),
    deadline - Date.now(),
  );
  const tooSlow = new Promise<never>((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
  // Settled anyway when nobody waits for it any more
  tooSlow.catch(() => {});
  const results: TileFeature[][] = [];
  try {
    const urlTemplate = await Promise.race([loadTileUrl({}), tooSlow]);
    let next = 0;
    const worker = async () => {
      while (next < tiles.length && !signal.aborted) {
        const i = next++;
        results[i] = await loadTile(urlTemplate, tiles[i], signal);
      }
    };
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(CONCURRENT_TILES, tiles.length) }, worker)),
      tooSlow,
    ]);
  } catch (error) {
    // The first failure (or the overall timeout) stops the rest
    failed.abort(error);
    throw error;
  } finally {
    // Done either way: stops anything still running, and settles tooSlow
    clearTimeout(overall);
    failed.abort(new Error("done"));
  }
  return results;
}
