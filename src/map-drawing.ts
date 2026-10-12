// Drawing a street map from vector tiles (OpenMapTiles' schema, as OpenFreeMap serves it): which
// tiles a view needs, and the SVG of what's in them, styled like a printed street map: roads in
// black, railways and airports (runways, taxiways, aprons) in dark gray, water in light gray,
// nothing else. Kept free of fetching, so it can be tested with made-up tiles (sources/map.ts
// fetches the tiles and turns the SVG into a PNG).
//
// The tiles are in Web Mercator, but the map is drawn in a stereographic projection centred on the
// view, with Web Mercator's scale at the centre: a city looks the same as on a web map (at the
// corners within a seventh of a pixel at zoom 14 and about half a pixel at 12, less nearer the
// equator), while a country or continent keeps its shapes without Mercator's stretching towards the
// poles (Scandinavia its real size). North is up along the centre line.

/** What a map shows: its centre, its zoom (fractional, as on web maps), and its size in pixels. */
export interface MapView {
  lat: number;
  lon: number;
  zoom: number;
  width: number;
  height: number;
  /**
   * "streets" (the default): roads, railways, airports and water; "contours": contour lines and
   * water, from the same tiles plus elevation tiles (see sources/map.ts)
   */
  style?: "streets" | "contours";
  /** For contours: metres between lines, instead of the zoom's (see contours.ts) */
  contourInterval?: number;
}

/** A contours map's lines: each level's, in tiles at zoom `z` (unwrapped columns, so they can pass 180°). */
export interface ContourLines {
  z: number;
  levels: { level: number; index: boolean; lines: TilePoint[][] }[];
}

/** A point in a tile: 0 to 1 across it, left to right and top to bottom. */
export interface TilePoint {
  x: number;
  y: number;
}

/** What's drawn of a tile: its features in the layers used here, with OpenMapTiles' properties. */
export interface TileFeature {
  layer: "water" | "waterway" | "transportation" | "aeroway";
  /** 2 for lines, 3 for polygons (as in vector tiles) */
  type: number;
  properties: Record<string, string | number | boolean>;
  /** Lines, or a polygon's rings (outer rings clockwise, holes anticlockwise) */
  geometry: TilePoint[][];
}

/** A tile to fetch: its zoom, column and row. */
export interface PlacedTile {
  z: number;
  x: number;
  y: number;
}

// Changes when the drawing does: maps saved on disk with another version are drawn again
export const STYLE_VERSION = 10;

// Web maps' tiles are 256 px at their zoom. OpenMapTiles' are made for 512, so their detail would
// fit one zoom level further in, but it leaves out too much (e.g. most of a main station's tracks
// and all sidings below 14): so the tiles of the view's zoom, rounded up, are used. Zoom 14 is the
// most detailed OpenFreeMap has; closer views enlarge it.
const TILE_SIZE = 256;
const MAX_TILE_ZOOM = 14;

// Three of the panel's four grays (with white): drawn in this order, so roads cross over railways
// (and runways and taxiways, in the railways' gray)
const WATER = "#aaa";
const RAIL = "#555";
const INK = "#000";
const COLOR_ORDER = [WATER, RAIL, INK];

/** The tiles' zoom for a view's zoom: the one whose detail suits it. */
export const tileZoom = (zoom: number) => Math.min(MAX_TILE_ZOOM, Math.max(0, Math.ceil(zoom)));

/** A place's position on the whole world's map at a zoom, in pixels (Web Mercator). */
export function worldPixel(lat: number, lon: number, zoom: number) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

const RADIANS = Math.PI / 180;
// Web Mercator ends here: the tiles' top and bottom edges
const MAX_LAT = 85.0511287798;

/** Where places go on a view's map, in pixels from its top left, and back. */
export interface Projection {
  toPixel(lat: number, lon: number): { x: number; y: number };
  toLatLon(x: number, y: number): { lat: number; lon: number };
}

