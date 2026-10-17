// Your latest activities on Strava (strava.com), through its API. Strava needs OAuth: once per account,
// "Connect Strava" (a link under the screen's preview) sends the browser to Strava to allow access,
// which sends it back to /strava/callback with a code; the code becomes an access token (valid 6
// hours) and a refresh token for more. Both are kept per account in a TokenStore: the server's in
// the device's state file, the dev server's in a file of its own (see configureStrava). Renewing
// can give a new refresh token, which replaces the old one, so the two never share a store.
//
// The app's client ID and secret are in devices.yaml (`tokens.strava`), never sent to a browser.
import { randomBytes } from "node:crypto";
import type { Express, Request } from "express";
import { defineSource, paramsOf } from "../define-source.ts";
import { ConfigError } from "../playlists.ts";
import { type MapView, worldPixel } from "../map-drawing.ts";
import { USER_AGENT } from "../version.ts";
import { loadMap, type MapResult } from "./map.ts";
import { loadPeaks, peakTileOf } from "./openfreemap.ts";

const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const API_URL = "https://www.strava.com/api/v3";
// Activities visible to everyone or followers ("activity:read_all" would add private ones)
const SCOPE = "activity:read";
const TIMEOUT_MS = 10_000;
// Strava allows about 100 requests per 15 minutes and 1000 a day for an app: one a quarter hour
const MAX_AGE_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;
// A connection started (the browser sent to Strava) must come back within this
const PENDING_MS = 10 * 60_000;
// An access token is renewed when it has less than this left
const RENEW_BEFORE_MS = 5 * 60_000;

/** The app registered at strava.com/settings/api. */
export interface StravaApp {
  clientId: string;
  clientSecret: string;
}

/** An account's tokens. */
export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires (ms since the epoch) */
  expiresAt: number;
}

/** Where an account's tokens are kept: by account (a device's username). */
export interface TokenStore {
  get(account: string): StravaTokens | undefined;
  /** Undefined removes them (disconnected) */
  set(account: string, tokens: StravaTokens | undefined): void;
}

/** devices.yaml's `tokens.strava`, checked: undefined without it (no Strava). */
export function readStravaApp(tokens: unknown): StravaApp | undefined {
  if (tokens === undefined) return undefined;
  if (typeof tokens !== "object" || tokens === null)
    throw new ConfigError(
      "tokens must be a mapping, e.g. tokens: { strava: { client_id: …, client_secret: … } }",
    );
  const strava = (tokens as Record<string, unknown>).strava;
  if (strava === undefined) return undefined;
  const { client_id: clientId, client_secret: clientSecret } = (strava ?? {}) as Record<
    string,
    unknown
  >;
  // YAML reads an unquoted client ID as a number
  if (!(typeof clientId === "string" || typeof clientId === "number") || String(clientId) === "")
    throw new ConfigError("tokens.strava.client_id must be the Strava app's client ID");
  if (typeof clientSecret !== "string" || clientSecret === "")
    throw new ConfigError("tokens.strava.client_secret must be the Strava app's client secret");
  return { clientId: String(clientId), clientSecret };
}

/**
 * A TokenStore over saved state: `read` gives an account's saved tokens (anything else counts as
 * none), `write` saves them (null for none). Kept in memory too, as saved state is read only once.
 */
export function savedTokenStore(
  read: (account: string) => unknown,
  write: (account: string, tokens: StravaTokens | null) => void,
): TokenStore {
  const tokens = new Map<string, StravaTokens | undefined>();
  const valid = (saved: unknown): saved is StravaTokens => {
    const record = saved as Partial<StravaTokens> | null;
    return (
      typeof record?.accessToken === "string" &&
      typeof record.refreshToken === "string" &&
      typeof record.expiresAt === "number"
    );
  };
  return {
    get(account) {
      if (!tokens.has(account)) {
        const saved = read(account);
        tokens.set(account, valid(saved) ? saved : undefined);
      }
      return tokens.get(account);
    },
    set(account, value) {
      tokens.set(account, value);
      write(account, value ?? null);
    },
  };
}

let configured: { app: StravaApp; store: TokenStore } | undefined;

