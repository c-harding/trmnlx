// Departures from MVG, the Munich transport company. This is the unofficial interface behind
// mvg.de and its app: no API key, but undocumented, so it may change without notice.
//
// Three sources: lookupStation (a name to a station), and loadDepartures and loadConnections,
// which depend on it. Cached by the framework (see define-source.ts):
// - station names → station IDs (e.g. "Marienplatz" → "de:09162:2"), kept until the server restarts,
//   since IDs practically never change;
// - departures per station and route searches, kept for under a minute.
//
// Always for the current time: the dev server's time setting only changes what screens show.

import { defineSource, paramsOf } from "../define-source.ts";

const BASE_URL = "https://www.mvg.de/api/bgw-pt/v3";

// At most one request per station (or route) per minute, however many devices and browser tabs
// show it
const MAX_AGE_MS = 55_000;
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
  /** e.g. "STATION", "POI", "ADDRESS" */
  type?: string;
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

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`MVG answered ${res.status}`);
  return res.json();
};

async function fetchStation(name: string): Promise<Station> {
  // Not `locationTypes=STATION`: since October 2026, MVG answers that with a redirect to its home
  // page. Without it, the results include places and addresses, so stations are picked out here.
  const results = (await getJson(`${BASE_URL}/locations?query=${encodeURIComponent(name)}`)) as MvgLocation[];
  if (!Array.isArray(results)) throw new Error(`Unexpected MVG response when looking up ${name}`);
  const stations = results.filter((r) => r.type === "STATION" && r.globalId);
  // Prefer an exact match: "Silberhornstraße" also finds "Silberhorn-/Ichostraße"
  const station = stations.find((r) => r.name?.toLowerCase() === name.toLowerCase()) ?? stations[0];
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
// among them, even for lines that run every 20 minutes
async function fetchDepartures(stationId: string): Promise<Departure[]> {
  const data = (await getJson(
    `${BASE_URL}/departures?globalId=${encodeURIComponent(stationId)}&limit=100&transportTypes=${TRANSPORT_TYPES}`,
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
 * The next departures from a station, given by name: `{ station, departures, error }`. `station` is `{ id, name }`, or undefined if the name couldn't
 * be looked up. If the lookup or fetch failed, `error` is set, and the departures are the latest
 * ones fetched for the station, if any.
 */
export const loadDepartures = defineSource({
  name: "mvg.departures",
  params: paramsOf<{ station: string }>(),
  dependencies: {
    station: [lookupStation, { name: ({ params }) => params.station }],
  },
  // On an error, the previous list is kept (with `error` set)
  async load({ station: stationName }, { station }, previous): Promise<DeparturesResult> {
    const fallBack = (error: Error): DeparturesResult => ({
      station: station ?? previous?.station,
      departures: previous?.departures,
      error,
    });
    if (!station) return fallBack(new Error(`Station ${stationName} not found`));
    try {
      return { station, departures: await fetchDepartures(station.id) };
    } catch (error) {
      console.error(`Fetching departures for ${station.name} failed: ${asError(error).message}`);
      return fallBack(asError(error));
    }
  },
  // A failure isn't kept: the next request tries again
  maxAge: (result) => (result.error ? 0 : MAX_AGE_MS),
});

// MVG's route search returns its few best connections (5 at a time), possibly with changes. The
// direct ones of the wanted transport type answer "the next S-Bahn to Ostbahnhof", including trains
// that end there (which never appear in the target's own departures).
async function fetchNextDirect(from: Station, to: Station, types: string[]): Promise<Departure[]> {
  const query = new URLSearchParams({
    originStationGlobalId: from.id,
    destinationStationGlobalId: to.id,
    routingDateTime: new Date().toISOString(),
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
 * station to another, both given by name: `{ target, connections, error }`.
 * `connections` are shaped like departures, earliest first (several, since the first may have left
 * by the time it's shown). If the lookup or fetch failed, `error` is set, and the connections are
 * the latest ones for the same search, if any.
 */
export const loadConnections = defineSource({
  name: "mvg.connections",
  params: paramsOf<{ station: string; target: string; types: string[] }>(),
  // Types sorted: "SBAHN|UBAHN" and "UBAHN|SBAHN" are the same search
  cacheKey: ({ types, ...rest }) => ({ ...rest, types: types.toSorted() }),
  dependencies: {
    from: [lookupStation, { name: ({ params }) => params.station }],
    to: [lookupStation, { name: ({ params }) => params.target }],
  },
  // On an error, the previous connections are kept (with `error` set)
  async load({ station, target, types }, { from, to }, previous): Promise<ConnectionsResult> {
    const fallBack = (error: Error): ConnectionsResult => ({
      target: to?.name ?? previous?.target ?? target,
      connections: previous?.connections,
      error,
    });
    if (!from || !to) return fallBack(new Error(`Station ${from ? target : station} not found`));
    try {
      return { target: to.name, connections: await fetchNextDirect(from, to, types) };
    } catch (error) {
      console.error(`Fetching the next ${types.join("/")} from ${from.name} to ${to.name} failed: ${asError(error).message}`);
      return fallBack(asError(error));
    }
  },
  // A failure isn't kept: the next request tries again
  maxAge: (result) => (result.error ? 0 : MAX_AGE_MS),
});
