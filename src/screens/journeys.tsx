import type { ComponentChildren } from "preact";
import { defineScreen } from "../define-screen.ts";
import { loadJourneys, type Journey, type JourneyLeg } from "../sources/transitous.ts";
import { batteryText } from "../telemetry.ts";
import { formatTime, untilNextMinute } from "../time.ts";

// The header as on the departures screen
const PADDING_Y = 12;
const HEADER_HEIGHT = 55; // including its bottom border
const HEADER_GAP = 4;

const ellipsis = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
// Digits of equal width (Inter's tabular figures), so times line up
const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

/** e.g. "2 h 05" or "45 min" */
function formatDuration(ms: number) {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** The expected time, after the scheduled one struck through if they differ (as on the departures screen). */
function Time({ expected, planned, timeZone }: { expected: number; planned: number; timeZone: string }) {
  const shown = formatTime(new Date(expected), timeZone);
  const scheduled = formatTime(new Date(planned), timeZone);
  // A flex container rather than a fragment, which Satori can't render
  return (
    <span style={{ display: "flex", alignItems: "baseline" }}>
      {scheduled !== shown && (
        <span style={{ fontWeight: 400, textDecoration: "line-through", marginRight: "0.3em" }}>{scheduled}</span>
      )}
      {shown}
    </span>
  );
}

/**
 * One ride: its line in bold, its departure, where it goes (unless it's the last: the destination
 * is in the title) and its arrival.
 */
function Leg({ leg, last, timeZone }: { leg: JourneyLeg; last: boolean; timeZone: string }) {
  const parts: ComponentChildren[] = [
    <span style={{ fontWeight: 700, marginRight: "0.3em" }}>{leg.line}</span>,
    <Time expected={leg.departure} planned={leg.plannedDeparture} timeZone={timeZone} />,
  ];
  parts.push(<span style={{ margin: "0 0.3em" }}>{last ? "→" : `→ ${leg.to}`}</span>);
  parts.push(<Time expected={leg.arrival} planned={leg.plannedArrival} timeZone={timeZone} />);
  return (
    <span
      style={{
        display: "flex",
        alignItems: "baseline",
        marginRight: "0.8em",
        textDecoration: leg.cancelled ? "line-through" : "none",
      }}
    >
      {parts}
    </span>
  );
}

function JourneyBlock({ journey, timeZone }: { journey: Journey; timeZone: string }) {
  const first = journey.legs[0];
  const last = journey.legs.at(-1)!;
  const changes = journey.changes === 0 ? "direct" : journey.changes === 1 ? "1 change" : `${journey.changes} changes`;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Full width and never shrunk, so one that doesn't fit wraps out of sight (see view)
        width: "100%",
        flexShrink: 0,
        boxSizing: "border-box",
        padding: "10px 0",
        borderBottom: "1px solid #000",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "baseline", fontSize: 28, fontWeight: 700, ...TABULAR }}>
          <Time expected={first.departure} planned={first.plannedDeparture} timeZone={timeZone} />
          <span style={{ margin: "0 0.3em", fontWeight: 400 }}>→</span>
          <Time expected={last.arrival} planned={last.plannedArrival} timeZone={timeZone} />
        </div>
        <div style={{ display: "flex", fontSize: 22 }}>{`${formatDuration(journey.arrival - journey.departure)} · ${changes}`}</div>
      </div>
      {/* The rides, wrapping onto a second line if needed */}
      <div style={{ display: "flex", flexWrap: "wrap", fontSize: 20, marginTop: 6, ...TABULAR }}>
        {journey.legs.map((leg, i) => (
          <Leg key={i} leg={leg} last={i === journey.legs.length - 1} timeZone={timeZone} />
        ))}
      </div>
    </div>
  );
}

export default defineScreen({
  inputs: {
    // Stops as Transitous names them (it searches, so "Innsbruck Hbf" finds Innsbruck Hauptbahnhof)
    from: { type: "string", default: "Marienplatz" },
    to: { type: "string", default: "Innsbruck Hbf" },
    // Stops the journeys must pass, in order, one per line
    via: { type: "list", default: ["Raubling"] },
    // At most this many, as many as fit: connections differ in height (rides take one or two lines)
    count: { type: "number", default: 4 },
  },

  // Only black and white, as on the departures screen: it changes every minute
  colors: 2,

  dependencies: {
    journeys: [
      loadJourneys,
      {
        from: ({ inputs }) => inputs.from,
        to: ({ inputs }) => inputs.to,
        via: ({ inputs }) => inputs.via,
      },
    ],
  },

  prepare: ({ dependencies: { journeys } }) => journeys,

  /** Valid until the clock changes. */
  ttl: ({ now }) => untilNextMinute(now),

  view({ device, inputs, now, telemetry, data }) {
    const { timeZone } = device;
    // The search is cached for a few minutes, so leave out journeys that have left since
    const journeys = (data.journeys ?? []).filter((j) => j.departure >= now.getTime() - 30_000).slice(0, inputs.count);
    const title = `${data.from ?? inputs.from} → ${data.to ?? inputs.to}`;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          padding: `${PADDING_Y}px 28px`,
          background: "#fff",
          color: "#000",
          fontFamily: "Inter",
          fontSize: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            height: HEADER_HEIGHT,
            boxSizing: "border-box",
            paddingBottom: 8,
            borderBottom: "3px solid #000",
            marginBottom: HEADER_GAP,
          }}
        >
          {/* A long title is cut off with "…", leaving room for battery and clock */}
          <div style={{ display: "flex", flex: 1, minWidth: 0, marginRight: 16, fontSize: 32, fontWeight: 700, ...ellipsis }}>
            {title}
          </div>
          <div style={{ display: "flex", flexShrink: 0, alignItems: "baseline", fontSize: 20 }}>
            {`${batteryText(telemetry)} · `}
            <span style={{ fontWeight: 700, fontSize: 28, marginLeft: 6 }}>{formatTime(now, timeZone)}</span>
          </div>
        </div>

        {journeys.length === 0 ? (
          <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: 32 }}>
            {/* "No connections" only on fresh data: older data that has run out says nothing about now */}
            {data.journeys && !data.error ? "No connections" : "Connections unavailable"}
          </div>
        ) : (
          // A column that wraps: a connection that doesn't fit below the others moves to a second
          // column, which is hidden off the right edge, so only whole connections are shown
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flexWrap: "wrap",
              alignContent: "flex-start",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {journeys.map((journey, i) => (
              <JourneyBlock key={i} journey={journey} timeZone={timeZone} />
            ))}
          </div>
        )}
      </div>
    );
  },
});