/**
 * A view's projection: stereographic, centred on the view, with as many pixels per radian at the
 * centre as Web Mercator has there at the view's zoom, so a zoom means the same scale as on web
 * maps. Conformal like Mercator (shapes kept), but without its growth towards the poles.
 */
export function projection(view: MapView): Projection {
  const sin0 = Math.sin(view.lat * RADIANS);
  const cos0 = Math.cos(view.lat * RADIANS);
  const lon0 = view.lon * RADIANS;
  const r = (TILE_SIZE * 2 ** view.zoom) / (2 * Math.PI) / cos0;
  const cx = view.width / 2;
  const cy = view.height / 2;
  return {
    toPixel(lat, lon) {
      const sin = Math.sin(lat * RADIANS);
      const cos = Math.cos(lat * RADIANS);
      const dLon = lon * RADIANS - lon0;
      const cosDLon = Math.cos(dLon);
      // 1 at the centre, growing away from it; the far side of the Earth (where it's infinite) is
      // never in a map's tiles, but kept finite anyway
      const k = 2 / Math.max(1e-9, 1 + sin0 * sin + cos0 * cos * cosDLon);
      return { x: cx + r * k * cos * Math.sin(dLon), y: cy - r * k * (cos0 * sin - sin0 * cos * cosDLon) };
    },
    toLatLon(x, y) {
      const px = (x - cx) / r;
      const py = (cy - y) / r;
      const rho = Math.hypot(px, py);
      if (rho === 0) return { lat: view.lat, lon: view.lon };
      const c = 2 * Math.atan(rho / 2);
      const sinC = Math.sin(c);
      const cosC = Math.cos(c);
      return {
        lat: Math.asin(cosC * sin0 + (py * sinC * cos0) / rho) / RADIANS,
        lon: (lon0 + Math.atan2(px * sinC, rho * cos0 * cosC - py * sin0 * sinC)) / RADIANS,
      };
    },
  };
}

/** A point in a tile as latitude and longitude (Web Mercator's inverse). */
function tileLatLon(tile: PlacedTile, point: TilePoint) {
  const count = 2 ** tile.z;
  return {
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + point.y)) / count))) / RADIANS,
    lon: ((tile.x + point.x) / count) * 360 - 180,
  };
}

// Lines reaching this far beyond the edge are still drawn, so thick ones don't stop short
const MARGIN = 10;

/**
 * The tiles a view needs: those under its border's points (every 20 px, turned back into latitude
 * and longitude: the border's image on the world encloses the rest), less those of that range that
 * don't reach the map. Columns are counted from the view's longitude, so a map across the
 * antimeridian wraps around; rows end at Web Mercator's edges, also when a pole is in the map.
 */
