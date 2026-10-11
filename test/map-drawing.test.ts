import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMapSvg, tilesFor, tileZoom, worldPixel, type MapView, type PlacedTile, type TileFeature } from "../src/map-drawing.ts";

// The map screen's size: the screen's height less its padding and header
const view: MapView = { lat: 48.1374, lon: 11.5755, zoom: 14, width: 800, height: 416 };

test("worldPixel puts 0, 0 in the middle of the world and scales with the zoom", () => {
  assert.deepEqual(worldPixel(0, 0, 0), { x: 128, y: 128 });
  const half = worldPixel(48, 11, 13.5);
  const whole = worldPixel(48, 11, 14.5);
  assert.ok(Math.abs(whole.x - 2 * half.x) < 1e-6 && Math.abs(whole.y - 2 * half.y) < 1e-6);
});

test("tileZoom rounds the view's zoom up, up to 14", () => {
  assert.equal(tileZoom(14), 14);
  assert.equal(tileZoom(13.2), 14);
  assert.equal(tileZoom(17), 14);
  assert.equal(tileZoom(0.5), 1);
});

test("tilesFor covers the view exactly, also at a fractional zoom", () => {
  for (const zoom of [13, 14.3, 16]) {
    const tiles = tilesFor({ ...view, zoom });
    const size = 256 * 2 ** (zoom - tileZoom(zoom));
    assert.ok(tiles.every((tile) => tile.size === size && tile.z === tileZoom(zoom)));
    assert.ok(Math.min(...tiles.map((t) => t.left)) <= 0 && Math.max(...tiles.map((t) => t.left + size)) >= view.width);
    assert.ok(Math.min(...tiles.map((t) => t.top)) <= 0 && Math.max(...tiles.map((t) => t.top + size)) >= view.height);
    // No tile lies entirely outside
    assert.ok(tiles.every((t) => t.left < view.width && t.left + size > 0 && t.top < view.height && t.top + size > 0));
  }
});

test("tilesFor wraps around the antimeridian", () => {
  const tiles = tilesFor({ lat: 0, lon: 180, zoom: 3, width: 800, height: 480 });
  const xs = new Set(tiles.map((t) => t.x));
  assert.ok(xs.has(0) && xs.has(7));
  assert.ok(tiles.every((t) => t.x >= 0 && t.x < 8));
});

const tile: PlacedTile = { z: 14, x: 0, y: 0, left: 0, top: 0, size: 800 };
const line = (properties: TileFeature["properties"], layer: TileFeature["layer"] = "transportation"): TileFeature => ({
  layer,
  type: 2,
  properties,
  geometry: [[{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.3 }]],
});

test("buildMapSvg fills water light gray, draws railways dark gray under black roads", () => {
  const water: TileFeature = {
    layer: "water",
    type: 3,
    properties: { class: "lake" },
    geometry: [[{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0.2, y: 0.2 }]],
  };
  const svg = buildMapSvg(view, [{ tile, features: [water, line({ class: "primary" }), line({ class: "rail" })] }]);
  assert.match(svg, /<path d="M0 0L160 0L160 160Z" fill="#aaa"\/>/);
  assert.match(svg, /stroke="#000" stroke-width="2.5"/);
  assert.match(svg, /stroke="#555" stroke-width="1.5"/);
  assert.ok(svg.indexOf('stroke="#555"') < svg.indexOf('stroke="#000"'));
});

test("buildMapSvg fills aprons dark gray, over water", () => {
  const area = (layer: TileFeature["layer"], properties: TileFeature["properties"]): TileFeature => ({
    layer,
    type: 3,
    properties,
    geometry: [[{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0.2, y: 0.2 }]],
  });
  const svg = buildMapSvg(view, [{ tile, features: [area("aeroway", { class: "apron" }), area("water", { class: "lake" })] }]);
  assert.ok(svg.indexOf('fill="#aaa"') < svg.indexOf('fill="#555"'));
  assert.doesNotMatch(buildMapSvg(view, [{ tile, features: [area("aeroway", { class: "aerodrome" })] }]), /fill="#555"/);
});

test("buildMapSvg leaves out tunnels, ferries and what's outside the view", () => {
  const outside: TileFeature = { ...line({ class: "primary" }), geometry: [[{ x: 2, y: 2 }, { x: 3, y: 3 }]] };
  const svg = buildMapSvg(view, [
    { tile, features: [line({ class: "rail", brunnel: "tunnel" }), line({ class: "ferry" }), outside] },
  ]);
  assert.doesNotMatch(svg, /stroke=/);
});

test("buildMapSvg draws thin streams a pixel wide without anti-aliasing, so they don't turn dotted", () => {
  const stream = line({ class: "stream" }, "waterway");
  assert.match(
    buildMapSvg({ ...view, zoom: 13 }, [{ tile, features: [stream] }]),
    /stroke="#aaa" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" shape-rendering="crispEdges"/,
  );
  // Wide rivers stay smooth
  assert.doesNotMatch(buildMapSvg({ ...view, zoom: 16 }, [{ tile, features: [line({ class: "river" }, "waterway")] }]), /crispEdges/);
});

test("buildMapSvg leaves out service roads closed to the public, but not streets", () => {
  const svg = (properties: TileFeature["properties"]) => buildMapSvg(view, [{ tile, features: [line(properties)] }]);
  assert.doesNotMatch(svg({ class: "service", access: "no" }), /stroke=/);
  assert.match(svg({ class: "minor", access: "no" }), /stroke=/);
});

test("buildMapSvg draws runways and taxiways dark gray, about as wide as they are", () => {
  const runway = line({ class: "runway" }, "aeroway");
  // 45 m at zoom 14 in Munich: about 7 px
  assert.match(buildMapSvg(view, [{ tile, features: [runway] }]), /stroke="#555" stroke-width="7\.\d+"/);
  // Never thinner than a main road
  assert.match(buildMapSvg({ ...view, zoom: 9 }, [{ tile, features: [runway] }]), /stroke="#555" stroke-width="1.5"/);
  // 23 m: about half as wide
  assert.match(buildMapSvg(view, [{ tile, features: [line({ class: "taxiway" }, "aeroway")] }]), /stroke="#555" stroke-width="3\.\d+"/);
  assert.doesNotMatch(buildMapSvg(view, [{ tile, features: [line({ class: "gate" }, "aeroway")] }]), /stroke=/);
});

test("buildMapSvg draws service roads only from zoom 13", () => {
  const features = [line({ class: "service" })];
  assert.doesNotMatch(buildMapSvg({ ...view, zoom: 12.9 }, [{ tile, features }]), /stroke=/);
  assert.match(buildMapSvg({ ...view, zoom: 13 }, [{ tile, features }]), /stroke=/);
});

test("buildMapSvg draws footpaths only up close, but pedestrian streets always", () => {
  const features = [line({ class: "path", subclass: "footway" })];
  assert.doesNotMatch(buildMapSvg(view, [{ tile, features }]), /stroke=/);
  assert.match(buildMapSvg({ ...view, zoom: 15 }, [{ tile, features }]), /stroke=/);
  assert.match(buildMapSvg(view, [{ tile, features: [line({ class: "path", subclass: "pedestrian" })] }]), /stroke=/);
});
