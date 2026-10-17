// Your latest Strava activity that isn't private: its name, sport, when, kudos, its route on a map,
// stats (distance, time, pace or speed, ascent) and a QR code of its page on Strava. Needs the device's account connected to Strava: until then, the
// browser's preview has a "Connect Strava" link (see sources/strava.ts).
import type { ComponentChildren } from "preact";
import {
  Battery,
  ellipsis,
  Header,
  HEADER_GAP,
  HEADER_HEIGHT,
  PADDING_X,
  PADDING_Y,
} from "../components/header.tsx";
import { QrCode, qrSize } from "../components/qr-code.tsx";
import { POWERED_BY_STRAVA, POWERED_BY_STRAVA_RATIO } from "../components/strava-logo.ts";
import { textSize } from "../components/type.ts";
import { defineScreen } from "../define-screen.ts";
import { projection } from "../map-drawing.ts";
import { HEIGHT, textWidth, WIDTH } from "../render.ts";
import {
  type Activity,
  depthFor,
  loadStravaActivity,
  loadStravaProfile,
  loadStravaRoute,
  prominence,
  type Profile,
  stravaConnection,
  type RouteMap,
} from "../sources/strava.ts";

// Activities refresh every 15 minutes (see sources/strava.ts); the screen with them
const TTL_SECONDS = 15 * 60;
// Until connected: soon again, so a device shows the activity soon after connecting (rendering this
// asks Strava nothing)
const NOT_CONNECTED_TTL_SECONDS = 60;

// Strava's "Powered by Strava" logo in the header, this high
const LOGO_HEIGHT = 30;
// Under the header: the route map on the left; on the right the sport, start and kudos, the stats
// and the QR code
const COLUMN_GAP = 20;
const MAP_WIDTH = Math.round((WIDTH - 2 * PADDING_X - COLUMN_GAP) / 2);
const MAP_HEIGHT = HEIGHT - 2 * PADDING_Y - HEADER_HEIGHT - HEADER_GAP - 8;
// The elevation profile, left of the QR code (about 120 px wide with "View on Strava" over it),
// as high as the two (see ProfileChart)
const PROFILE_WIDTH = WIDTH - 2 * PADDING_X - COLUMN_GAP - MAP_WIDTH - 120 - 16;
// "View on Strava" over the QR code, this high; the code's modules this many pixels
const VIEW_ROW = 20;
const QR_MODULE = 3;
/** An activity's page on Strava, which the QR code links to. */
const activityUrl = (activity: Activity) => `https://www.strava.com/activities/${activity.id}`;
// Its labels: a line of the 12 px pixel font this high
const SUMMIT_ROW = 14;

// Under it, its lowest height (e.g. "2,207 m"), this wide
const LOW_LABEL = 60;
// Room above a summit for its tick
const TICK_ROOM = 10;
// Between a label right above its summit and its tick, for descenders ("Bony de la Pica")
const TICK_GAP = 3;
// Between a tick's end and its summit
const TICK_END = 4;
// A tick hanging from a label whose summit's tick can't reach it, at most this long
const HANG = 4;
// Labels can reach this far past either side of the chart, into the space beside it: enough for one
// ending at a summit on the chart's last column (its box 5 px past it, its last letter's ink 3)
const LABEL_OVERFLOW = 5;
/**
 * Where a summit at `x` across has its tick: the middle of the pixel column it's in, so the tick
 * and its dots are one pixel wide, the same one (and a summit at either end has its tick on the
 * chart).
 */
const tickAt = (x: number) => Math.min(Math.floor(x), PROFILE_WIDTH - 1) + 0.5;
// Rows of labels above the chart have this much space under each (before the next, or the chart,
// whose top line can have labels too), for such a tick under a label
const ROW_GAP = 5;
const ROW_STEP = SUMMIT_ROW + ROW_GAP;
// Rows of labels above the chart at most: each one makes it lower
const MAX_ROWS = 3;
// How far below the chart's top a label in it can start: with the most rows, at least a row's
// height, so it isn't a row more on top of them
const chartTopFloor = (rows: number) => (rows === MAX_ROWS ? ROW_STEP : 0);
/** How high `rows` rows of labels are, with the space under each. */
const rowsHeightOf = (rows: number) => rows * ROW_STEP;

