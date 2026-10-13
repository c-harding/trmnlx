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
import { QrCode } from "../components/qr-code.tsx";
import { POWERED_BY_STRAVA, POWERED_BY_STRAVA_RATIO } from "../components/strava-logo.ts";
import { textSize } from "../components/type.ts";
import { defineScreen } from "../define-screen.ts";
import { projection } from "../map-drawing.ts";
import { HEIGHT, WIDTH } from "../render.ts";
import {
  type Activity,
  depthFor,
  loadStravaActivity,
  stravaConnection,
  loadStravaRoute,
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
  prepare: ({ inputs, dependencies: { strava, route } }) =>
    strava.connected
      ? {
          connected: true as const,
          activity: strava.activities[offsetOf(inputs)] as Activity | undefined,
          error: strava.error,
          route,
        }
      : { connected: false as const, route },

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
                    <Stat
                      value={(activity.distance / 1000).toFixed(1)}
                      unit="km"
                      label="Distance"
                    />
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
                {/* "View on Strava" over it, bold, as Strava's guidelines ask links to its data to look */}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span style={{ ...textSize(16), fontWeight: 700 }}>View on Strava</span>
                    <QrCode text={`https://www.strava.com/activities/${activity.id}`} module={3} />
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