/** Sets the app and where tokens are kept: at startup, by the server or the dev server. */
export function configureStrava(app: StravaApp | undefined, store: TokenStore) {
  configured = app && { app, store };
}

/** A token request (a code or a refresh token for tokens), or why it failed. */
async function requestTokens(fields: Record<string, string>): Promise<StravaTokens> {
  const { app } = configured!;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      ...fields,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new StravaError(res.status, `Strava answered ${res.status}`);
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at * 1000,
  };
}

class StravaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Renewals in progress, by account: so two requests at once renew once (the first's refresh token
// would be spent for the second)
const renewing = new Map<string, Promise<StravaTokens | undefined>>();

/**
 * A valid access token for the account, renewed if it's about to expire, or undefined if it isn't
 * connected (or the connection was revoked on Strava, which forgets it).
 */
async function accessToken(account: string): Promise<string | undefined> {
  if (!configured) return undefined;
  const { store } = configured;
  const tokens = store.get(account);
  if (!tokens) return undefined;
  if (tokens.expiresAt - RENEW_BEFORE_MS > Date.now()) return tokens.accessToken;
  let renewal = renewing.get(account);
  if (!renewal) {
    renewal = requestTokens({ grant_type: "refresh_token", refresh_token: tokens.refreshToken })
      .then((renewed) => {
        store.set(account, renewed);
        return renewed;
      })
      .catch((error) => {
        // Refused (revoked on Strava, or a bad refresh token): no longer connected
        if (error instanceof StravaError && (error.status === 400 || error.status === 401)) {
          console.error(`Strava refused to renew ${account}'s access: disconnected`);
          store.set(account, undefined);
          connectionChanges++;
          return undefined;
        }
        throw error;
      })
      .finally(() => renewing.delete(account));
    renewing.set(account, renewal);
  }
  return (await renewal)?.accessToken;
}

// Counts connections and disconnections: the sources take it as a param, so after either the next
// render doesn't get a cached result from before
let connectionChanges = 0;

/** Changes with every connection or disconnection (see connectionChanges). */
export const stravaConnection = () => connectionChanges;

/**
 * Mounts /strava/connect (sends the browser to Strava to allow access), /strava/callback (where
 * Strava sends it back) and /strava/disconnect. `accountOf` says whose account a request is for:
 * the server's logged-in device, the dev server's one account; a callback must be for the same
 * account its connection was started for. Afterwards the browser goes back to the page the link was
 * on. Disconnecting only forgets this server's tokens for the account: Strava isn't asked to revoke
 * the app's access, so another server connected to the same Strava account (e.g. the dev server and
 * the live one) stays connected.
 */
export function stravaRoutes(app: Express, accountOf: (req: Request) => string | undefined) {
  // Connections started, by their `state` (a random value Strava sends back, so a callback can't
  // be forged): the account and where to go back to
  const pending = new Map<string, { account: string; returnTo: string; expires: number }>();
  const redirectUri = (req: Request) => `${req.protocol}://${req.get("host")}/strava/callback`;
  // Back to the page the link was on, if it's on this server
  const returnTo = (req: Request) => {
    const referer = req.get("referer");
    try {
      const url = new URL(referer ?? "");
      if (url.host === req.get("host")) return url.pathname + url.search;
    } catch {}
    return "/";
  };

  app.get("/strava/connect", (req, res) => {
    if (!configured)
      return res
        .status(404)
        .type("text")
        .send("Strava isn't set up: add tokens.strava to devices.yaml\n");
    const account = accountOf(req);
    if (!account) return res.redirect(303, "/login");
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    const state = randomBytes(16).toString("base64url");
    pending.set(state, { account, returnTo: returnTo(req), expires: Date.now() + PENDING_MS });
    const query = new URLSearchParams({
      client_id: configured.app.clientId,
      redirect_uri: redirectUri(req),
      response_type: "code",
      scope: SCOPE,
      state,
    });
    res.redirect(303, `${AUTHORIZE_URL}?${query}`);
  });

  app.get("/strava/callback", async (req, res, next) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const started = pending.get(state);
    pending.delete(state);
    // Unknown or expired, or for another account than this request's (e.g. logged in as someone
    // else since)
    if (
      !configured ||
      !started ||
      started.expires < Date.now() ||
      accountOf(req) !== started.account
    ) {
      return res
        .status(400)
        .type("text")
        .send("This Strava connection wasn't started here, or took too long: try again\n");
    }
    // Refused on Strava's page ("error=access_denied"), or the activities left unticked
    const scopes = typeof req.query.scope === "string" ? req.query.scope.split(",") : [];
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    if (!code || !scopes.includes(SCOPE)) return res.redirect(303, started.returnTo);
    try {
      configured.store.set(
        started.account,
        await requestTokens({ grant_type: "authorization_code", code }),
      );
      connectionChanges++;
      console.log(`Strava connected for ${started.account}`);
      res.redirect(303, started.returnTo);
    } catch (error) {
      next(error);
    }
  });

  app.get("/strava/disconnect", (req, res) => {
    const account = accountOf(req);
    if (!account) return res.redirect(303, "/login");
    if (configured?.store.get(account)) {
      configured.store.set(account, undefined);
      connectionChanges++;
      console.log(`Strava disconnected for ${account}`);
    }
    res.redirect(303, returnTo(req));
  });
}

