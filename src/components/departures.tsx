// The parts of the departures screens (departures from Transitous, mvg-departures from MVG). Not in
// src/screens/, where every file is built as a screen.
import type { ComponentChildren } from "preact";
import type { Departure, DepartureKind } from "../departure.ts";
import { HEIGHT } from "../render.ts";
import { batteryText, type Telemetry } from "../telemetry.ts";
import { formatTime } from "../time.ts";

const ROW_HEIGHT = 44;
// A row with notes gets a second, smaller line under the destination
const NOTE_ROW_HEIGHT = 64;
// Fixed heights of everything around the rows, so the space left for rows can be calculated
const PADDING_Y = 12;
const HEADER_HEIGHT = 55; // including its bottom border
const HEADER_GAP = 4;
const ROWS_HEIGHT = HEIGHT - 2 * PADDING_Y - HEADER_HEIGHT - HEADER_GAP;
// The thicker line above pinned departures
const PINNED_RULE = 3;

// Line labels longer than this (e.g. "RJX 19977", "LUFTHANSA EXPRESS BUS") are set smaller and
// wrapped onto at most two lines, within LINE_MAX_WIDTH. Only one too long for a single line at that
// size (about 14 characters) gets a row as tall as one with notes, so the others keep the usual height.
const LONG_LINE_LENGTH = 7;
const TWO_LINE_LENGTH = 14;
const LINE_MAX_WIDTH = 180;
const isLongLine = (line: string) => line.length > LONG_LINE_LENGTH;
const rowHeight = (d: Departure) =>
  d.messages.length > 0 || d.line.length > TWO_LINE_LENGTH ? NOTE_ROW_HEIGHT : ROW_HEIGHT;

// A departure in the list and a connection from the route search are the same if they share line
// and scheduled departure
const sameDeparture = (a: Departure, b: Departure) => a.line === b.line && a.planned === b.planned;

/**
 * The departure time: "16:27" on time; the scheduled time struck through, then the expected one,
 * if delayed; just the scheduled time struck through (like the destination), if cancelled.
 */
function DepartureTime({ departure, timeZone }: { departure: Departure; timeZone: string }) {
  const planned = formatTime(new Date(departure.planned), timeZone);
  const expected = formatTime(new Date(departure.time), timeZone);
  const struck = (text: string, marginRight = 10) => (
    <span style={{ fontWeight: 400, textDecoration: "line-through", marginRight }}>{text}</span>
  );
  // A flex container rather than a fragment, which Satori can't render
  const row = (...children: ComponentChildren[]) => <div style={{ display: "flex", alignItems: "baseline" }}>{children}</div>;
  if (departure.cancelled) return row(struck(planned, 0));
  if (planned !== expected) return row(struck(planned), expected);
  return row(expected);
}

// Buses and trams are written out ("Bus 54"), other lines get a badge; S-Bahn badges have fully
// rounded ends, as on Munich's signs (see DepartureKind). The column is at least 100 px wide either way, so destinations
// line up; a rare longer line (e.g. "Bus X200") pushes only its own destination along.
const PLAIN_PREFIXES: Partial<Record<DepartureKind, string>> = { bus: "Bus", tram: "Tram" };

function LineBadge({ line, kind }: { line: string; kind: DepartureKind }) {
  const prefix = PLAIN_PREFIXES[kind];
  const long = isLongLine(line);
  // Long labels wrap (a block of inline text), cut off with "…" after two lines
  const wrapping = long
    ? {
        display: "block",
        maxWidth: LINE_MAX_WIDTH,
        boxSizing: "border-box",
        fontSize: 20,
        lineHeight: 1.15,
        lineClamp: 2,
        overflow: "hidden",
        // Break inside a word only if it doesn't fit on a line by itself ("LUFTHANSA")
        wordBreak: "break-word",
      }
    : {};
  return (
    <div style={{ display: "flex", minWidth: 100, maxWidth: LINE_MAX_WIDTH, flexShrink: 0, marginRight: 12 }}>
      {prefix ? (
        // The prefix stays beside the label, which wraps on its own in the remaining width
        <div style={{ display: "flex", alignItems: "baseline", ...(long ? { width: LINE_MAX_WIDTH } : {}) }}>
          <span style={{ fontSize: 20, marginRight: 6, flexShrink: 0 }}>{prefix}</span>
          <div style={{ display: "flex", fontWeight: 700, ...wrapping, ...(long && { flex: 1, minWidth: 0 }) }}>
            {line}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            // At least 72 px, wider for longer labels such as "RB 54"
            minWidth: 72,
            padding: "2px 8px",
            boxSizing: "border-box",
            borderRadius: kind === "s-bahn" ? 999 : 6,
            background: "#000",
            color: "#fff",
            fontWeight: 700,
            ...wrapping,
          }}
        >
          {line}
        </div>
      )}
    </div>
  );
}

