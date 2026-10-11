// Departures from MVG, the Munich transport company. This is the unofficial interface behind
// mvg.de and its app: no API key, but undocumented, so it may change without notice.
//
// Three sources: lookupStation (a name to a station), and loadDepartures and loadConnections,
// which depend on it. Cached by the framework (see define-source.ts):
// - station names → station IDs (e.g. "Marienplatz" → "de:09162:2"), kept until the server restarts,
//   since IDs practically never change;
// - departures per station and route searches, kept for under a minute.
//
// Data is fetched for a given time (the screen's `now`: the current time, except with the dev
// server's time setting), and cached per minute of that time.

import { defineSource, paramsOf } from "../define-source.ts";

const BASE_URL = "https://www.mvg.de/api/bgw-pt/v3";

// Results are cached per minute (see startOfMinute); after this long they are removed from memory
const MAX_AGE_MS = 60_000;
// A failed station lookup is tried again after this long (a found station is kept until restart)
const LOOKUP_RETRY_MS = 30_000;
const TIMEOUT_MS = 10_000;

// MVG leaves regional trains (BAHN) and regional buses out unless asked for them explicitly
const TRANSPORT_TYPES = "UBAHN,SBAHN,TRAM,BUS,REGIONAL_BUS,BAHN";

export interface Station {
  /** MVG's global ID, e.g. "de:09162:2" */
  id: string;
  name: string;
}

export interface Departure {
  /** e.g. "U2", "54", "REX" */
  line: string;
  /** MVG's transport type, e.g. "UBAHN", "BUS" */
  type: string;
  /** Line and direction; empty for connections from the route search */
  lineId: string;
  destination: string;
  /** The expected departure (ms since the epoch), including any delay */
  time: number;
  /** The scheduled departure (ms since the epoch) */
  planned: number;
  cancelled: boolean;
  messages: string[];
}

export interface DeparturesResult {
  /** Undefined if the name couldn't be looked up */
  station?: Station;
  /** Undefined if the lookup or fetch failed */
  departures?: Departure[];
  /** Set if the lookup or fetch failed */
  error?: Error;
}

export interface ConnectionsResult {
  target: string;
  connections?: Departure[];
  error?: Error;
}

// The parts of MVG's answers that are used here; anything may be missing
interface MvgLocation {
  name?: string;
  globalId?: string;
}

interface MvgDeparture {
  trainType?: string;
  label?: string;
  transportType?: string;
  lineId?: string;
  destination?: string;
  realtimeDepartureTime?: number;
  plannedDepartureTime?: number;
  cancelled?: boolean;
  infos?: { message?: string; type?: string }[];
}

interface MvgRoute {
  parts?: {
    from: { plannedDeparture: string; departureDelayInMinutes?: number };
    line?: { label?: string; transportType: string; destination?: string; trainType?: string };
    isCancelled?: boolean;
  }[];
}

/** Rounds a time down to the minute, so all requests within a minute share one cached result. */
const startOfMinute = (time: Date) => new Date(Math.floor(time.getTime() / 60_000) * 60_000);

/** Whole minutes from the current time to `time`, e.g. 0 for now and 60 for an hour from now. */
const minutesFromNow = (time: Date) => Math.round((time.getTime() - Date.now()) / 60_000);

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`MVG answered ${res.status}`);
  return res.json();
};

async function fetchStation(name: string): Promise<Station> {
  const results = (await getJson(
    `${BASE_URL}/locations?query=${encodeURIComponent(name)}&locationTypes=STATION`,
  )) as MvgLocation[];
  if (!Array.isArray(results)) throw new Error(`Unexpected MVG response when looking up ${name}`);
  // Prefer an exact match: "Silberhornstraße" also finds "Silberhorn-/Ichostraße"
  const station =
    results.find((r) => r.name?.toLowerCase() === name.toLowerCase() && r.globalId) ??
    results.find((r) => r.globalId);
  if (!station) throw new Error(`MVG knows no station called ${name}`);
  console.log(`MVG station ${JSON.stringify(name)} is ${station.name} (${station.globalId})`);
  return { id: station.globalId!, name: station.name ?? name };
}

/**
 * The station `{ id, name }` for a station name, kept until restart once found; null if MVG doesn't
 * know it or the lookup failed (logged, and tried again after LOOKUP_RETRY_MS).
 */
export const lookupStation = defineSource({
  name: "mvg.station",
  params: paramsOf<{ name: string }>(),
  async load({ name }): Promise<Station | null> {
    try {
      return await fetchStation(name);
    } catch (error) {
      console.error(`Looking up MVG station ${name} failed: ${asError(error).message}`);
      return null;
    }
  },
  // After `load`, which its type comes from
  maxAge: (station) => (station ? Infinity : LOOKUP_RETRY_MS),
});