// Shown as a pace per km (or per 100 m when swimming) rather than a speed
const PACED = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);

// Sport types not named well by splitting their words: too long next to the kudos, or spelt
// otherwise
const SPORT_NAMES: Record<string, string> = {
  HighIntensityIntervalTraining: "HIIT",
  EMountainBikeRide: "E-MTB",
  MountainBikeRide: "MTB",
  EBikeRide: "E-bike ride",
  StandUpPaddling: "Stand-up paddling",
  Crossfit: "CrossFit",
};

/** A sport type as words: "TrailRun" → "Trail run", or its name in SPORT_NAMES. */
const sportName = (type: string) =>
  SPORT_NAMES[type] ??
  type.replace(/(?<=[a-z])(?=[A-Z])/g, " ").replace(/ \w/g, (s) => s.toLowerCase());

/** A duration as "1:02:15" or "48:07". */
function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Pace or speed, with its unit. */
function pace(activity: Activity): [string, string] {
  const { distance, movingTime, sportType } = activity;
  if (distance <= 0 || movingTime <= 0) return ["–", ""];
  if (sportType === "Swim") return [duration((movingTime / distance) * 100), "/100 m"];
  if (PACED.has(sportType)) return [duration((movingTime / distance) * 1000), "/km"];
  return [((distance / movingTime) * 3.6).toFixed(1), "km/h"];
}

/** A stat: its value large, with its unit, and what it is under it. */
// Kilometres to two decimals below 10 (9.99 at most: from 9,995 m it would round to 10.00), else one
const kilometres = (metres: number) => (metres / 1000).toFixed(metres < 9995 ? 2 : 1);

const Stat = (props: { value: string; unit: string; label: string }) => (
  <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
    <div style={{ display: "flex", alignItems: "baseline" }}>
      <span style={{ ...textSize(36), fontWeight: 700 }}>{props.value}</span>
      {props.unit && <span style={{ ...textSize(21), marginLeft: 4 }}>{props.unit}</span>}
    </div>
    <span style={{ ...textSize(16), color: "#555" }}>{props.label}</span>
  </div>
);

/** A thumbs-up, for kudos: a raised thumb on a fist, beside its cuff. */
const ThumbsUp = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <rect x={1.5} y={10} width={4} height={11.5} rx={1} fill="#000" />
    <path
      d="M7.5 21.5H17Q18.8 21.5 19.4 19.8L21.6 13Q22.3 10.5 19.8 10.5H14.6L15.4 5.6Q15.6 3 13.6 2.3L7.5 10.2Z"
      fill="#000"
    />
  </svg>
);

/**
 * The route on its map: the line black with a white edge, so it stands out from the roads, a ring
 * where it starts and a dot where it ends. Or why there's none (e.g. indoors).
 */