/** An activity, as the screen shows it. */
export interface Activity {
  /** Strava's ID: its page is strava.com/activities/<id> */
  id: number;
  name: string;
  /** e.g. "Run", "Ride", "Hike", "TrailRun" */
  sportType: string;
  /** Its start (ms since the epoch) */
  start: number;
  /** Metres, seconds, metres */
  distance: number;
  movingTime: number;
  elevationGain: number;
  kudos: number;
  /** Its highest point minus its lowest (m), and its highest (m), if Strava has its heights */
  relief: number | undefined;
  highest: number | undefined;
  /** The route as a Google encoded polyline, if it has one */
  polyline: string | undefined;
}

/**
 * Not connected; or the latest activities that aren't private, latest first (none if there are none
 * yet), and why they couldn't be fetched if they couldn't.
 */
export type StravaResult =
  { connected: false } | { connected: true; activities: Activity[]; error?: string };

interface ApiActivity {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  distance: number;
  moving_time: number;
  total_elevation_gain: number;
  kudos_count: number;
  elev_high?: number;
  elev_low?: number;
  private: boolean;
  visibility?: string;
  map?: { summary_polyline?: string };
}

// How far back activities are fetched by default: enough for any `offset` up to 15, so screens
// showing those share one request. Twice as many are asked for, as private ones are left out
const DEFAULT_DEPTH = 16;
// Strava's most per request
const MAX_PER_PAGE = 200;

/** The `depth` to ask loadStravaActivity for, for an activity `offset` back from the latest. */
export const depthFor = (offset: number) => Math.max(DEFAULT_DEPTH, offset + 1);

/**
 * The account's latest activities that aren't private (shown to everyone or followers), latest
 * first: at least `depth` of them if there are (see depthFor), one request for all screens asking
 * for the same depth.
 */
