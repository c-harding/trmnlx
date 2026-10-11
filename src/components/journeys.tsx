// Parts shared by the screens showing journeys (journeys, journey-panels). Not in src/screens/,
// where every file is built as a screen.
import type { ComponentChildren } from "preact";
import { allowedOnRoute, type Route, type Rule } from "../journey-routes.ts";
import type { Journey, JourneyLeg, JourneysResult } from "../sources/transitous.ts";
import { formatTime } from "../time.ts";
import { ellipsis } from "./header.tsx";


// Digits of equal width (Inter's tabular figures), so times line up
const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

/** Font sizes and spacing: "large" for a whole screen of journeys, "small" for a panel. */
const SIZES = {
  // `struck`: whether the departure → arrival line shows planned times struck through when they
  // differ (the rides always do); a narrow panel has no room for them
  // `direct`: the one line of a direct connection
  // `compact`: a connection with changes as one line per ride (as direct ones), so they're all short
  large: { times: 28, direct: 28, summary: 22, rides: 20, padding: 10, gap: 6, empty: 32, struck: true, compact: false },
  small: { times: 22, direct: 18, summary: 16, rides: 16, padding: 6, gap: 3, empty: 20, struck: false, compact: true },
} as const;
export type JourneySize = keyof typeof SIZES;

/** Whether another journey leaves no earlier, arrives no later and has no more changes (and isn't the same). */
const dominates = (other: Journey, journey: Journey) =>
  other !== journey &&
  other.departure >= journey.departure &&
  other.arrival <= journey.arrival &&
  other.changes <= journey.changes &&
  (other.departure > journey.departure || other.arrival < journey.arrival || other.changes < journey.changes);

/**
 * The journeys worth showing: only those the rules allow on the route (see journey-routes.ts), and
 * of those none that another one beats (leaves later or arrives earlier, with no more changes).
 * The rules come first, so a train that may not be used never hides one that may.
 */
function worthShowing(journeys: Journey[], route: Route, result: JourneysResult, rules: Rule[]) {
  const allowed = journeys.filter((journey) => allowedOnRoute(journey, route, result.stops, rules));
  return allowed.filter((journey) => !allowed.some((other) => dominates(other, journey)));
}

