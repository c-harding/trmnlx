import { departuresFor, nextDirectFor } from "../data/mvg.js";
import { HEIGHT } from "../render.js";
import { batteryText } from "./placeholder.jsx";
import { formatTime, untilNextMinute } from "../time.js";

// Only black and white: the firmware then uses its fast partial refresh, without the flashing of
// a 4-gray refresh, which matters for a screen that changes every minute.
export const colors = 2;

const ROW_HEIGHT = 44;
// A row with notes gets a second, smaller line under the destination
const NOTE_ROW_HEIGHT = 64;
// Fixed heights of everything around the rows, so the space left for rows can be calculated
const PADDING_Y = 12;
const HEADER_HEIGHT = 55; // including its bottom border
const HEADER_GAP = 4;
const FOOTER_HEIGHT = 30; // the "As of" line, including the gap above it
const rowsHeight = (footer) => HEIGHT - 2 * PADDING_Y - HEADER_HEIGHT - HEADER_GAP - (footer ? FOOTER_HEIGHT : 0);
// The thicker line above pinned departures
const PINNED_RULE = 3;

// Line labels longer than this (e.g. "LUFTHANSA EXPRESS BUS") are set smaller and wrapped onto at
// most two lines, within LINE_MAX_WIDTH; their row is as tall as one with notes
const LONG_LINE_LENGTH = 7;
const LINE_MAX_WIDTH = 180;
const isLongLine = (line) => line.length > LONG_LINE_LENGTH;
const rowHeight = (d) => (d.messages.length > 0 || isLongLine(d.line) ? NOTE_ROW_HEIGHT : ROW_HEIGHT);

export const inputs = {
  // The station's name as MVG spells it
  station: { type: "string", default: "Marienplatz" },
  // Departures that are always shown: the next direct connection of a transport type to a station,
  // as "<MVG transport type> <station>"; several types separated by "|" ("SBAHN|UBAHN Ostbahnhof")
  // mean any of them. Shown in their place if they fit, otherwise pinned at the bottom under a
  // thicker line.
  pinned: { type: "list", default: ["UBAHN Hauptbahnhof", "SBAHN Ostbahnhof"] },
};

const parsePin = (text) => {
  const [types, ...target] = text.trim().split(/\s+/);
  return target.length > 0 ? { types: types.toUpperCase().split("|").filter(Boolean), target: target.join(" ") } : undefined;
};

export async function load({ inputs }) {
  const pins = inputs.pinned.map(parsePin).filter(Boolean);
  const [departures, ...connections] = await Promise.all([
    departuresFor(inputs.station),
    ...pins.map((pin) => nextDirectFor(inputs.station, pin.target, pin.types)),
  ]);
  return { ...departures, pins: connections };
}

// A departure in the list and a connection from the route search are the same if they share line
// and scheduled departure
const sameDeparture = (a, b) => a.line === b.line && a.planned === b.planned;

/** Valid until the minutes until departure change. */
export const ttl = ({ now }) => untilNextMinute(now);

/**
 * The departure time: "16:27" on time; the scheduled time struck through, then the expected one,
 * if delayed; just the scheduled time struck through (like the destination), if cancelled.
 */
function DepartureTime({ departure, timeZone }) {
  const planned = formatTime(new Date(departure.planned), timeZone);
  const expected = formatTime(new Date(departure.time), timeZone);
  const struck = (text, marginRight = 10) => (
    <span style={{ fontWeight: 400, textDecoration: "line-through", marginRight }}>{text}</span>
  );
  // A flex container rather than a fragment, which Satori can't render
  const row = (...children) => <div style={{ display: "flex", alignItems: "baseline" }}>{children}</div>;
  if (departure.cancelled) return row(struck(planned, 0));
  if (planned !== expected) return row(struck(planned), expected);
  return row(expected);
}