export const loadStravaActivity = defineSource({
  name: "strava.activity",
  // `connection`: stravaConnection(), so a result from before connecting or disconnecting isn't used
  params: paramsOf<{ account: string; depth: number; connection: number }>(),
  async load({ account, depth }, _dependencies, previous): Promise<StravaResult> {
    try {
      const token = await accessToken(account);
      if (!token) return { connected: false };
      const perPage = Math.min(MAX_PER_PAGE, 2 * depth);
      const res = await fetch(`${API_URL}/athlete/activities?per_page=${perPage}`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Strava answered ${res.status}`);
      const activities = ((await res.json()) as ApiActivity[])
        .filter((a) => !a.private && a.visibility !== "only_me")
        .map((a) => ({
          id: a.id,
          name: a.name,
          sportType: a.sport_type,
          start: Date.parse(a.start_date),
          distance: a.distance,
          movingTime: a.moving_time,
          elevationGain: a.total_elevation_gain,
          kudos: a.kudos_count,
          relief:
            a.elev_high !== undefined && a.elev_low !== undefined
              ? a.elev_high - a.elev_low
              : undefined,
          highest: a.elev_high,
          polyline: a.map?.summary_polyline || undefined,
        }));
      return { connected: true, activities };
    } catch (error) {
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? "Strava didn't answer in time"
          : (error as Error).message;
      console.error(`Fetching ${account}'s Strava activity failed: ${message}`);
      return {
        connected: true,
        activities: previous?.connected ? previous.activities : [],
        error: message,
      };
    }
  },
  // Not connected: asked again at once, so connecting shows straight away (no request is made)
  maxAge: (result) => (!result.connected ? 0 : result.error ? RETRY_MS : MAX_AGE_MS),
});

/** The points of a Google encoded polyline (Strava's routes), as [lat, lon] in degrees. */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  // Each coordinate a signed difference to the previous one, in 1e-5 degrees, 5 bits a character
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

/**
 * A map view `width` × `height` px showing all of a route, with `padding` px around it: centred on
 * it, as far in as it fits (at most zoom 16, where a street map's details end).
 */
export function routeView(
  points: [number, number][],
  width: number,
  height: number,
  padding: number,
): MapView {
  // Web Mercator at zoom 0, where the map's projection matches it closely enough for fitting
  const xs = points.map(([, lon]) => worldPixel(0, lon, 0).x);
  const ys = points.map(([lat]) => worldPixel(lat, 0, 0).y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const fit = Math.min(
    (width - 2 * padding) / Math.max(maxX - minX, 1e-9),
    (height - 2 * padding) / Math.max(maxY - minY, 1e-9),
  );
  // Rounded, so the same route always gives the same view (and its saved map)
  const zoom = Math.round(Math.min(16, Math.log2(fit)) * 100) / 100;
  const centre = latLonOfWorldPixel((minX + maxX) / 2, (minY + maxY) / 2);
  return {
    lat: Math.round(centre.lat * 1e5) / 1e5,
    lon: Math.round(centre.lon * 1e5) / 1e5,
    zoom,
    width,
    height,
    // So the route, black, is the only black line
    grayRoads: true,
  };
}

// Sports off roads, in hills and mountains, whose routes are shown on a contour map rather than a
// street map: hikes, trail runs, and alpine sports (Strava's sport types)
const OFF_ROAD = new Set([
  "Hike",
  "TrailRun",
  "AlpineSki",
  "BackcountrySki",
  "NordicSki",
  "Snowboard",
  "Snowshoe",
  "RockClimbing",
]);
// For a contour map, an activity needs this much relief (highest point minus lowest): enough for a
// few lines. Less, e.g. a walk through a city, would show its roofs (the elevations are a surface
// model) more than its hills, so it gets a street map; unless it went this high, in the mountains,
// where a short walk on a ridge has little relief of its own but steep land all around (and few
// streets)
const MIN_CONTOUR_RELIEF = 150;
const MOUNTAINS = 1000;

/**
 * Whether an activity's route is shown on a contour map: off roads, and hilly enough or high enough
 * (if Strava has its heights; otherwise the sport decides).
 */
export const onContours = (activity: Pick<Activity, "sportType" | "relief" | "highest">) =>
  OFF_ROAD.has(activity.sportType) &&
  (activity.relief === undefined ||
    activity.relief >= MIN_CONTOUR_RELIEF ||
    (activity.highest ?? 0) >= MOUNTAINS);

/** The latitude and longitude of a Web Mercator pixel at zoom 0 (256 px around the world). */
function latLonOfWorldPixel(x: number, y: number) {
  return {
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 256))) * 180) / Math.PI,
    lon: (x / 256) * 360 - 180,
  };
}

/** An activity's route on a street map: the map, its view and the route's points. */
export interface RouteMap {
  view: MapView;
  points: [number, number][];
  map: MapResult;
}

/**
 * The route of the account's activity `offset` back from the latest (0: the latest) on a map
 * `width` × `height`, if it has one: a contour map for hilly hikes, trail runs and alpine sports
 * (see onContours), otherwise a street map.
 */