/** e.g. "2 h 05" or "13 mins" */
function formatDuration(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return minutes === 1 ? "1 min" : `${minutes} mins`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** The expected time, after the scheduled one struck through if they differ (as on the departures screen). */
function Time(props: { expected: number; planned: number; timeZone: string; struck?: boolean }) {
  const { expected, planned, timeZone, struck = true } = props;
  const shown = formatTime(new Date(expected), timeZone);
  const scheduled = formatTime(new Date(planned), timeZone);
  // A flex container rather than a fragment, which Satori can't render
  return (
    <span style={{ display: "flex", alignItems: "baseline" }}>
      {struck && scheduled !== shown && (
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

/**
 * One ride on one line: the line in bold, departure → arrival (planned times struck through if
 * they differ), then where to change (if given, cut off with "…" if long), and a duration on the
 * right (if given). A direct connection is one such line; a compact one is one per ride.
 */
function RideRow(props: { leg: JourneyLeg; timeZone: string; size: JourneySize; changeAt?: string; duration?: number }) {
  const { leg, timeZone, size, changeAt, duration } = props;
  const sizes = SIZES[size];
  // A row with a duration wraps when the ride's times leave no room for it: the duration moves to
  // the next line, still on the right (marginLeft: auto). A row with a station to change at has no
  // duration, and cuts the station off instead.
  const wraps = duration !== undefined;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: wraps ? "wrap" : "nowrap",
        alignItems: "baseline",
        justifyContent: "space-between",
        fontSize: sizes.direct,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", ...(wraps ? { flexShrink: 0 } : { minWidth: 0 }), ...TABULAR }}>
        <span style={{ fontWeight: 700, marginRight: "0.4em", flexShrink: 0, textDecoration: leg.cancelled ? "line-through" : "none" }}>
          {leg.line}
        </span>
        <span style={{ display: "flex", alignItems: "baseline", flexShrink: 0 }}>
          <Time expected={leg.departure} planned={leg.plannedDeparture} timeZone={timeZone} />
          <span style={{ margin: "0 0.3em" }}>→</span>
          <Time expected={leg.arrival} planned={leg.plannedArrival} timeZone={timeZone} />
        </span>
        {changeAt && <div style={{ display: "flex", minWidth: 0, marginLeft: "0.4em", ...ellipsis }}>{changeAt}</div>}
      </div>
      {duration !== undefined && (
        <div style={{ display: "flex", flexShrink: 0, marginLeft: "auto", paddingLeft: 8, whiteSpace: "nowrap", fontSize: sizes.summary }}>
          {formatDuration(duration)}
        </div>
      )}
    </div>
  );
}

/**
 * One connection: departure → arrival, duration and changes, then its rides; a direct one on one
 * line, and in compact sizes one line per ride.
 */
function JourneyBlock({ journey, timeZone, size }: { journey: Journey; timeZone: string; size: JourneySize }) {
  const sizes = SIZES[size];
  const first = journey.legs[0];
  const last = journey.legs.at(-1)!;
  const changes = journey.changes === 1 ? "1 change" : `${journey.changes} changes`;
  const block = {
    display: "flex",
    flexDirection: "column",
    // Full width and never shrunk, so one that doesn't fit wraps out of sight (see JourneyList)
    width: "100%",
    flexShrink: 0,
    boxSizing: "border-box",
    padding: `${sizes.padding}px 0`,
    borderBottom: "1px solid #000",
  } as const;
  // Direct, or compact: one line per ride, the duration on the last
  if (journey.legs.length === 1 || sizes.compact) {
    return (
      <div style={block}>
        {journey.legs.map((leg, i) => {
          const lastRide = i === journey.legs.length - 1;
          return (
            <RideRow
              key={i}
              leg={leg}
              timeZone={timeZone}
              size={size}
              changeAt={lastRide ? undefined : leg.to}
              duration={lastRide ? journey.arrival - journey.departure : undefined}
            />
          );
        })}
      </div>
    );
  }
  return (
    <div style={block}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "baseline", fontSize: sizes.times, fontWeight: 700, ...TABULAR }}>
          <Time expected={first.departure} planned={first.plannedDeparture} timeZone={timeZone} struck={sizes.struck} />
          <span style={{ margin: "0 0.3em", fontWeight: 400 }}>→</span>
          <Time expected={last.arrival} planned={last.plannedArrival} timeZone={timeZone} struck={sizes.struck} />
        </div>
        <div style={{ display: "flex", flexShrink: 0, marginLeft: 8, whiteSpace: "nowrap", fontSize: sizes.summary }}>
          {`${formatDuration(journey.arrival - journey.departure)} · ${changes}`}
        </div>
      </div>
      {/* The rides, wrapping onto further lines if needed */}
      <div style={{ display: "flex", flexWrap: "wrap", fontSize: sizes.rides, marginTop: sizes.gap, ...TABULAR }}>
        {journey.legs.map((leg, i) => (
          <Leg key={i} leg={leg} last={i === journey.legs.length - 1} timeZone={timeZone} />
        ))}
      </div>
    </div>
  );
}

/**
 * As many of the next `count` connections as fit, in the space it's given (flex: 1). Connections
 * differ in height, so this is a column that wraps: one that doesn't fit below the others moves to
 * a second column, which is hidden off the right edge, so only whole connections are shown.
 */
export function JourneyList(props: {
  route: Route;
  /** The screen's rules, applied on every stretch before the route's own */
  rules: Rule[];
  result: JourneysResult;
  now: Date;
  count: number;
  timeZone: string;
  size: JourneySize;
}) {
  const { route, rules, result, now, count, timeZone, size } = props;
  // The search is cached for a few minutes, so leave out journeys that have left since
  const upcoming = (result.journeys ?? []).filter((j) => j.departure >= now.getTime() - 30_000);
  const journeys = worthShowing(upcoming, route, result, rules).slice(0, count);
  if (journeys.length === 0) {
    return (
      <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: SIZES[size].empty }}>
        {/* "No connections" only on fresh data: older data that has run out says nothing about now */}
        {result.journeys && !result.error ? "No connections" : "Connections unavailable"}
      </div>
    );
  }
  return (
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
        <JourneyBlock key={i} journey={journey} timeZone={timeZone} size={size} />
      ))}
    </div>
  );
}
