import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadTiles } from "../src/sources/openfreemap.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fake OpenFreeMap: its TileJSON answers; each tile as `tile` says. Counts the tile requests. */
function fakeOpenFreeMap(tile: (signal: AbortSignal) => Promise<Response>) {
  let tileRequests = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/planet")) return Response.json({ tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"] });
    tileRequests++;
    return tile(init.signal!);
  }) as typeof fetch;
  return () => tileRequests;
}

// Answers only when stopped: a server that hangs
const hanging = (signal: AbortSignal) =>
  new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

const tiles = Array.from({ length: 12 }, (_tile, i) => ({ z: 13, x: i, y: 0, left: 0, top: 0, size: 256 }));

test("a failing tile stops the others, with a message short enough for the screen", async () => {
  let first = true;
  const requests = fakeOpenFreeMap((signal) => {
    if (!first) return hanging(signal);
    first = false;
    return Promise.resolve(new Response("", { status: 404 }));
  });
  await assert.rejects(loadTiles(tiles), { message: "OpenFreeMap answered 404" });
  // Only the first few started (4 at a time); none after the failure
  assert.ok(requests() <= 4, `${requests()} tile requests`);
});

test("a server that doesn't answer gives up within a few seconds", async () => {
  fakeOpenFreeMap(hanging);
  const started = Date.now();
  await assert.rejects(loadTiles(tiles), { message: "OpenFreeMap didn't answer in time" });
  assert.ok(Date.now() - started < 6000);
});

test("a draw that waited past its deadline fetches nothing", async () => {
  const requests = fakeOpenFreeMap(hanging);
  await assert.rejects(loadTiles(tiles, Date.now() - 1), { message: "too many maps to draw at once, trying again later" });
  assert.equal(requests(), 0);
});