export const loadStravaRoute = defineSource({
  name: "strava.route",
  params: paramsOf<{
    account: string;
    offset: number;
    width: number;
    height: number;
    connection: number;
  }>(),
  dependencies: {
    strava: [
      loadStravaActivity,
      {
        account: ({ params }) => params.account,
        depth: ({ params }) => depthFor(params.offset),
        connection: ({ params }) => params.connection,
      },
    ],
  },
  async load({ offset, width, height }, { strava }): Promise<RouteMap | undefined> {
    const activity = strava.connected ? strava.activities[offset] : undefined;
    if (!activity?.polyline) return undefined;
    const points = decodePolyline(activity.polyline);
    if (points.length < 2) return undefined;
    const view: MapView = {
      ...routeView(points, width, height, 16),
      ...(onContours(activity) && { style: "contours" as const }),
    };
    return { view, points, map: await loadMap(view) };
  },
  // As often as the activity (the map itself is drawn once per view, see sources/map.ts)
  maxAge: MAX_AGE_MS,
});

// Points kept of an activity's elevation profile: a few per pixel of the screen's chart
const PROFILE_POINTS = 300;

/** An activity's elevation profile: heights (m) at distances (m) along it, and its summits. */
export interface Profile {
  distance: number[];
  altitude: number[];
  /** Its summits (see summitIndices): where in the profile, and the peak's name if it's known */
  summits: { index: number; name: string | undefined }[];
}

/**
 * The summits of a profile: the points with no higher one within `share` of its length either side
 * (the first, where two are as high), so they're at least that far apart.
 */
export function summitIndices(distance: number[], altitude: number[], share = 0.25): number[] {
  const window = share * (distance[distance.length - 1] - distance[0]);
  return altitude.flatMap((height, i) => {
    for (let j = 0; j < altitude.length; j++) {
      if (j === i || Math.abs(distance[j] - distance[i]) > window) continue;
      if (altitude[j] > height || (altitude[j] === height && j < i)) return [];
    }
    return [i];
  });
}

/**
 * How far a point of a profile rises above the land between it and any higher point along it: its
 * height less the higher of the lowest points on the way to the nearest higher point either side
 * (one side only if there's none on the other; the lowest point of all if there's none at all).
 */
export function prominence(altitude: number[], index: number): number {
  const height = altitude[index];
  const cols: number[] = [];
  for (const step of [-1, 1]) {
    let low = height;
    for (let i = index + step; i >= 0 && i < altitude.length; i += step) {
      if (altitude[i] > height) {
        cols.push(low);
        break;
      }
      low = Math.min(low, altitude[i]);
    }
  }
  return height - (cols.length ? Math.max(...cols) : Math.min(...altitude));
}

// A summit is named after the nearest named OpenStreetMap peak or pass this close (m) to the route
// around it, the stretch within STRETCH_M of it either way along the route: paths often pass a little
// below or beside a top, and the profile's highest point (where the altitude peaked, a few tens of
// metres apart after thinning) needn't be where the route comes closest
const PEAK_RADIUS_M = 200;
const STRETCH_M = 300;