function RouteMapView({ route }: { route: RouteMap | undefined }) {
  const box = {
    display: "flex",
    position: "relative",
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
  } as const;
  if (!route?.map.png) {
    // Framed, as there's no map to show where the space is
    return (
      <div
        style={{
          ...box,
          alignItems: "center",
          justifyContent: "center",
          border: "2px solid #000",
          boxSizing: "border-box",
          ...textSize(16),
        }}
      >
        {route ? `Map unavailable: ${route.map.error}` : "No route"}
      </div>
    );
  }
  const { toPixel } = projection(route.view);
  const pixels = route.points.map(([lat, lon]) => toPixel(lat, lon));
  const line = pixels
    .map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`)
    .join(" ");
  const [start, end] = [pixels[0], pixels[pixels.length - 1]];
  return (
    <div style={box}>
      <img
        src={`data:image/png;base64,${route.map.png.toString("base64")}`}
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        style={{ position: "absolute", left: 0, top: 0 }}
      />
      <svg
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        style={{ position: "absolute", left: 0, top: 0 }}
      >
        <polyline
          points={line}
          fill="none"
          stroke="#fff"
          strokeWidth={9}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polyline
          points={line}
          fill="none"
          stroke="#000"
          strokeWidth={4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={end.x} cy={end.y} r={6} fill="#000" stroke="#fff" strokeWidth={2.5} />
        <circle cx={start.x} cy={start.y} r={6} fill="#fff" stroke="#000" strokeWidth={3} />
      </svg>
    </div>
  );
}

/**
 * A summit's label, its name and `height`, as wide as the chart at most (reaching LABEL_OVERFLOW
 * past it either side): the name cut short, at a whole character, with "…" if needed.
 */
function fitName(name: string, height: string) {
  const fits = (text: string) =>
    textWidth(text, "TRMNL12", 12) <= PROFILE_WIDTH + 2 * LABEL_OVERFLOW;
  if (fits(`${name} ${height}`)) return `${name} ${height}`;
  const chars = [...name];
  for (let n = chars.length - 1; n > 0; n--) {
    const text = `${chars.slice(0, n).join("").trimEnd()}… ${height}`;
    if (fits(text)) return text;
  }
  return height;
}

/**
 * An activity's heights along its distance: a black line over a light gray fill, its lowest height
 * below its lowest point, and its named summits (see summitIndices) with their height, and its
 * highest point's height even if it isn't named, each with a short tick above it. The labels are
 * placed by layoutLabels: in the chart where they fit, otherwise on as few rows above it as needed
 * (at most MAX_ROWS), leaving out the least prominent summits' names until they fit.
 */
function ProfileChart({ profile, height }: { profile: Profile; height: number }) {
  const { distance, altitude } = profile;
  const highest = Math.max(...altitude);
  const lowest = Math.min(...altitude);
  const length = distance[distance.length - 1] || 1;
  const x = (d: number) => (d / length) * PROFILE_WIDTH;
  const metres = (value: number) => `${Math.round(value).toLocaleString("en-GB")} m`;
  const lowAt = x(distance[altitude.indexOf(lowest)]);
  // The named summits, and the highest point even if it isn't named, from the lowest up: lower
  // ones have room above them, the highest has the chart's top
  const summits = profile.summits
    .filter(({ index, name }) => name !== undefined || altitude[index] === highest)
    .sort((a, b) => altitude[a.index] - altitude[b.index]);
  // Their labels, with the names of those in `nameless` left out, and a name too long for the
  // chart cut short ("…") before the height
  const labelsOf = (nameless: number[]) =>
    summits.map(({ index, name }) => {
      const height = metres(altitude[index]);
      const text = name && !nameless.includes(index) ? fitName(name, height) : height;
      const width = Math.ceil(textWidth(text, "TRMNL12", 12));
      return { index, text, width, at: tickAt(x(distance[index])) };
    });
  // The named summits, the least prominent (then the lowest) first: the first to lose their names
  const byProminence = summits
    .filter(({ name }) => name !== undefined)
    .map(({ index }) => ({ index, prominence: prominence(altitude, index) }))
    .sort((a, b) => a.prominence - b.prominence || altitude[a.index] - altitude[b.index])
    .map(({ index }) => index);

  // With `rows` rows of labels above it: the plot's height, and its points' heights in it (its
  // highest point below room for its tick, and `labelRoom` px more for labels in the chart)
  const geometry = (rows: number, labelRoom: number) => {
    const rowsHeight = rowsHeightOf(rows);
    const plotHeight = height - SUMMIT_ROW - rowsHeight;
    const top = labelRoom + TICK_ROOM;
    const y = (a: number) =>
      highest === lowest
        ? plotHeight / 2
        : top + ((highest - a) / (highest - lowest)) * (plotHeight - top - 2);
    return {
      rowsHeight,
      plotHeight,
      y,
      points: distance.map((d, i) => ({ x: x(d), y: y(altitude[i]) })),
    };
  };
  type Label = ReturnType<typeof labelsOf>[number];
  const layout = (summits: Label[], rows: number, clearTicks: boolean, labelRoom: number) => {
    const g = geometry(rows, labelRoom);
    const labels = layoutLabels(
      summits.map((summit) => ({ ...summit, tickTop: g.y(altitude[summit.index]) - TICK_ROOM })),
      g.points,
      rows,
      clearTicks,
    );
    return labels && { ...g, labels };
  };
  // With room for labels at the chart's top, only as much as they use: shrunk by what's left above
  // the highest label in the chart, below where it can start (all of it if there's none), and laid
  // out again, which moves
  // them up with the land, while that works
  const fitted = (summits: Label[], rows: number, clearTicks: boolean, labelRoom: number) => {
    let best = layout(summits, rows, clearTicks, labelRoom);
    while (best) {
      const { labels, rowsHeight } = best;
      const unused = Math.floor(
        Math.min(
          labelRoom,
          ...labels
            .map(({ box }) => box.top - rowsHeight - chartTopFloor(rows))
            .filter((unused) => unused >= 0),
        ),
      );
      if (unused < 1) break;
      labelRoom -= unused;
      const next = layout(summits, rows, clearTicks, labelRoom);
      if (!next) break;
      best = next;
    }
    return best;
  };
  // The first that works of: as few rows as do (with rows, the chart keeping room at its top for
  // a label, then not), each label centred over its summit where it fits, otherwise starting or
  // ending at it, and with each tick reaching its label where any such layout does; with all
  // names, then without the least prominent summit's, and so on; then all on two rows,
  // alternating, without names, which always does (see layoutLabels)
  const attempts = Array.from({ length: MAX_ROWS + 1 }, (_, rows) =>
    [true, false].flatMap((clearTicks) =>
      (rows === 0 ? [true] : [true, false]).map((labelRoom) => ({ rows, clearTicks, labelRoom })),
    ),
  ).flat();
  const chosen = (() => {
    for (let k = 0; k <= byProminence.length; k++) {
      const labels = labelsOf(byProminence.slice(0, k));
      for (const { rows, clearTicks, labelRoom } of attempts) {
        const result = fitted(labels, rows, clearTicks, labelRoom ? SUMMIT_ROW + TICK_GAP : 0);
        if (result) return result;
      }
    }
  })();
  const { rowsHeight, plotHeight, y, points, labels } = chosen ?? {
    ...geometry(2, 0),
    labels: alternatingRows(labelsOf(byProminence), altitude),
  };
  const line = points.map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`);

  return (
    <div style={{ display: "flex", flexDirection: "column", ...textSize(12) }}>
      <div style={{ display: "flex", position: "relative", height: rowsHeight + plotHeight }}>
        <svg
          width={PROFILE_WIDTH}
          height={plotHeight}
          viewBox={`0 0 ${PROFILE_WIDTH} ${plotHeight}`}
          style={{ position: "absolute", left: 0, top: rowsHeight }}
        >
          <polygon
            points={[`0,${plotHeight}`, ...line, `${PROFILE_WIDTH},${plotHeight}`].join(" ")}
            fill="#aaa"
          />
          <polyline
            points={line.join(" ")}
            fill="none"
            stroke="#000"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        </svg>
        {/* Each summit's tick, ending TICK_END above it: up to just below its label where no
            other label is in between; otherwise short (a line from the top would look like part of
            the profile, e.g. a wall at a summit at the end), fading upwards in two dots, with a
            short tick hanging from its label. Over the rows too, so not in the chart's svg */}
        <svg
          width={PROFILE_WIDTH}
          height={rowsHeight + plotHeight}
          viewBox={`0 0 ${PROFILE_WIDTH} ${rowsHeight + plotHeight}`}
          style={{ position: "absolute", left: 0, top: 0 }}
        >
          {summits.map(({ index }) => {
            const at = tickAt(x(distance[index]));
            const bottom = rowsHeight + y(altitude[index]) - TICK_END;
            const short = rowsHeight + y(altitude[index]) - TICK_ROOM + 1;
            const label = labels.find((label) => label.index === index);
            const long = label && label.box.top + SUMMIT_ROW + TICK_GAP;
            // The labels in the way of a tick up to its label
            const blocking = labels.filter(
              (other) =>
                long !== undefined &&
                other !== label &&
                at >= other.box.left - 1 &&
                at <= other.box.left + other.width + 1 &&
                other.box.top < short &&
                other.box.top + SUMMIT_ROW > long,
            );
            const tick = (key: string, from: number, to: number) => (
              <line
                key={key}
                x1={at}
                y1={from}
                x2={at}
                y2={to}
                stroke="#000"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
            );
            if (long === undefined || blocking.length === 0)
              return tick(
                String(index),
                long === undefined ? short : Math.min(long, short),
                bottom,
              );
            // Blocked: a tick hanging from the label, and the summit's tick fading upwards in two
            // dots, below the lowest label in the way. The hanging tick is short where the label in
            // the way is right below, on the next row; otherwise it reaches down to above it (5 px
            // from its letters), fading in two dots too
            const labelBottom = label!.box.top + SUMMIT_ROW;
            const nextTop = Math.min(...blocking.map((other) => other.box.top));
            const fades = nextTop - labelBottom > ROW_GAP;
            const hangTo = fades ? nextTop - 6 : Math.min(labelBottom + HANG, nextTop - 1);
            const clearBelow = Math.max(...blocking.map((other) => other.box.top + SUMMIT_ROW)) + 1;
            const dot = (key: string, y: number) => (
              <rect
                key={key}
                x={at - 0.5}
                y={y}
                width={1}
                height={1}
                fill="#000"
                shapeRendering="crispEdges"
              />
            );
            return [
              hangTo > labelBottom + 1 ? tick(`${index} hang`, labelBottom + 1, hangTo) : null,
              ...(fades ? [nextTop - 5, nextTop - 3].map((y) => dot(`${index} hang ${y}`, y)) : []),
              // Shorter by two pixels, which the dots take: one every other pixel above it
              tick(String(index), short + 2, bottom),
              ...[2, 4]
                .map((above) => short + 2 - above)
                .filter((y) => y >= clearBelow)
                .map((y) => dot(`${index} ${y}`, y)),
            ];
          })}
        </svg>
        {labels.map(({ index, text, width, box }) => (
          <div
            key={index}
            style={{
              position: "absolute",
              left: box.left,
              top: box.top,
              width,
              height: SUMMIT_ROW,
              // The text inside its box, descenders included (the font's own line height is
              // taller, and would hang them below it, onto the tick)
              lineHeight: `${SUMMIT_ROW}px`,
              display: "flex",
              justifyContent: "center",
              whiteSpace: "nowrap",
            }}
          >
            {text}
          </div>
        ))}
      </div>
      {/* The lowest height, under the lowest point (at the edge it would cross) */}
      <div style={{ display: "flex", position: "relative", height: SUMMIT_ROW }}>
        <div
          style={{
            position: "absolute",
            left: Math.min(Math.max(lowAt - LOW_LABEL / 2, 0), PROFILE_WIDTH - LOW_LABEL),
            width: LOW_LABEL,
            display: "flex",
            justifyContent:
              lowAt < LOW_LABEL / 2
                ? "flex-start"
                : lowAt > PROFILE_WIDTH - LOW_LABEL / 2
                  ? "flex-end"
                  : "center",
          }}
        >
          {metres(lowest)}
        </div>
      </div>
    </div>
  );
}

