import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMapSvg,
  projection,
  tilesFor,
  tileZoom,
  worldPixel,
  type MapView,
  type PlacedTile,
  type TileFeature,
} from "../src/map-drawing.ts";

// The map screen's size: the screen's height less its padding and header
const view: MapView = { lat: 48.1374, lon: 11.5755, zoom: 14, width: 800, height: 416 };
const europe: MapView = { lat: 57.8, lon: 15, zoom: 3.19, width: 800, height: 416 };

// Web Mercator's inverse, for comparing with it: the latitude of a world pixel's row
const mercatorLat = (y: number, zoom: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (256 * 2 ** zoom)))) * 180) / Math.PI;
/** Where a place goes on a view's map in Web Mercator (as before the stereographic projection). */
function mercatorPixel(v: MapView, lat: number, lon: number) {
  const centre = worldPixel(v.lat, v.lon, v.zoom);
  const p = worldPixel(lat, lon, v.zoom);
  return { x: v.width / 2 + p.x - centre.x, y: v.height / 2 + p.y - centre.y };
}

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

test("the projection puts the view's centre in the middle of the map, and turns pixels back into places", () => {
  for (const v of [view, europe]) {
    const map = projection(v);
    const centre = map.toPixel(v.lat, v.lon);
    assert.ok(Math.abs(centre.x - v.width / 2) < 1e-9 && Math.abs(centre.y - v.height / 2) < 1e-9);
    for (const [x, y] of [
      [0, 0],
      [800, 0],
      [0, 416],
      [800, 416],
      [123, 321],
    ]) {
      const { lat, lon } = map.toLatLon(x, y);
      const back = map.toPixel(lat, lon);
      assert.ok(Math.hypot(back.x - x, back.y - y) < 1e-6, `${x}, ${y}`);
    }
  }
});

test("the projection has Web Mercator's scale at the centre, the same north–south as east–west", () => {
  for (const v of [view, europe, { ...view, lat: 69.65, lon: 18.96 }]) {
    const map = projection(v);
    const step = 1e-4;
    const north = map.toPixel(v.lat + step, v.lon).y - map.toPixel(v.lat, v.lon).y;
    const east = map.toPixel(v.lat, v.lon + step).x - map.toPixel(v.lat, v.lon).x;
    const mercatorNorth =
      worldPixel(v.lat + step, v.lon, v.zoom).y - worldPixel(v.lat, v.lon, v.zoom).y;
    const mercatorEast =
      worldPixel(v.lat, v.lon + step, v.zoom).x - worldPixel(v.lat, v.lon, v.zoom).x;
    assert.ok(
      Math.abs(north / mercatorNorth - 1) < 1e-3 && Math.abs(east / mercatorEast - 1) < 1e-3,
    );
  }
});

test("a city map is the same as in Web Mercator, to a seventh of a pixel at zoom 14", () => {
  for (const v of [
    view,
    { ...view, lat: 69.65, lon: 18.96 },
    { ...view, lat: -33.86, lon: 151.21 },
  ]) {
    const map = projection(v);
    const centre = worldPixel(v.lat, v.lon, v.zoom);
    for (const [x, y] of [
      [0, 0],
      [800, 0],
      [0, 416],
      [800, 416],
    ]) {
      // The corner's place in Web Mercator, and where the projection puts it
      const lat = mercatorLat(centre.y - v.height / 2 + y, v.zoom);
      const lon = v.lon + ((x - v.width / 2) / (256 * 2 ** v.zoom)) * 360;
      const p = map.toPixel(lat, lon);
      // At the corners: 0.11 px in Munich, 0.14 px in Tromsø, nothing at the equator
      assert.ok(
        Math.hypot(p.x - x, p.y - y) < 0.15,
        `${v.lat}: ${x}, ${y} came out at ${p.x}, ${p.y}`,
      );
    }
  }
});

test("a continent keeps its shapes: the far north isn't stretched as in Web Mercator, nor the south squashed", () => {
  const map = projection(europe);
  const northCape = map.toPixel(71.17, 25.78);
  const rome = map.toPixel(41.9, 12.5);
  // Further from the centre than Mercator puts it in the south, nearer in the north
  assert.ok(208 - northCape.y < 208 - mercatorPixel(europe, 71.17, 25.78).y);
  assert.ok(rome.y - 208 > mercatorPixel(europe, 41.9, 12.5).y - 208);
});

test("tilesFor gives a city map the same tiles as Web Mercator would", () => {
  for (const zoom of [13, 14.3, 16]) {
    const v = { ...view, zoom };
    const z = tileZoom(zoom);
    // The tiles under the view's rectangle in Web Mercator
    const size = 256 * 2 ** (zoom - z);
    const centre = worldPixel(v.lat, v.lon, zoom);
    const expected = new Set<string>();
    for (
      let ty = Math.floor((centre.y - v.height / 2) / size);
      ty <= Math.floor((centre.y + v.height / 2) / size);
      ty++
    ) {
      for (
        let tx = Math.floor((centre.x - v.width / 2) / size);
        tx <= Math.floor((centre.x + v.width / 2) / size);
        tx++
      ) {
        expected.add(`${tx}/${ty}`);
      }
    }
    const tiles = tilesFor(v);
    assert.ok(tiles.every((tile) => tile.z === z));
    assert.deepEqual(new Set(tiles.map((t) => `${t.x}/${t.y}`)), expected);
  }
});