// More than fit on the screen, so the next departure on the same line and direction is usually
// among them, even for lines that run every 20 minutes. MVG answers from the current time plus
// `offsetInMinutes`, and ignores negative offsets: the past isn't available.
async function fetchDepartures(stationId: string, offsetMinutes: number): Promise<Departure[]> {
  const data = (await getJson(
    `${BASE_URL}/departures?globalId=${encodeURIComponent(stationId)}&limit=100&transportTypes=${TRANSPORT_TYPES}&offsetInMinutes=${offsetMinutes}`,
  )) as MvgDeparture[];
  if (!Array.isArray(data)) throw new Error(`Unexpected MVG response for ${stationId}`);

  return data
    .map((d) => ({
      // For trains the label is often just the train number ("5384"), so show its type ("REX") instead
      line: String(d.trainType || d.label || "?"),
      type: String(d.transportType ?? ""),
      // Line and direction ("…:H:…" or "…:R:…"); trains turning back early share it with full runs
      lineId: String(d.lineId ?? ""),
      destination: String(d.destination ?? ""),
      // The expected departure, including any delay
      time: Number(d.realtimeDepartureTime ?? d.plannedDepartureTime),
      planned: Number(d.plannedDepartureTime ?? d.realtimeDepartureTime),
      cancelled: Boolean(d.cancelled),
      // "Fährt nur bis …" first: it matters more than general incidents on the line
      messages: (d.infos ?? [])
        .toSorted((a, b) => Number(b.type === "EARLY_TERMINATION") - Number(a.type === "EARLY_TERMINATION"))
        .map((info) => info.message)
        .filter((message): message is string => Boolean(message)),
    }))
    .filter((d) => Number.isFinite(d.time))
    .sort((a, b) => a.time - b.time); // MVG doesn't sort by the actual (realtime) departure
}

/**
 * The departures for a station, given by name, from `time` on (no earlier than the current time):
 * `{ station, departures, error }`. `station` is `{ id, name }`, or undefined if the name couldn't
 * be looked up; if the lookup or fetch failed, there are no departures and `error` is set.
 */
export const loadDepartures = defineSource({
  name: "mvg.departures",
  params: paramsOf<{ station: string; time: Date }>(),
  cacheKey: ({ station, time }) => ({ station, time: startOfMinute(time) }),
  dependencies: {
    station: [lookupStation, { name: ({ params }) => params.station }],
  },
  async load({ station: stationName, time }, { station }): Promise<DeparturesResult> {
    if (!station) return { error: new Error(`Station ${stationName} not found`) };
    try {
      return { station, departures: await fetchDepartures(station.id, Math.max(minutesFromNow(time), 0)) };
    } catch (error) {
      console.error(`Fetching departures for ${station.name} failed: ${asError(error).message}`);
      return { station, error: asError(error) };
    }
  },
  // A failure isn't kept: the next request tries again
  maxAge: (result) => (result.error ? 0 : MAX_AGE_MS),
});

// MVG's route search returns its few best connections (5 at a time), possibly with changes. The
// direct ones of the wanted transport type answer "the next S-Bahn to Ostbahnhof", including trains
// that end there (which never appear in the target's own departures).
async function fetchNextDirect(from: Station, to: Station, types: string[], time: Date): Promise<Departure[]> {
  const query = new URLSearchParams({
    originStationGlobalId: from.id,
    destinationStationGlobalId: to.id,
    routingDateTime: time.toISOString(),
    routingDateTimeIsArrival: "false",
  });
  const routes = (await getJson(`${BASE_URL}/routes?${query}`)) as MvgRoute[];
  if (!Array.isArray(routes)) throw new Error(`Unexpected MVG response for routes to ${to.name}`);

  const direct = routes
    .map((route) => route.parts ?? [])
    .filter((parts) => parts.length === 1 && types.includes(parts[0].line?.transportType ?? "") && !parts[0].isCancelled)
    .map(([part]): Departure => {
      const planned = Date.parse(part.from.plannedDeparture);
      return {
        // Same fields as a departure, so it can be found in (and shown like) the departures list
        line: String(part.line!.trainType || part.line!.label || "?"),
        type: part.line!.transportType,
        lineId: "",
        destination: String(part.line!.destination ?? ""),
        planned,
        time: planned + Number(part.from.departureDelayInMinutes ?? 0) * 60_000,
        cancelled: false,
        messages: [],
      };
    })
    .filter((d) => Number.isFinite(d.time))
    .sort((a, b) => a.time - b.time);
  return direct;
}

/**
 * The next direct connections of any of some transport types (e.g. ["SBAHN", "UBAHN"]) from one
 * station to another, both given by name, leaving from `time` on: `{ target, connections, error }`.
 * `connections` are shaped like departures, earliest first (several, since the first may have left
 * by the time it's shown); if the lookup or fetch failed, there are none and `error` is set.
 */
export const loadConnections = defineSource({
  name: "mvg.connections",
  params: paramsOf<{ station: string; target: string; types: string[]; time: Date }>(),
  // Types sorted: "SBAHN|UBAHN" and "UBAHN|SBAHN" are the same search
  cacheKey: ({ time, types, ...rest }) => ({ ...rest, types: types.toSorted(), time: startOfMinute(time) }),
  dependencies: {
    from: [lookupStation, { name: ({ params }) => params.station }],
    to: [lookupStation, { name: ({ params }) => params.target }],
  },
  async load({ station, target, types, time }, { from, to }): Promise<ConnectionsResult> {
    if (!from || !to) return { target, error: new Error(`Station ${from ? target : station} not found`) };
    try {
      return { target: to.name, connections: await fetchNextDirect(from, to, types, time) };
    } catch (error) {
      console.error(`Fetching the next ${types.join("/")} from ${from.name} to ${to.name} failed: ${asError(error).message}`);
      return { target: to.name, error: asError(error) };
    }
  },
  // A failure isn't kept: the next request tries again
  maxAge: (result) => (result.error ? 0 : MAX_AGE_MS),
});
