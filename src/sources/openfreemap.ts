// Vector tiles from OpenFreeMap (openfreemap.org): OpenStreetMap data in OpenMapTiles' schema, free
// and without an API key. Its tiles' URLs name the weekly build they come from, so the current one
// is looked up first (and again once a day); tiles themselves aren't cached here, as sources/map.ts
// keeps what's drawn from them.
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { defineSource, paramsOf } from "../define-source.ts";
import type { PlacedTile, TileFeature } from "../map-drawing.ts";

const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
const TIMEOUT_MS = 15_000;
const USER_AGENT = "trmnl-server (self-hosted e-ink display)";
// Tiles fetched at once, to be polite to a free service
const CONCURRENT_TILES = 4;

const LAYERS = new Set<TileFeature["layer"]>(["water", "waterway", "transportation", "aeroway"]);

async function get(url: string, accept: string) {
  const res = await fetch(url, { headers: { Accept: accept, "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenFreeMap answered ${res.status} for ${url}`);
  return res;
}

/** The URL of the current build's tiles, with {z}, {x} and {y} to fill in. Throws if it can't be read. */
export const loadTileUrl = defineSource({
  name: "openfreemap.tiles",
  params: paramsOf<{}>(),
  async load(): Promise<string> {
    const tileJson = (await (await get(TILEJSON_URL, "application/json")).json()) as { tiles?: unknown };
    const url = Array.isArray(tileJson.tiles) ? tileJson.tiles[0] : undefined;
    if (typeof url !== "string") throw new Error("OpenFreeMap's TileJSON names no tiles");
    return url;
  },
  maxAge: 24 * 60 * 60_000,
});

/** One tile's features in the layers drawn, with points from 0 to 1 across the tile. Throws if it can't be fetched. */
async function loadTile(urlTemplate: string, { z, x, y }: PlacedTile): Promise<TileFeature[]> {
  const url = urlTemplate.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const res = await get(url, "application/x-protobuf");
  // No content: nothing there (e.g. open sea)
  const data = new Uint8Array(await res.arrayBuffer());
  if (res.status === 204 || data.length === 0) return [];
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
        geometry: feature.loadGeometry().map((ring) => ring.map((p) => ({ x: p.x / extent, y: p.y / extent }))),
      });
    }
  }
  return features;
}

/** The tiles' features, in the same order, fetched a few at a time. Throws if any can't be fetched. */
export async function loadTiles(tiles: PlacedTile[]): Promise<TileFeature[][]> {
  const urlTemplate = await loadTileUrl({});
  const results: TileFeature[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const i = next++;
      results[i] = await loadTile(urlTemplate, tiles[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_TILES, tiles.length) }, worker));
  return results;
}
