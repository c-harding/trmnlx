// A contour map: the land's shape in contour lines, with its water, without roads or railways, under
// the place's name. Drawn once per place like the street map (see sources/map.ts, style "contours"):
// water from OpenStreetMap data, elevations from Mapterhorn.
import { Header, HEADER_HEIGHT_WITHOUT_RULE, PADDING_X, PADDING_Y } from "../components/header.tsx";
import { textSize } from "../components/type.ts";
import { defineScreen } from "../define-screen.ts";
import { HEIGHT, WIDTH } from "../render.ts";
import { loadMap } from "../sources/map.ts";
import { TERRAIN_ATTRIBUTION_URL } from "../sources/terrain-tiles.ts";

// As on the street map: the header without battery, clock or rule, the map edge to edge below it
const MAP_HEIGHT = HEIGHT - PADDING_Y - HEADER_HEIGHT_WITHOUT_RULE;

export default defineScreen({
  inputs: {
    // Shown above the map
    title: { type: "string", default: "Chamonix" },
    // The map's centre
    lat: { type: "number", default: 45.9237 },
    lon: { type: "number", default: 6.8694 },
    // As on web maps (and the street map): contour lines every 20 m from zoom 13.5, up to every
    // 1000 m below 8 (see contours.ts)
    zoom: { type: "number", default: 12.5 },
    // Metres between contour lines, e.g. 100 for a whole island at a zoom that would give 500; 0:
    // by the zoom. At least 5, so a typo can't ask for thousands of lines
    contours: { type: "number", default: 0 },
  },

  // In the browser's lists, e.g. "contours: Chamonix"
  label: ({ inputs }) => inputs.title,

  dependencies: {
    map: [
      loadMap,
      ({ inputs }) => ({
        lat: Math.min(85, Math.max(-85, inputs.lat)),
        lon: inputs.lon,
        zoom: Math.min(20, Math.max(1, inputs.zoom)),
        width: WIDTH,
        height: MAP_HEIGHT,
        style: "contours" as const,
        // Only when given, so maps by the zoom keep their saved files
        ...(inputs.contours > 0 && { contourInterval: Math.max(5, inputs.contours) }),
      }),
    ],
  },

  prepare: ({ dependencies: { map } }) => map,

  /** A map doesn't change (one that couldn't be drawn is tried again when its source says). */
  ttl: () => Infinity,

  // Linked in the browser, while a map is shown; on the screen, the header says the same (see below)
  credits: ({ data }) =>
    data.png
      ? [
          { text: "© OpenFreeMap", url: "https://openfreemap.org/" },
          { text: "© OpenMapTiles", url: "https://openmaptiles.org/" },
          { text: "© OpenStreetMap", url: "https://www.openstreetmap.org/copyright" },
          // Mapterhorn's sources, several under CC BY (Bavaria, Austria, Italy, …), listed there
          { text: "Elevation: Mapterhorn", url: TERRAIN_ATTRIBUTION_URL },
        ]
      : [],

  view({ inputs, data }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", width: WIDTH, height: HEIGHT, background: "#fff", fontFamily: "Noto Sans" }}>
        <div style={{ display: "flex", flexDirection: "column", padding: `${PADDING_Y}px ${PADDING_X}px 0` }}>
          <Header title={inputs.title} rule={false}>
            {/* As on the street map, with the elevations' source too: in three lines, as fit */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", alignSelf: "center", flexShrink: 0, ...textSize(12), lineHeight: 1.25 }}>
              <span>© OpenFreeMap © OpenMapTiles</span>
              <span>© OpenStreetMap</span>
              <span>Elevation: Mapterhorn</span>
            </div>
          </Header>
        </div>
        {data.png ? (
          <img src={`data:image/png;base64,${data.png.toString("base64")}`} width={WIDTH} height={MAP_HEIGHT} />
        ) : (
          <div style={{ display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "center", ...textSize(21), padding: 40, textAlign: "center" }}>
            {`Map unavailable: ${data.error}`}
          </div>
        )}
      </div>
    );
  },
});