const ellipsis = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;

// Digits of equal width (Inter's tabular figures), so times line up from row to row
const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

// The next two departures' times, small and stacked, in a fixed-width column so they line up
const NEXT_WIDTH = 64;

function Row({ d, next, timeZone }: { d: Departure; next: Departure[]; timeZone: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: rowHeight(d),
        borderBottom: "1px solid #000",
      }}
    >
      <LineBadge line={d.line} kind={d.kind} />
      {/* Destination and time share the rest of the row: the time takes what it needs, the
          destination shrinks (and is cut off with "…") */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", ...ellipsis, textDecoration: d.cancelled ? "line-through" : "none" }}>
          {d.destination}
        </div>
        {d.messages.length > 0 && (
          <div style={{ display: "flex", fontSize: 18, ...ellipsis }}>{d.messages.join(" · ")}</div>
        )}
      </div>
      <div style={{ display: "flex", flexShrink: 0, marginLeft: 16, fontWeight: 700, ...TABULAR }}>
        <DepartureTime departure={d} timeZone={timeZone} />
      </div>
      {/* The next two departures on the same line in the same direction, at their actual times */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          width: NEXT_WIDTH,
          flexShrink: 0,
          fontSize: 18,
          lineHeight: 1.1,
          ...TABULAR,
        }}
      >
        {next.map((n, i) => (
          <div key={i} style={{ display: "flex" }}>
            {formatTime(new Date(n.time), timeZone)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A rule for which departures are hidden, as "<types> [line] [-> <destination>]", with the source's
 * own types (MVG's "BUS", "SBAHN", …; Transitous' "BUS", "METRO", …): "BUS" hides all buses,
 * "TRAM -> Amalienburgstraße" trams going there, "BUS 54" one bus line. Several types are separated
 * by "|" ("BUS|REGIONAL_BUS"), "*" means any; line and destination are compared ignoring case.
 * "show" in front ("show BUS 54") makes it an exception that shows matching departures again; "!"
 * does too, but in YAML only quoted ("- '!BUS 54'"), since an unquoted "!" starts a YAML tag.
 */
export interface HideRule {
  show: boolean;
  types: string[] | undefined;
  line: string | undefined;
  destination: string | undefined;
}

export const parseHideRule = (text: string): HideRule | undefined => {
  const marker = /^(?:show\s+|!)/i.exec(text.trim())?.[0];
  const show = marker !== undefined;
  const [departure, ...arrow] = text.trim().slice(marker?.length ?? 0).split("->");
  const [types, line, ...extra] = departure.trim().split(/\s+/);
  const destination = arrow.join("->").trim();
  if (!types || extra.length > 0 || (arrow.length > 0 && !destination)) {
    console.error(`Ignoring hide rule ${JSON.stringify(text)}: expected "<types> [line] [-> <destination>]"`);
    return undefined;
  }
  return {
    show,
    types: types === "*" ? undefined : types.toUpperCase().split("|"),
    line,
    destination: destination || undefined,
  };
};

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const matchesRule = (rule: HideRule, d: Departure) =>
  (!rule.types || rule.types.includes(d.type)) &&
  (!rule.line || sameText(rule.line, d.line)) &&
  (!rule.destination || sameText(rule.destination, d.destination));

/** Whether a departure is shown: the last rule matching it decides, and without one it is. */
export const isShown = (rules: HideRule[], d: Departure) =>
  rules.reduce((shown, rule) => (matchesRule(rule, d) ? rule.show : shown), true);

/**
 * A departures screen: the station, battery and clock, then as many departures as fit, each with
 * the next two on its line. `shown` are the departures to list (hidden ones already left out);
 * `pins` are connections that are always shown (one list per pin, earliest first), in the list if
 * they fit, otherwise at the bottom under a thicker line; they're matched against `all` (the
 * unfiltered departures), whose real-time data takes precedence. `fresh` says whether the data is
 * current, so an empty list means "No departures" rather than "Departures unavailable".
 */
export function DepartureBoard(props: {
  title: string;
  shown: Departure[];
  all: Departure[];
  pins: Departure[][];
  fresh: boolean;
  now: Date;
  timeZone: string;
  telemetry: Telemetry | undefined;
}) {
  const { title, shown, all, pins, fresh, now, timeZone, telemetry } = props;
  // The list, without hidden departures and those that have left
  const departures = shown.filter((d) => d.time >= now.getTime() - 30_000);

  // The next two departures on the same line and direction (same lineId), among those shown;
  // `time` is the actual (real-time) departure
  const nextOf = (d: Departure) =>
    d.lineId
      ? departures.filter((other) => other.lineId === d.lineId && other.time > d.time && !other.cancelled).slice(0, 2)
      : [];

  // The pinned connections: for each target, the first of its direct connections that hasn't left.
  // A connection is replaced by its entry in the (unfiltered) departures list where there is one, as
  // the list's real-time data takes precedence: the route search can still count a train as delayed
  // that according to the list has already left.
  const pinned: Departure[] = [];
  for (const connections of pins) {
    const departure = connections
      .map((c) => all.find((d) => sameDeparture(d, c)) ?? c)
      .find((d) => d.time >= now.getTime() - 30_000 && !d.cancelled);
    if (departure && !pinned.some((p) => sameDeparture(p, departure))) pinned.push(departure);
  }
  pinned.sort((a, b) => a.time - b.time);

  // As many departures as fit (rows with notes are taller), leaving room at the bottom for pinned
  // departures that don't make it into the list. Fewer rows can push out another pinned departure,
  // so repeat until that settles.
  const fit = (height: number) => {
    const fitting: Departure[] = [];
    let used = 0;
    for (const d of departures) {
      used += rowHeight(d);
      if (used > height) break;
      fitting.push(d);
    }
    return fitting;
  };
  let rows = fit(ROWS_HEIGHT);
  let extra: Departure[] = [];
  for (let i = 0; i < pinned.length; i++) {
    const missing = pinned.filter((p) => !rows.some((d) => sameDeparture(d, p)));
    if (missing.length === extra.length) break;
    extra = missing;
    const extraHeight = PINNED_RULE + extra.reduce((sum, d) => sum + rowHeight(d), 0);
    rows = fit(ROWS_HEIGHT - extraHeight);
  }

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
        {/* A long station name is cut off with "…", leaving room for battery and clock */}
        <div style={{ display: "flex", flex: 1, minWidth: 0, marginRight: 16, fontSize: 36, fontWeight: 700, ...ellipsis }}>
          {title}
        </div>
        <div style={{ display: "flex", flexShrink: 0, alignItems: "baseline", fontSize: 20 }}>
          {`${batteryText(telemetry)} · `}
          <span style={{ fontWeight: 700, fontSize: 28, marginLeft: 6 }}>{formatTime(now, timeZone)}</span>
        </div>
      </div>

      {rows.length === 0 && extra.length === 0 ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: 32 }}>
          {/* "No departures" only on fresh data: older data that has run out says nothing about now */}
          {fresh ? "No departures" : "Departures unavailable"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          {rows.map((d, i) => (
            <Row key={i} d={d} next={nextOf(d)} timeZone={timeZone} />
          ))}
          {extra.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", borderTop: `${PINNED_RULE}px solid #000` }}>
              {extra.map((d, i) => (
                <Row key={i} d={d} next={nextOf(d)} timeZone={timeZone} />
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