test("tilesFor covers a continent's map, corners included", () => {
  const tiles = new Set(tilesFor(europe).map((t) => `${t.x}/${t.y}`));
  const z = tileZoom(europe.zoom);
  const map = projection(europe);
  for (const [x, y] of [
    [0, 0],
    [800, 0],
    [0, 416],
    [800, 416],
    [400, 208],
  ]) {
    const { lat, lon } = map.toLatLon(x, y);
    const p = worldPixel(lat, lon, z);
    assert.ok(tiles.has(`${Math.floor(p.x / 256)}/${Math.floor(p.y / 256)}`), `${x}, ${y}`);
  }
});

test("tilesFor wraps around the antimeridian", () => {
  const tiles = tilesFor({ lat: 0, lon: 180, zoom: 3, width: 800, height: 480 });
  const xs = new Set(tiles.map((t) => t.x));
  assert.ok(xs.has(0) && xs.has(7));
  assert.ok(tiles.every((t) => t.x >= 0 && t.x < 8));
});

test("tilesFor takes a pole's whole cap when it's in the map, but no rows beyond the world", () => {
  const tiles = tilesFor({ lat: 89, lon: 0, zoom: 2, width: 800, height: 416 });
  assert.ok(tiles.every((t) => t.y >= 0 && t.y < 4 && t.x >= 0 && t.x < 4));
  assert.deepEqual(new Set(tiles.filter((t) => t.y === 0).map((t) => t.x)), new Set([0, 1, 2, 3]));
});

// The tile under the view's centre (at zoom 14), and points in it relative to the centre (in tiles):
// the drawing tests' made-up features are near it, so they're on the map
const centre14 = worldPixel(view.lat, view.lon, 14);
const tile: PlacedTile = {
  z: 14,
  x: Math.floor(centre14.x / 256),
  y: Math.floor(centre14.y / 256),
};
const at = (dx: number, dy: number) => ({
  x: centre14.x / 256 - tile.x + dx,
  y: centre14.y / 256 - tile.y + dy,
});
const line = (
  properties: TileFeature["properties"],
  layer: TileFeature["layer"] = "transportation",
): TileFeature => ({
  layer,
  type: 2,
  properties,
  geometry: [[at(0, 0), at(0.3, 0.2)]],
});

test("buildMapSvg fills water light gray, draws railways dark gray under black roads", () => {
  const water: TileFeature = {
    layer: "water",
    type: 3,
    properties: { class: "lake" },
    geometry: [[at(0, 0), at(0.2, 0), at(0.2, 0.2)]],
  };
  const svg = buildMapSvg(view, [
    { tile, features: [water, line({ class: "primary" }), line({ class: "rail" })] },
  ]);
  // From the centre, 0.2 of a tile (51.2 px) right, then down: in Munich, Mercator and the projection
  // differ by less than the SVG's tenth of a pixel
  assert.match(
    svg,
    /<path d="M400 208L(\d+(\.\d)? \d+(\.\d)?L)*451\.2 208L(\d+(\.\d)? \d+(\.\d)?L)*451\.2 259\.\dL[^"]*Z" fill="#aaa"\/>/,
  );
  assert.match(svg, /stroke="#000" stroke-width="2.5"/);
  assert.match(svg, /stroke="#555" stroke-width="1.5"/);
  assert.ok(svg.indexOf('stroke="#555"') < svg.indexOf('stroke="#000"'));
});

test("buildMapSvg fills aprons dark gray, over water", () => {
  const area = (
    layer: TileFeature["layer"],
    properties: TileFeature["properties"],
  ): TileFeature => ({
    layer,
    type: 3,
    properties,
    geometry: [[at(0, 0), at(0.2, 0), at(0.2, 0.2)]],
  });
  const svg = buildMapSvg(view, [
    { tile, features: [area("aeroway", { class: "apron" }), area("water", { class: "lake" })] },
  ]);
  assert.ok(svg.indexOf('fill="#aaa"') < svg.indexOf('fill="#555"'));
  assert.doesNotMatch(
    buildMapSvg(view, [{ tile, features: [area("aeroway", { class: "aerodrome" })] }]),
    /fill="#555"/,
  );
});

