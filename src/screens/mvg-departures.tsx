// Departures from a station in Munich, from MVG: with MVG's notes ("Fährt nur bis …") and pinned
// connections. The departures screen shows departures anywhere, from Transitous.
import { DepartureBoard, isShown, parseHideRule } from "../components/departures.tsx";
import { defineScreen } from "../define-screen.ts";
import { loadConnections, loadDepartures } from "../sources/mvg.ts";
import { untilNextMinute } from "../time.ts";

const parsePin = (text: string) => {
  const [types, ...target] = text.trim().split(/\s+/);
  return target.length > 0 ? { types: types.toUpperCase().split("|").filter(Boolean), target: target.join(" ") } : undefined;
};

export default defineScreen({
  inputs: {
    // The station's name as MVG spells it
    station: { type: "string", default: "Marienplatz" },
    // Departures that are always shown: the next direct connection of a transport type to a station,
    // as "<MVG transport type> <station>"; several types separated by "|" ("SBAHN|UBAHN Ostbahnhof")
    // mean any of them. Shown in their place if they fit, otherwise pinned at the bottom under a
    // thicker line.
    pinned: { type: "list", default: ["UBAHN Hauptbahnhof", "SBAHN Ostbahnhof"] },
    // Departures left out, one rule per line, with MVG's transport types (see HideRule in
    // components/departures.tsx); later rules win. They don't take up rows, and apply to pinned
    // connections too.
    hide: { type: "list", default: ["BUS|REGIONAL_BUS", "show BUS 54", "TRAM -> Amalienburgstraße"] },
  },

  // Only black and white: the firmware then uses its fast partial refresh, without the flashing of
  // a 4-gray refresh, which matters for a screen that changes every minute.
  colors: 2,

  dependencies: {
    departures: [loadDepartures, { station: ({ inputs }) => inputs.station }],
    // One route search per pinned connection
    pins: [
      loadConnections,
      ({ inputs }) =>
        inputs.pinned
          .map(parsePin)
          .filter((pin) => pin !== undefined)
          .map((pin) => ({ station: inputs.station, target: pin.target, types: pin.types })),
    ],
  },

  prepare: ({ inputs, dependencies: { departures, pins } }) => {
    const rules = inputs.hide.map(parseHideRule).filter((rule) => rule !== undefined);
    return {
      // `departures` stays complete: pinned connections are looked up in it
      ...departures,
      shown: (departures.departures ?? []).filter((d) => isShown(rules, d)),
      // Hidden connections are skipped, so a pin shows its next connection that isn't hidden
      pins: pins.map((pin) => ({ ...pin, connections: pin.connections?.filter((c) => isShown(rules, c)) })),
    };
  },

  /** Valid until the minutes until departure change. */
  ttl: ({ now }) => untilNextMinute(now),

  view({ device, inputs, now, telemetry, data }) {
    return (
      <DepartureBoard
        title={data.station?.name ?? inputs.station}
        shown={data.shown}
        all={data.departures ?? []}
        pins={data.pins.map((pin) => pin.connections ?? [])}
        fresh={Boolean(data.departures) && !data.error}
        now={now}
        timeZone={device.timeZone}
        telemetry={telemetry}
      />
    );
  },
});
