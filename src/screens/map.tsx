// A street map, like a printed one: roads in black, railways in dark gray, water in light gray,
// under the place's name. Drawn once per place from OpenStreetMap data and kept (see
// sources/map.ts), so showing it costs no more than any other screen, and it never changes by itself.
import { Header, HEADER_HEIGHT_WITHOUT_RULE } from "../components/header.tsx";
import { PADDING_Y } from "../components/journeys.tsx";
import { defineScreen } from "../define-screen.ts";
import { HEIGHT, WIDTH } from "../render.ts";
import { loadMap } from "../sources/map.ts";

// The header as on the other screens (without battery, clock or rule), with the same padding; the map
// goes edge to edge below it, from where the rule would be
const PADDING_X = 28;
const MAP_HEIGHT = HEIGHT - PADDING_Y - HEADER_HEIGHT_WITHOUT_RULE;

export default defineScreen({
  inputs: {
    // Shown above the map
    title: { type: "string", default: "München" },
    // The map's centre
    lat: { type: "number", default: 48.1374 },
    lon: { type: "number", default: 11.5755 },
    // As on web maps, fractions allowed: 14 shows about 5 km across in Munich, each step in halves that
    zoom: { type: "number", default: 12.1 },
  },

  dependencies: {
    map: [
      loadMap,
      ({ inputs }) => ({
        lat: Math.min(85, Math.max(-85, inputs.lat)),
        lon: inputs.lon,
        zoom: Math.min(20, Math.max(1, inputs.zoom)),
        width: WIDTH,
        height: MAP_HEIGHT,
      }),
    ],
  },

  prepare: ({ dependencies: { map } }) => map,

  /** A map doesn't change (one that couldn't be drawn is tried again when its source says). */
  ttl: () => Infinity,

  view({ inputs, data }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", width: WIDTH, height: HEIGHT, background: "#fff", fontFamily: "Inter" }}>
        <div style={{ display: "flex", flexDirection: "column", padding: `${PADDING_Y}px ${PADDING_X}px 0` }}>
          <Header title={inputs.title} rule={false} />
        </div>
        {data.png ? (
          <img src={`data:image/png;base64,${data.png.toString("base64")}`} width={WIDTH} height={MAP_HEIGHT} />
        ) : (
          <div style={{ display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "center", fontSize: 22, padding: 40, textAlign: "center" }}>
            {`Map unavailable: ${data.error}`}
          </div>
        )}
      </div>
    );
  },
});