test("buildMapSvg leaves out tunnels, ferries and what's outside the view", () => {
  const outside: TileFeature = { ...line({ class: "primary" }), geometry: [[at(2, 2), at(3, 3)]] };
  const svg = buildMapSvg(view, [
    {
      tile,
      features: [line({ class: "rail", brunnel: "tunnel" }), line({ class: "ferry" }), outside],
    },
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
  assert.doesNotMatch(
    buildMapSvg({ ...view, zoom: 16 }, [
      { tile, features: [line({ class: "river" }, "waterway")] },
    ]),
    /crispEdges/,
  );
});

test("buildMapSvg leaves out service roads closed to the public, but not streets", () => {
  const svg = (properties: TileFeature["properties"]) =>
    buildMapSvg(view, [{ tile, features: [line(properties)] }]);
  assert.doesNotMatch(svg({ class: "service", access: "no" }), /stroke=/);
  assert.match(svg({ class: "minor", access: "no" }), /stroke=/);
});

test("buildMapSvg draws runways and taxiways dark gray, about as wide as they are", () => {
  const runway = line({ class: "runway" }, "aeroway");
  // 45 m at zoom 14 in Munich: about 7 px
  assert.match(
    buildMapSvg(view, [{ tile, features: [runway] }]),
    /stroke="#555" stroke-width="7\.\d+"/,
  );
  // Never thinner than a main road
  assert.match(
    buildMapSvg({ ...view, zoom: 9 }, [{ tile, features: [runway] }]),
    /stroke="#555" stroke-width="1.5"/,
  );
  // 23 m: about half as wide
  assert.match(
    buildMapSvg(view, [{ tile, features: [line({ class: "taxiway" }, "aeroway")] }]),
    /stroke="#555" stroke-width="3\.\d+"/,
  );
  assert.doesNotMatch(
    buildMapSvg(view, [{ tile, features: [line({ class: "gate" }, "aeroway")] }]),
    /stroke=/,
  );
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
  assert.match(
    buildMapSvg(view, [{ tile, features: [line({ class: "path", subclass: "pedestrian" })] }]),
    /stroke=/,
  );
});

test("buildMapSvg adds points to long straight edges, so they curve with the map", () => {
  // A whole tile of water on a map of Europe: its edges are a tile long, so 16 points each
  const z = tileZoom(europe.zoom);
  const p = worldPixel(europe.lat, europe.lon, z);
  const sea: TileFeature = {
    layer: "water",
    type: 3,
    properties: { class: "ocean" },
    geometry: [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    ],
  };
  const svg = buildMapSvg(europe, [
    { tile: { z, x: Math.floor(p.x / 256), y: Math.floor(p.y / 256) }, features: [sea] },
  ]);
  const d = /<path d="([^"]+)" fill="#aaa"/.exec(svg)?.[1] ?? "";
  assert.equal(d.match(/[ML]/g)?.length, 64);
});

test("buildMapSvg draws a contours map's lines, without its roads and railways but with its water", () => {
  const water: TileFeature = {
    layer: "water",
    type: 3,
    properties: { class: "lake" },
    geometry: [[at(0, 0), at(0.2, 0), at(0.2, 0.2)]],
  };
  const contours = {
    z: 14,
    levels: [
      {
        level: 500,
        index: true,
        lines: [
          [
            { x: tile.x + at(0, 0).x, y: tile.y + at(0, 0).y },
            { x: tile.x + at(0.1, 0.1).x, y: tile.y + at(0.1, 0.1).y },
          ],
        ],
      },
      {
        level: 520,
        index: false,
        lines: [
          [
            { x: tile.x + at(0, 0.1).x, y: tile.y + at(0, 0.1).y },
            { x: tile.x + at(0.1, 0.2).x, y: tile.y + at(0.1, 0.2).y },
          ],
        ],
      },
    ],
  };
  const svg = buildMapSvg(
    { ...view, style: "contours" },
    [{ tile, features: [water, line({ class: "primary" }), line({ class: "rail" })] }],
    contours,
  );
  assert.match(svg, /fill="#aaa"/);
  assert.doesNotMatch(svg, /stroke-width="2.5"|stroke-width="1.5"/);
  // The index contour black, the other dark gray, both a crisp pixel wide; lines start at the centre
  assert.match(
    svg,
    /<path d="M400 208L[^"]+" fill="none" stroke="#000" stroke-width="1" stroke-linejoin="round" shape-rendering="crispEdges"\/>/,
  );
  assert.match(
    svg,
    /stroke="#555" stroke-width="1" stroke-linejoin="round" shape-rendering="crispEdges"/,
  );
  // A streets map ignores contour lines' absence, and still draws its roads
  assert.match(
    buildMapSvg(view, [{ tile, features: [line({ class: "primary" })] }]),
    /stroke-width="2.5"/,
  );
});

test("buildMapSvg draws roads dark gray like railways with grayRoads", () => {
  const features = [line({ class: "primary" })];
  assert.match(buildMapSvg(view, [{ tile, features }]), /stroke="#000"/);
  const gray = buildMapSvg({ ...view, grayRoads: true }, [{ tile, features }]);
  assert.doesNotMatch(gray, /stroke="#000"/);
  assert.match(gray, /stroke="#555"/);
});