export function tilesFor(view: MapView): PlacedTile[] {
  const z = tileZoom(view.zoom);
  const count = 2 ** z;
  const map = projection(view);
  const border: { x: number; y: number }[] = [];
  for (let x = 0; x < view.width; x += 20) border.push({ x, y: 0 }, { x, y: view.height });
  for (let y = 0; y < view.height; y += 20) border.push({ x: 0, y }, { x: view.width, y });
  border.push({ x: view.width, y: view.height });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of border) {
    const { lat, lon } = map.toLatLon(point.x, point.y);
    // The longitude within 180° of the view's, so columns run on across the antimeridian
    const unwrapped = lon - 360 * Math.round((lon - view.lon) / 360);
    const world = worldPixel(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)), unwrapped, z);
    minX = Math.min(minX, world.x / TILE_SIZE);
    maxX = Math.max(maxX, world.x / TILE_SIZE);
    minY = Math.min(minY, world.y / TILE_SIZE);
    maxY = Math.max(maxY, world.y / TILE_SIZE);
  }
  // A pole in the map: its whole cap, all the way round
  const inMap = ({ x, y }: { x: number; y: number }) => x >= 0 && x <= view.width && y >= 0 && y <= view.height;
  const north = inMap(map.toPixel(90, view.lon));
  const south = inMap(map.toPixel(-90, view.lon));
  if (north) minY = 0;
  if (south) maxY = count;
  if (north || south) [minX, maxX] = [Math.floor(minX) - count, Math.floor(minX) + count];

  const tiles = new Map<string, PlacedTile>();
  for (let ty = Math.max(0, Math.floor(minY)); ty <= Math.min(count - 1, Math.floor(maxY)); ty++) {
    for (let tx = Math.floor(minX); tx <= Math.floor(maxX); tx++) {
      const tile = { z, x: ((tx % count) + count) % count, y: ty };
      const key = `${tile.x}/${tile.y}`;
      if (tiles.has(key)) continue;
      // Its corners and edges' middles on the map: kept if their extent reaches it
      const points = [0, 0.5, 1].flatMap((u) => [0, 0.5, 1].map((v) => tileLatLon(tile, { x: u, y: v })));
      const pixels = points.map(({ lat, lon }) => map.toPixel(lat, lon));
      const xs = pixels.map((p) => p.x);
      const ys = pixels.map((p) => p.y);
      if (Math.max(...xs) < -MARGIN || Math.min(...xs) > view.width + MARGIN) continue;
      if (Math.max(...ys) < -MARGIN || Math.min(...ys) > view.height + MARGIN) continue;
      tiles.set(key, tile);
    }
  }
  return [...tiles.values()];
}

// Runways and taxiways come as centre lines, without their width: drawn this wide in metres, as
// most at airline airports are, but at least this many pixels (a runway as wide as a main road)
const AEROWAY_WIDTHS: Record<string, { metres: number; min: number }> = {
  runway: { metres: 45, min: 1.5 },
  taxiway: { metres: 23, min: 0.75 },
};