/** The distance between two places (m), near enough for a few hundred metres. */
function metresBetween(a: [number, number], b: [number, number]) {
  const dLat = (b[0] - a[0]) * 111_320;
  const dLon = (b[1] - a[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// A peak's height (where OpenStreetMap has it) and the route's at a summit named after it differ by
// at most this (m): GPS heights are a few tens of metres out, but a station or shoulder below a top
// is further
const HEIGHT_TOLERANCE_M = 50;

/**
 * The names of summits, each given by the route's places around it (see STRETCH_M) and its height:
 * the OpenStreetMap peak or pass nearest that stretch (a route over a pass has a summit there too),
 * from the tiles it passes through, of a height that agrees (see HEIGHT_TOLERANCE_M). A peak names
 * only the summit whose stretch comes closest to it. Undefined where there's none.
 */
async function summitNames(
  summits: { stretch: [number, number][]; altitude: number }[],
): Promise<(string | undefined)[]> {
  // Each summit's candidates: name and how close its stretch comes
  const candidates = await Promise.all(
    summits.map(async ({ stretch, altitude }) => {
      try {
        // Each tile the stretch passes through once (usually one, two near an edge)
        const tiles = new Map(stretch.map((place) => [peakTileOf(place[0], place[1]), place]));
        const peaks = (
          await Promise.all([...tiles.values()].map((place) => loadPeaks(place[0], place[1])))
        ).flat();
        return peaks
          .filter(
            (peak) => peak.ele === undefined || Math.abs(peak.ele - altitude) <= HEIGHT_TOLERANCE_M,
          )
          .map((peak) => ({
            name: peak.name,
            metres: Math.min(...stretch.map((place) => metresBetween(place, [peak.lat, peak.lon]))),
          }))
          .filter(({ metres }) => metres <= PEAK_RADIUS_M)
          .sort((a, b) => a.metres - b.metres);
      } catch (error) {
        console.error(
          `Looking up the peak at ${stretch[0].join(", ")} failed: ${(error as Error).message}`,
        );
        return [];
      }
    }),
  );
  // How close each name comes to any summit: it names only that one
  const closest = new Map<string, number>();
  for (const list of candidates)
    for (const { name, metres } of list)
      closest.set(name, Math.min(closest.get(name) ?? Infinity, metres));
  return candidates.map(
    (list) => list.find(({ name, metres }) => closest.get(name) === metres)?.name,
  );
}

/**
 * An activity's heights along its distance (Strava's streams), thinned to PROFILE_POINTS, with its
 * summits named from OpenStreetMap (one tile each); undefined if it has none (e.g. no altitude
 * recorded). Kept until restart: a finished activity's don't change.
 */
export const loadStravaStreams = defineSource({
  name: "strava.streams",
  params: paramsOf<{ account: string; id: number; connection: number }>(),
  async load({ account, id }): Promise<Profile | undefined> {
    const token = await accessToken(account);
    if (!token) return undefined;
    const res = await fetch(
      `${API_URL}/activities/${id}/streams?keys=distance,altitude,latlng&key_by_type=true`,
      {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Strava answered ${res.status}`);
    const streams = (await res.json()) as {
      distance?: { data: number[] };
      altitude?: { data: number[] };
      latlng?: { data: [number, number][] };
    };
    const distance = streams.distance?.data ?? [];
    const altitude = streams.altitude?.data ?? [];
    const count = Math.min(distance.length, altitude.length);
    if (count < 2) return undefined;
    const step = Math.max(1, Math.ceil(count / PROFILE_POINTS));
    const kept = Array.from({ length: Math.ceil(count / step) }, (_, i) => i * step);
    if (kept.at(-1) !== count - 1) kept.push(count - 1);
    const thinned = {
      distance: kept.map((i) => distance[i]),
      altitude: kept.map((i) => altitude[i]),
    };
    // Its summits, named where the route's place is known
    const latlng = streams.latlng?.data;
    const indices = summitIndices(thinned.distance, thinned.altitude);
    // Each summit's stretch of the route, at full resolution
    const stretch = (at: number) =>
      latlng!.filter((_, j) => j < count && Math.abs(distance[j] - distance[at]) <= STRETCH_M);
    const names =
      latlng?.length === count
        ? await summitNames(
            indices.map((i) => ({ stretch: stretch(kept[i]), altitude: thinned.altitude[i] })),
          )
        : [];
    return { ...thinned, summits: indices.map((index, k) => ({ index, name: names[k] })) };
  },
  maxAge: Infinity,
});

/**
 * The elevation profile of the account's activity `offset` back from the latest, if it's shown on
 * a contour map (see onContours) and has one. A failed fetch shows none, rather than failing the
 * screen, and is tried again with the next activities.
 */
export const loadStravaProfile = defineSource({
  name: "strava.profile",
  params: paramsOf<{ account: string; offset: number; connection: number }>(),
  dependencies: {
    strava: [
      loadStravaActivity,
      {
        account: ({ params }) => params.account,
        depth: ({ params }) => depthFor(params.offset),
        connection: ({ params }) => params.connection,
      },
    ],
  },
  async load({ account, offset, connection }, { strava }): Promise<Profile | undefined> {
    const activity = strava.connected ? strava.activities[offset] : undefined;
    if (!activity || !onContours(activity)) return undefined;
    try {
      return await loadStravaStreams({ account, id: activity.id, connection });
    } catch (error) {
      console.error(
        `Fetching Strava activity ${activity.id}'s heights failed: ${(error as Error).message}`,
      );
      return undefined;
    }
  },
  // As often as the activities (the streams themselves are kept, see loadStravaStreams)
  maxAge: MAX_AGE_MS,
});