type Placed<T> = T & { box: { left: number; top: number } };

// Labels side by side (in the chart, or sharing a row) at least two spaces apart
const LABEL_GAP = Math.ceil(textWidth("  ", "TRMNL12", 12));

/**
 * Places summits' labels (the lowest summit first) with `rows` rows above the chart: each `width`
 * wide, for a summit at `at` across whose tick starts at `tickTop` (in the chart). A label's places,
 * the preferred first: in the chart right above its tick, or on a line at the chart's top, clear of
 * the land under it (`points`, and a pixel either side) and of every summit's tick; then on a row,
 * the one nearest the chart first. In each, centred over its summit, else starting or ending at it
 * (to keep clear of higher land or a label on one side, rather than needing a row); moved in at the
 * chart's edges, and checked where it ends up, so a wide one moved in is checked on the side it then
 * reaches. Labels at least LABEL_GAP apart. The first combination where all fit, going back to an
 * earlier label's next place when a later one has none; undefined if there's none. With
 * `clearTicks`, no label in the way of another summit's tick up to its label (which would leave
 * that tick short, with dots). Boxes are from the top of the rows.
 */
function layoutLabels<T extends { at: number; tickTop: number; width: number }>(
  labels: T[],
  points: { x: number; y: number }[],
  rows: number,
  clearTicks: boolean,
): Placed<T>[] | undefined {
  const rowsHeight = rowsHeightOf(rows);
  const placed: Placed<T>[] = [];
  // Whether a label is in the way of a summit's tick up from its summit to its label (at `top`)
  const inTheWay = (
    label: { left: number; top: number; width: number },
    summit: { at: number; tickTop: number; top: number },
  ) =>
    label.top > summit.top &&
    label.top < rowsHeight + summit.tickTop &&
    summit.at >= label.left - 1 &&
    summit.at <= label.left + label.width + 1;
  const clearOfLabels = (label: T, left: number, top: number) =>
    placed.every(
      ({ box, width, at, tickTop }) =>
        (box.top + SUMMIT_ROW <= top ||
          top + SUMMIT_ROW <= box.top ||
          box.left + width + LABEL_GAP <= left ||
          left + label.width + LABEL_GAP <= box.left) &&
        (!clearTicks ||
          (!inTheWay({ left, top, width: label.width }, { at, tickTop, top: box.top }) &&
            !inTheWay({ ...box, width }, { ...label, top }))),
    );
  // In the chart: clear of the land under it (and a pixel either side), and of every summit's
  // tick, with room for descenders between; not too near its top with the most rows
  const clearInChart = (left: number, chartTop: number, width: number) =>
    chartTop >= chartTopFloor(rows) &&
    points.every((p) => p.x < left - 1 || p.x > left + width + 1 || p.y > chartTop + SUMMIT_ROW) &&
    labels.every(
      ({ at, tickTop }) =>
        at < left - 1 || at > left + width + 1 || tickTop >= chartTop + SUMMIT_ROW + TICK_GAP,
    );
  // Each label's places, the preferred first
  const placesOf = (label: T) => {
    const { at, tickTop, width } = label;
    const inside = (left: number) =>
      Math.min(Math.max(left, -LABEL_OVERFLOW), PROFILE_WIDTH - width + LABEL_OVERFLOW);
    // Centred, starting at the summit, ending at it: the last two half an "m" (9 px wide, its ink
    // the middle 7) past it, so a label's first or last letter, e.g. the "m" of metres, is centred
    // on the tick
    const lefts = [inside(at - width / 2), inside(at - 4.5), inside(at + 4.5 - width)];
    return [
      ...[tickTop - TICK_GAP - SUMMIT_ROW, 0].flatMap((chartTop) =>
        lefts.map((left) => ({ left, top: rowsHeight + chartTop, chartTop })),
      ),
      // The rows nearest the chart first: the highest summit's label, placed last, then goes on top
      ...Array.from({ length: rows }, (_, k) =>
        lefts.map((left) => ({ left, top: (rows - 1 - k) * ROW_STEP, chartTop: undefined })),
      ).flat(),
    ].filter(({ left, chartTop }) => chartTop === undefined || clearInChart(left, chartTop, width));
  };
  // The first combination where all fit, trying each label's places in order (and going back to
  // an earlier label's next place when a later one doesn't fit), so a label moved aside can make
  // room for the next
  const place = (k: number): boolean => {
    if (k === labels.length) return true;
    const label = labels[k];
    for (const { left, top } of placesOf(label)) {
      if (!clearOfLabels(label, left, top)) continue;
      placed.push({ ...label, box: { left, top } });
      if (place(k + 1)) return true;
      placed.pop();
    }
    return false;
  };
  return place(0) ? placed : undefined;
}

