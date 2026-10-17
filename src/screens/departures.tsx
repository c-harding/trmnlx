// Departures from a stop anywhere Transitous has data. In Munich, mvg-departures has MVG's notes
// ("Fährt nur bis …") and pinned connections.
import { DepartureBoard } from "../components/departures.tsx";
import { isShown, parseHideRule } from "../departure-rules.ts";
import { defineScreen } from "../define-screen.ts";
import { loadDepartures, TRANSITOUS_CREDITS } from "../sources/transitous.ts";
import { untilNextMinute } from "../time.ts";

export default defineScreen({
  inputs: {
    // The stop as Transitous names it (it searches, so "Innsbruck Hbf" finds Innsbruck Hauptbahnhof)
    station: { type: "string", default: "Innsbruck Hbf" },
    // Departures left out, one rule per line, with Transitous' modes ("BUS", "TRAM", "METRO" for
    // the S-Bahn, "REGIONAL_RAIL", "HIGHSPEED_RAIL", …) and "RAIL_REPLACEMENT" for replacement
    // buses (see HideRule in departure-rules.ts); later rules win. They don't take up rows.
    // By default only trains, and buses replacing them.
    hide: { type: "list", default: ["BUS|COACH", "TRAM"] },
  },

  // Only black and white, as on the other screens that change every minute
  colors: 2,

  credits: TRANSITOUS_CREDITS,

  // In the browser's lists, e.g. "departures: Innsbruck Hbf"
  label: ({ inputs }) => inputs.station,

  dependencies: {
    departures: [loadDepartures, { station: ({ inputs }) => inputs.station }],
  },

  prepare: ({ inputs, dependencies: { departures } }) => {
    const rules = inputs.hide.map(parseHideRule).filter((rule) => rule !== undefined);
    return { ...departures, shown: (departures.departures ?? []).filter((d) => isShown(rules, d)) };
  },

  /** Valid until the minutes until departure change. */
  ttl: ({ now }) => untilNextMinute(now),

  view({ device, inputs, now, telemetry, data }) {
    return (
      <DepartureBoard
        title={data.station?.name ?? inputs.station}
        shown={data.shown}
        all={data.departures ?? []}
        pins={[]}
        fresh={Boolean(data.departures) && !data.error}
        now={now}
        timeZone={device.timeZone}
        telemetry={telemetry}
      />
    );
  },
});