/** Metres per pixel at a view's centre (Web Mercator). */
const metresPerPixel = (view: MapView) => (40_075_016.686 * Math.cos((view.lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** view.zoom);

/**
 * How a line is drawn, with its width in pixels, or undefined if it isn't. Tunnels are left out, as
 * on printed maps, and so are ferries, lifts, roads under construction and roads closed to the
 * public that aren't streets (e.g. an airport's or a factory's own).
 */
function lineStyle({ layer, properties }: TileFeature, view: MapView): { color: string; width: number } | undefined {
  if (properties.brunnel === "tunnel") return undefined;
  if (layer === "aeroway") {
    const size = AEROWAY_WIDTHS[String(properties.class)];
    return size && { color: RAIL, width: Math.max(size.min, size.metres / metresPerPixel(view)) };
  }
  const style = scaledLineStyle(layer, properties, view.zoom);
  return style && { ...style, width: style.width * widthScale(view.zoom) };
}

/** How a road, railway or waterway is drawn at zoom 14 (widths in pixels), or undefined if it isn't. */
function scaledLineStyle(layer: TileFeature["layer"], properties: TileFeature["properties"], zoom: number) {
  if (layer === "waterway") {
    const width = ({ river: 2, canal: 1.5, stream: 0.75 } as Record<string, number>)[String(properties.class)];
    return width ? { color: WATER, width } : undefined;
  }
  if (layer !== "transportation") return undefined;
  // Closed to the public, e.g. an airport's perimeter road: on a map of the streets, only fragments
  // that lead nowhere
  if (properties.access === "no" && ["service", "track", "path"].includes(String(properties.class))) return undefined;
  // Pedestrian streets (e.g. a city's old town) are paths in OpenMapTiles, but streets on a map
  if (properties.subclass === "pedestrian") return { color: INK, width: 0.75 };
  // Railways (trains, and transit: trams, light rail, metros above ground) dark gray. Sidings, yards
  // and crossovers thinner than running lines, so a station's tracks don't run together into one
  // band further out.
  if (properties.class === "rail" || properties.class === "transit") {
    return { color: RAIL, width: properties.service ? 0.75 : properties.class === "rail" ? 1.5 : 1 };
  }
  // What the road is: further out, OpenMapTiles files some countries' main roads under a higher class,
  // marking them with their network (e.g. Britain's trunk roads as "motorway" with "gb-trunk" at
  // zoom 5), so a network's kind counts over the class
  const network = String(properties.network ?? "");
  const kind = network.endsWith("-trunk") ? "trunk" : network.endsWith("-primary") ? "primary" : String(properties.class);
  const width = (
    {
      motorway: 3,
      // Further out (a country rather than a city), only the main roads: motorways below zoom 6, and
      // trunk roads too below 8, as the tiles there hold far more (e.g. Scotland's trunk roads at 5,
      // England's primary roads at 7)
      ...(zoom >= 6 ? { trunk: 3 } : {}),
      ...(zoom >= 8 ? { primary: 2.5, secondary: 2, tertiary: 1.5, minor: 1, busway: 1 } : {}),
      // Service roads and footpaths only closer in, where there's room for them: further out
      // they're mere specks, which turn black where they cross a railway's gray
      ...(zoom >= 13 ? { service: 0.75 } : {}),
      ...(zoom >= 15 ? { path: 0.5, track: 0.5 } : {}),
    } as Record<string, number>
  )[kind];
  return width ? { color: INK, width } : undefined;
}

// Lines get a little thicker closer in and thinner further out, but less than the map does; from
// 0.7 they stay that wide down to zoom 8, and below that (a country rather than a city) get thinner
// again, halving every 2 zoom levels, so the main roads don't cover the land
const widthScale = (zoom: number) =>
  zoom < 8 ? 0.7 * 2 ** ((zoom - 8) / 2) : Math.min(2, Math.max(0.7, 2 ** ((zoom - 14) / 2)));

// A straight line in a tile is slightly curved on the map: segments longer than this (in tiles) get
// points in between before they're projected, e.g. water cut off at a tile's edge, whose edges
// would otherwise leave seams. Roads and coastlines have points far closer together anyway.
const MAX_SEGMENT = 1 / 16;

/** The points, with more in between where they're further apart than MAX_SEGMENT. */
function densify(points: TilePoint[]): TilePoint[] {
  const result = points.slice(0, 1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const parts = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / MAX_SEGMENT);
    for (let j = 1; j < parts; j++) result.push({ x: a.x + ((b.x - a.x) * j) / parts, y: a.y + ((b.y - a.y) * j) / parts });
    result.push(b);
  }
  return result;
}

/** A number for the SVG: one decimal is enough at this size, and keeps it short. */
const short = (n: number) => String(Math.round(n * 10) / 10);

/**
 * The SVG of a view drawn from its tiles' features: a white background, water filled light gray,
 * rivers light gray, railways, runways and taxiways dark gray, aprons filled dark gray, roads
 * black. Lines of the same style are one path, and features outside the view are left out, so it
 * stays small however busy the map.
 */
export function buildMapSvg(view: MapView, tiles: { tile: PlacedTile; features: TileFeature[] }[], contourLines?: ContourLines) {
  const map = projection(view);
  // A contours map has water only, from the tiles
  const drawn = (feature: TileFeature) => view.style !== "contours" || feature.layer === "water" || feature.layer === "waterway";
  const water: string[] = [];
  // Airports' aprons, filled like their runways
  const aprons: string[] = [];
  const lines = new Map<string, { color: string; width: number; d: string[] }>();

  for (const { tile, features } of tiles) {
    const toPath = (points: TilePoint[], close: boolean) => {
      const pixels = densify(close ? [...points, points[0]] : points).map((p) => {
        const { lat, lon } = tileLatLon(tile, p);
        return map.toPixel(lat, lon);
      });
      if (close) pixels.pop();
      const xs = pixels.map((p) => p.x);
      const ys = pixels.map((p) => p.y);
      if (Math.max(...xs) < -MARGIN || Math.min(...xs) > view.width + MARGIN) return undefined;
      if (Math.max(...ys) < -MARGIN || Math.min(...ys) > view.height + MARGIN) return undefined;
      return xs.map((x, i) => `${i === 0 ? "M" : "L"}${short(x)} ${short(ys[i])}`).join("") + (close ? "Z" : "");
    };

    for (const feature of features) {
      if (!drawn(feature)) continue;
      const area =
        feature.type !== 3 ? undefined
        : feature.layer === "water" ? water
        : feature.layer === "aeroway" && feature.properties.class === "apron" ? aprons
        : undefined;
      if (area) {
        if (feature.properties.brunnel === "tunnel") continue;
        // One path for all water (and one for all aprons): holes (islands) are rings the other way
        // round, which the nonzero fill leaves empty
        for (const ring of feature.geometry) {
          const d = toPath(ring, true);
          if (d) area.push(d);
        }
        continue;
      }
      if (feature.type !== 2) continue;
      const style = lineStyle(feature, view);
      if (!style) continue;
      const { width } = style;
      const key = `${style.color} ${width}`;
      let group = lines.get(key);
      if (!group) lines.set(key, (group = { color: style.color, width, d: [] }));
      for (const line of feature.geometry) {
        const d = toPath(line, false);
        if (d) group.d.push(d);
      }
    }
  }

  // Contour lines, a pixel wide and without anti-aliasing, so they're unbroken in the display's four
  // grays: dark gray, every fifth (the index contours) black; drawn first, under the water
  const contours = { plain: [] as string[], index: [] as string[] };
  for (const { index, lines } of contourLines?.levels ?? []) {
    const origin = { z: contourLines!.z, x: 0, y: 0 };
    for (const line of lines) {
      const pixels = line.map((p) => {
        const { lat, lon } = tileLatLon(origin, p);
        return map.toPixel(lat, lon);
      });
      const xs = pixels.map((p) => p.x);
      const ys = pixels.map((p) => p.y);
      if (Math.max(...xs) < -MARGIN || Math.min(...xs) > view.width + MARGIN) continue;
      if (Math.max(...ys) < -MARGIN || Math.min(...ys) > view.height + MARGIN) continue;
      (index ? contours.index : contours.plain).push(xs.map((x, i) => `${i === 0 ? "M" : "L"}${short(x)} ${short(ys[i])}`).join(""));
    }
  }
  const contourPaths = [
    [contours.plain, RAIL],
    [contours.index, INK],
  ].flatMap(([d, color]) =>
    d.length > 0 ? [`<path d="${(d as string[]).join("")}" fill="none" stroke="${color}" stroke-width="1" stroke-linejoin="round" shape-rendering="crispEdges"/>`] : [],
  );

  // By colour (see COLOR_ORDER), then thin lines first, so major roads are drawn over the minor
  // ones they cross
  const strokes = [...lines.values()]
    .filter((group) => group.d.length > 0)
    .sort((a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) || a.width - b.width)
    .map(({ color, width, d }) => {
      // A thin light gray line, anti-aliased, would be mostly lighter pixels, which the display's
      // four grays round to white or light gray by how much of each the line covers: dotted. So
      // at least a pixel wide and without anti-aliasing, every pixel along it is light gray. (Thin
      // black lines don't need it: their lighter pixels still round to a gray.)
      const crisp = color === WATER && width < 2;
      const shown = crisp ? Math.max(1, width) : width;
      return (
        `<path d="${d.join("")}" fill="none" stroke="${color}" stroke-width="${Math.round(shown * 100) / 100}" ` +
        `stroke-linecap="round" stroke-linejoin="round"${crisp ? ' shape-rendering="crispEdges"' : ""}/>`
      );
    });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="0 0 ${view.width} ${view.height}">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    // Contour lines under the water, so a lake or the sea covers what runs into it
    ...contourPaths,
    water.length > 0 ? `<path d="${water.join("")}" fill="${WATER}"/>` : "",
    aprons.length > 0 ? `<path d="${aprons.join("")}" fill="${RAIL}"/>` : "",
    ...strokes,
    "</svg>",
  ].join("");
}