/**
 * Every summit's label on two rows above the chart, by distance, alternating so neighbours' don't
 * meet (the highest summit's on the top row), centred over it as far as the edges allow: when they
 * don't fit as layoutLabels would place them.
 */
function alternatingRows<T extends { index: number; at: number; width: number }>(
  summits: T[],
  altitude: number[],
): Placed<T>[] {
  const byDistance = [...summits].sort((a, b) => a.index - b.index);
  const highest = Math.max(...byDistance.map(({ index }) => altitude[index]));
  const first = byDistance.findIndex(({ index }) => altitude[index] === highest) % 2;
  return byDistance.map((summit, k) => ({
    ...summit,
    box: {
      left: Math.min(
        Math.max(summit.at - summit.width / 2, -LABEL_OVERFLOW),
        PROFILE_WIDTH - summit.width + LABEL_OVERFLOW,
      ),
      top: ((k + first) % 2) * ROW_STEP,
    },
  }));
}

const Message = (props: { children: ComponentChildren }) => (
  <div
    style={{
      display: "flex",
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      padding: 40,
      ...textSize(21),
    }}
  >
    {props.children}
  </div>
);

/** The `offset` input, at least 0. */
const offsetOf = (inputs: { offset: number }) => Math.max(0, inputs.offset);

export default defineScreen({
  inputs: {
    // Which activity: 0 the latest, 1 the one before, and so on (not counting private ones)
    offset: { type: "int", default: 0 },
  },

  // In the browser's lists, e.g. "strava: 1 back"
  label: ({ inputs }) => (offsetOf(inputs) > 0 ? `${offsetOf(inputs)} back` : undefined),

  dependencies: {
    // The device's own account, fetched as far back as the offset needs
    strava: [
      loadStravaActivity,
      {
        account: ({ device }) => device.username,
        depth: ({ inputs }) => depthFor(offsetOf(inputs)),
        connection: () => stravaConnection(),
      },
    ],
    profile: [
      loadStravaProfile,
      {
        account: ({ device }) => device.username,
        offset: ({ inputs }) => offsetOf(inputs),
        connection: () => stravaConnection(),
      },
    ],
    route: [
      loadStravaRoute,
      {
        account: ({ device }) => device.username,
        offset: ({ inputs }) => offsetOf(inputs),
        width: () => MAP_WIDTH,
        height: () => MAP_HEIGHT,
        connection: () => stravaConnection(),
      },
    ],
  },

  // The activity at the offset (none if there's none that far back)
  prepare: ({ inputs, dependencies: { strava, route, profile } }) =>
    strava.connected
      ? {
          connected: true as const,
          activity: strava.activities[offsetOf(inputs)] as Activity | undefined,
          error: strava.error,
          route,
          profile,
        }
      : { connected: false as const, route, profile },

  // Strava's brand guidelines ask for "Powered by Strava" with its data; then the link to
  // disconnect, or until connected, the link to connect (for the logged-in user's device on the
  // server, the dev server's one account on it)
  credits: ({ data }) =>
    data.connected
      ? [
          { text: "Powered by Strava", url: "https://www.strava.com/" },
          // The link back to the activity that Strava's guidelines ask for with its data
          ...(data.activity
            ? [
                {
                  text: "View on Strava",
                  url: `https://www.strava.com/activities/${data.activity.id}`,
                },
              ]
            : []),
          // Only on this server: Strava still allows the app, e.g. for the dev server
          { text: "Disconnect Strava", url: "/strava/disconnect" },
        ]
      : [{ text: "Connect Strava", url: "/strava/connect" }],

  ttl: ({ data }) => (data.connected ? TTL_SECONDS : NOT_CONNECTED_TTL_SECONDS),

  view({ device, inputs, now, telemetry, data }) {
    const activity = data.connected ? data.activity : undefined;
    const when =
      activity &&
      new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: device.timeZone,
      }).format(activity.start);
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          padding: `${PADDING_Y}px ${PADDING_X}px`,
          background: "#fff",
          color: "#000",
          fontFamily: "Noto Sans",
        }}
      >
        <Header title={activity?.name ?? "Strava"}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {data.connected && (
              <img
                src={POWERED_BY_STRAVA}
                height={LOGO_HEIGHT}
                width={Math.round(LOGO_HEIGHT * POWERED_BY_STRAVA_RATIO)}
                style={{ marginRight: 16 }}
              />
            )}
            <Battery telemetry={telemetry} />
          </div>
        </Header>
        {!data.connected ? (
          <Message>Not connected to Strava: use "Connect Strava" under the preview</Message>
        ) : !activity ? (
          <Message>
            {data.error
              ? `Strava unavailable: ${data.error}`
              : offsetOf(inputs) > 0
                ? `No activity ${offsetOf(inputs)} back`
                : "No activities yet"}
          </Message>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
            <div style={{ display: "flex", gap: COLUMN_GAP }}>
              {/* The route on a map, on the left */}
              <RouteMapView route={data.route} />
              {/* The stats, two by two, and the activity's QR code at the bottom right */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  flex: 1,
                  height: MAP_HEIGHT,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  {/* The sport, with the kudos at its right if there are any (only "High intensity
                      interval training" is cut off with "…" next to them), then the start */}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                      }}
                    >
                      {/* Shrinking to what the kudos leave, like the header's title */}
                      <div
                        style={{
                          display: "flex",
                          flex: 1,
                          minWidth: 0,
                          ...textSize(32),
                          ...ellipsis,
                        }}
                      >
                        {sportName(activity.sportType)}
                      </div>
                      {activity.kudos > 0 && (
                        <div
                          style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
                        >
                          <ThumbsUp size={22} />
                          <span style={{ ...textSize(21), fontWeight: 700 }}>
                            {String(activity.kudos)}
                          </span>
                        </div>
                      )}
                    </div>
                    <span style={{ ...textSize(16) }}>{when}</span>
                  </div>
                  <div style={{ display: "flex" }}>
                    <Stat value={kilometres(activity.distance)} unit="km" label="Distance" />
                    <Stat value={duration(activity.movingTime)} unit="" label="Moving time" />
                  </div>
                  <div style={{ display: "flex" }}>
                    <Stat
                      value={pace(activity)[0]}
                      unit={pace(activity)[1]}
                      label={
                        PACED.has(activity.sportType) || activity.sportType === "Swim"
                          ? "Pace"
                          : "Speed"
                      }
                    />
                    <Stat
                      value={String(Math.round(activity.elevationGain))}
                      unit="m"
                      label="Ascent"
                    />
                  </div>
                </div>
                {/* The elevation profile, for activities on a contour map, and the QR code, with
                    "View on Strava" over it, bold, as Strava's guidelines ask links to its data to
                    look */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                  }}
                >
                  {/* As high as "View on Strava" and the code together, so its labels' top is in
                      line with the text's */}
                  {data.profile ? (
                    <ProfileChart
                      profile={data.profile}
                      height={VIEW_ROW + qrSize(activityUrl(activity), QR_MODULE)}
                    />
                  ) : (
                    <div />
                  )}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span style={{ ...textSize(16), fontWeight: 700, height: VIEW_ROW }}>
                      View on Strava
                    </span>
                    <QrCode text={activityUrl(activity)} module={QR_MODULE} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
});