// Buses and trams are written out ("Bus 54"), other lines get a badge; S-Bahn badges have fully
// rounded ends, as on Munich's signs. The column is at least 100 px wide either way, so destinations
// line up; a rare longer line (e.g. "Bus X200") pushes only its own destination along.
const PLAIN_PREFIXES = { BUS: "Bus", REGIONAL_BUS: "Bus", TRAM: "Tram" };

function LineBadge({ line, type }) {
  const prefix = PLAIN_PREFIXES[type];
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
            borderRadius: type === "SBAHN" ? 999 : 6,
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

const ellipsis = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };

// Digits of equal width (Inter's tabular figures), so times line up from row to row
const TABULAR = { fontVariantNumeric: "tabular-nums" };

// The next two departures' times, small and stacked, in a fixed-width column so they line up
const NEXT_WIDTH = 64;

function Row({ d, next, timeZone }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: rowHeight(d),
        borderBottom: "1px solid #000",
      }}
    >
      <LineBadge line={d.line} type={d.type} />
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

export function view({ inputs, now, timeZone, telemetry, data }) {
  const departures = (data?.departures ?? []).filter((d) => d.time >= now.getTime() - 30_000);
  // Only shown when the latest fetch failed and the list is older
  const footer = data?.error && data?.fetchedAt ? `As of ${formatTime(new Date(data.fetchedAt), timeZone)}` : "";

  // The next two departures on the same line and direction (same lineId), from the full list;
  // `time` is the actual (real-time) departure
  const nextOf = (d) =>
    d.lineId
      ? departures.filter((other) => other.lineId === d.lineId && other.time > d.time && !other.cancelled).slice(0, 2)
      : [];

  // The pinned connections: for each target, the first of its direct connections that hasn't left.
  // A connection is replaced by its entry in the (unfiltered) departures list where there is one, as
  // the list's real-time data takes precedence: the route search can still count a train as delayed
  // that according to the list has already left.
  const allDepartures = data?.departures ?? [];
  const pinned = [];
  for (const { connections = [] } of data?.pins ?? []) {
    const departure = connections
      .map((c) => allDepartures.find((d) => sameDeparture(d, c)) ?? c)
      .find((d) => d.time >= now.getTime() - 30_000 && !d.cancelled);
    if (departure && !pinned.some((p) => sameDeparture(p, departure))) pinned.push(departure);
  }
  pinned.sort((a, b) => a.time - b.time);

  // As many departures as fit (rows with notes are taller), leaving room at the bottom for pinned
  // departures that don't make it into the list. Fewer rows can push out another pinned departure,
  // so repeat until that settles.
  const fit = (height) => {
    const fitting = [];
    let used = 0;
    for (const d of departures) {
      used += rowHeight(d);
      if (used > height) break;
      fitting.push(d);
    }
    return fitting;
  };
  let rows = fit(rowsHeight(footer));
  let extra = [];
  for (let i = 0; i < pinned.length; i++) {
    const missing = pinned.filter((p) => !rows.some((d) => sameDeparture(d, p)));
    if (missing.length === extra.length) break;
    extra = missing;
    const extraHeight = PINNED_RULE + extra.reduce((sum, d) => sum + rowHeight(d), 0);
    rows = fit(rowsHeight(footer) - extraHeight);
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
          {data?.station?.name ?? inputs.station}
        </div>
        <div style={{ display: "flex", flexShrink: 0, alignItems: "baseline", fontSize: 20 }}>
          {`${batteryText(telemetry)} · `}
          <span style={{ fontWeight: 700, fontSize: 28, marginLeft: 6 }}>{formatTime(now, timeZone)}</span>
        </div>
      </div>

      {rows.length === 0 && extra.length === 0 ? (
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: 32 }}>
          {/* "No departures" only on fresh data: an empty stale list just means it has run out */}
          {data?.departures && !data.error ? "No departures" : "Departures unavailable"}
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

      {footer && (
        <div style={{ display: "flex", height: FOOTER_HEIGHT - 6, marginTop: 6, fontSize: 20, ...ellipsis }}>{footer}</div>
      )}
    </div>
  );
}
