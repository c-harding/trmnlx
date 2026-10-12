// Drawing a street map from vector tiles (OpenMapTiles' schema, as OpenFreeMap serves it): which
// tiles a view needs, and the SVG of what's in them, styled like a printed street map: roads in
// black, railways and airports (runways, taxiways, aprons) in dark gray, water in light gray,
// nothing else. Kept free of fetching, so it can be tested with made-up tiles (sources/map.ts
// fetches the tiles and turns the SVG into a PNG).

/** What a map shows: its centre, its zoom (fractional, as on web maps), and its size in pixels. */
export interface MapView {
  lat: number;
  lon: number;
  zoom: number;
  width: number;
  height: number;
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

/** A tile to fetch, and where it goes on the map: its top left corner and its size in pixels. */
export interface PlacedTile {
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
  size: number;
}

// Changes when the drawing does: maps saved on disk with another version are drawn again
export const STYLE_VERSION = 8;

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

/** The tiles a view needs, each with where it goes. Tiles across the antimeridian wrap around. */
export function tilesFor(view: MapView): PlacedTile[] {
  const z = tileZoom(view.zoom);
  const count = 2 ** z;
  const size = TILE_SIZE * 2 ** (view.zoom - z);
  const centre = worldPixel(view.lat, view.lon, view.zoom);
  const left = centre.x - view.width / 2;
  const top = centre.y - view.height / 2;
  const tiles: PlacedTile[] = [];
  for (let ty = Math.max(0, Math.floor(top / size)); ty <= Math.min(count - 1, Math.floor((top + view.height) / size)); ty++) {
    for (let tx = Math.floor(left / size); tx <= Math.floor((left + view.width) / size); tx++) {
      tiles.push({ z, x: ((tx % count) + count) % count, y: ty, left: tx * size - left, top: ty * size - top, size });
    }
  }
  return tiles;
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

/** A number for the SVG: one decimal is enough at this size, and keeps it short. */
const short = (n: number) => String(Math.round(n * 10) / 10);

/**
 * The SVG of a view drawn from its tiles' features: a white background, water filled light gray,
 * rivers light gray, railways, runways and taxiways dark gray, aprons filled dark gray, roads
 * black. Lines of the same style are one path, and features outside the view are left out, so it
 * stays small however busy the map.
 */
export function buildMapSvg(view: MapView, tiles: { tile: PlacedTile; features: TileFeature[] }[]) {
  // Lines reaching this far beyond the edge are still drawn, so thick ones don't stop short
  const margin = 10;
  const water: string[] = [];
  // Airports' aprons, filled like their runways
  const aprons: string[] = [];
  const lines = new Map<string, { color: string; width: number; d: string[] }>();

  for (const { tile, features } of tiles) {
    const toPath = (points: TilePoint[], close: boolean) => {
      const xs = points.map((p) => tile.left + p.x * tile.size);
      const ys = points.map((p) => tile.top + p.y * tile.size);
      if (Math.max(...xs) < -margin || Math.min(...xs) > view.width + margin) return undefined;
      if (Math.max(...ys) < -margin || Math.min(...ys) > view.height + margin) return undefined;
      return xs.map((x, i) => `${i === 0 ? "M" : "L"}${short(x)} ${short(ys[i])}`).join("") + (close ? "Z" : "");
    };

    for (const feature of features) {
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
    water.length > 0 ? `<path d="${water.join("")}" fill="${WATER}"/>` : "",
    aprons.length > 0 ? `<path d="${aprons.join("")}" fill="${RAIL}"/>` : "",
    ...strokes,
    "</svg>",
  ].join("");
}
