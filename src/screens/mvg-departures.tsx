// Departures from a station in Munich, from MVG: with MVG's notes ("Fährt nur bis …") and pinned
// connections. The departures screen shows departures anywhere, from Transitous.
import { DepartureBoard } from "../components/departures.tsx";
import { isShown, parseHideRule, parsePin } from "../departure-rules.ts";
import { defineScreen } from "../define-screen.ts";
import { loadConnections, loadDepartures } from "../sources/mvg.ts";
import { untilNextMinute } from "../time.ts";

export default defineScreen({
  inputs: {
    // The station's name as MVG spells it
    station: { type: "string", default: "München Hbf" },
    // Departures that are always shown: the next direct connection of MVG transport types to a
    // station, as "<types> -> <station>" (see parsePin in departure-rules.ts): "UBAHN ->
    // Hauptbahnhof", "SBAHN|UBAHN -> Ostbahnhof" (either), "-> Ostbahnhof" (any). Shown in their
    // place if they fit, otherwise pinned at the bottom under a thicker line.
    pinned: { type: "list", default: [] },
    // Departures left out, one rule per line, with MVG's transport types (see HideRule in
    // departure-rules.ts); later rules win. They don't take up rows, and apply to pinned
    // connections too.
    hide: { type: "list", default: [] },
  },

  // Only black and white: the firmware then uses its fast partial refresh, without the flashing of
  // a 4-gray refresh, which matters for a screen that changes every minute.
  colors: 2,

  // A courtesy rather than a requirement: MVG publishes no terms for this (unofficial) interface
  credits: [{ text: "Data: MVG", url: "https://www.mvg.de/" }],

  // In the browser's lists, e.g. "mvg-departures: Marienplatz"
  label: ({ inputs }) => inputs.station,

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
      pins: pins.map((pin) => ({
        ...pin,
        connections: pin.connections?.filter((c) => isShown(rules, c)),
      })),
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
