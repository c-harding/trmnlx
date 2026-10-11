// Journeys from Transitous (transitous.org), a community-run journey planner for Europe built on
// MOTIS, with timetables and live data from many operators (DB, ÖBB, MVG, …). No API key; it's
// run by volunteers, so requests are kept few: journey searches are cached for five minutes.
//
// Three sources: lookupStop (a name to a stop), and loadJourneys and loadDepartures, which depend
// on it.

import { defineSource, paramsOf } from "../define-source.ts";
import type { Departure, DepartureKind } from "../departure.ts";
import { USER_AGENT } from "../version.ts";

const BASE_URL = "https://api.transitous.org/api/v1";

/**
 * For screens showing Transitous' data, linked under their preview in the browser: its usage policy
 * asks for a visible link to its list of sources (whose conditions that covers), and for
 * OpenStreetMap's attribution, as it uses OSM data (stops, walking).
 */
export const TRANSITOUS_CREDITS = [
  { text: "Data: Transitous", url: "https://transitous.org/sources/" },
  { text: "© OpenStreetMap", url: "https://www.openstreetmap.org/copyright" },
];
const TIMEOUT_MS = 15_000;

// Journey searches are cached for five minutes; delays shown can be that old
const JOURNEY_MAX_AGE_MS = 5 * 60_000;
// The next search starts this long before the cached one expires (see loadJourneys)
const JOURNEY_REFRESH_AHEAD_MS = 90_000;
// Journeys asked for per search: more than a screen shows, since some leave before the next search.
// The same for every screen, so screens showing the same route share one search.
// Generous, since screens may leave out connections (e.g. ones their rules don't allow).
const JOURNEYS_PER_SEARCH = 12;
// A failed stop lookup is tried again after this long (a found stop is kept until restart)
const LOOKUP_RETRY_MS = 30_000;

/** A place on the map: a stop on a ride, or a stop of a route. */
export interface Point {
  name: string;
  lat: number;
  lon: number;
}

export interface Stop extends Point {
  /** Transitous' stop ID, e.g. "de-DELFI_de:09162:2" */
  id: string;
}

/** One ride in a journey (walks between rides are left out). */
export interface JourneyLeg {
  /** e.g. "U2", "Bus 54", "RB54", "RJX 19950" */
  line: string;
  /**
   * Transitous' mode, e.g. "BUS", "SUBWAY", "METRO" (S-Bahn), "REGIONAL_RAIL", "HIGHSPEED_RAIL";
   * corrected where the data files long-distance services as regional (see correctedMode)
   */
  mode: string;
  from: string;
  to: string;
  /** Expected and scheduled times (ms since the epoch); equal without live data */
  departure: number;
  plannedDeparture: number;
  arrival: number;
  plannedArrival: number;
  /** Whether the times come from live data */
  realTime: boolean;
  cancelled: boolean;
  /** e.g. "Bayerische Regiobahn", "WESTbahn" */
  operator: string;
  /** Where it stops: where it's boarded, the stops in between, and where it's left */
  stops: Point[];
}

export interface Journey {
  /** The first ride's departure and the last ride's arrival */
  departure: number;
  arrival: number;
  changes: number;
  legs: JourneyLeg[];
}

export interface JourneysResult {
  /** The stops as Transitous names them; undefined if they couldn't be looked up */
  from?: string;
  to?: string;
  /** All the route's stops in order (from, via stops, to); undefined if one couldn't be looked up */
  stops?: Stop[];
  /** Earliest first; undefined if a lookup or the search failed */
  journeys?: Journey[];
  error?: Error;
}

// The parts of Transitous' answers that are used here
interface TransitousPlace {
  type?: string;
  id?: string;
  name?: string;
  lat?: number;
  lon?: number;
}

interface TransitousStopPlace {
  name: string;
  lat: number;
  lon: number;
}

interface TransitousLeg {
  mode: string;
  routeShortName?: string;
  /** The train number, e.g. "000965" */
  tripShortName?: string;
  agencyName?: string;
  from: TransitousStopPlace;
  to: TransitousStopPlace;
  intermediateStops?: TransitousStopPlace[];
  startTime: string;
  scheduledStartTime?: string;
  endTime: string;
  scheduledEndTime?: string;
  realTime?: boolean;
  cancelled?: boolean;
}

interface TransitousItinerary {
  transfers: number;
  legs: TransitousLeg[];
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

// After a failed search: Transitous' Retry-After for a 429 (too many requests), otherwise a minute;
// other errors (timeouts, server errors) are tried again sooner
const RATE_LIMIT_RETRY_MS = 60_000;
const ERROR_RETRY_MS = 30_000;

/** An answer other than 200, with how long to wait before asking again if Transitous said. */
class TransitousError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`Transitous answered ${status}`);
  }
}

/** Retry-After in ms: a number of seconds, or a date. */
function parseRetryAfter(header: string | null) {
  if (!header) return undefined;
  const ms = /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.max(ms, 0) : undefined;
}

/** How long a failed search is kept before the next request tries again. */
const retryDelay = (error: Error) =>
  error instanceof TransitousError && error.status === 429 ? (error.retryAfterMs ?? RATE_LIMIT_RETRY_MS) : ERROR_RETRY_MS;

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new TransitousError(res.status, parseRetryAfter(res.headers.get("Retry-After")));
  return res.json();
};

/**
 * The stop for a name, e.g. "Innsbruck Hbf"; null if Transitous doesn't know it or the lookup
 * failed (logged, and tried again after LOOKUP_RETRY_MS). The first stop in Transitous' ranking,
 * which weighs how important a stop is: not an exact name match, which can be a minor one (the
 * only stop named exactly "Innsbruck Hbf" is a Dutch dataset's, with night trains only; ÖBB's is
 * "Innsbruck Hauptbahnhof").
 */
export const lookupStop = defineSource({
  name: "transitous.stop",
  params: paramsOf<{ name: string }>(),
  async load({ name }): Promise<Stop | null> {
    try {
      const results = (await getJson(`${BASE_URL}/geocode?text=${encodeURIComponent(name)}`)) as TransitousPlace[];
      if (!Array.isArray(results)) throw new Error(`Unexpected Transitous response when looking up ${name}`);
      const stop = results.find((r) => r.type === "STOP" && r.id);
      if (!stop) throw new Error(`Transitous knows no stop called ${name}`);
      console.log(`Transitous stop ${JSON.stringify(name)} is ${stop.name} (${stop.id})`);
      return { id: stop.id!, name: stop.name ?? name, lat: Number(stop.lat), lon: Number(stop.lon) };
    } catch (error) {
      console.error(`Looking up Transitous stop ${name} failed: ${asError(error).message}`);
      return null;
    }
  },
  maxAge: (stop) => (stop ? Infinity : LOOKUP_RETRY_MS),
});

/**
 * The mode, corrected for operators of long-distance services that DB's data (DELFI) files as
 * regional rail (route type 106) or plain buses: WESTbahn ("DRF (965)") and FlixTrain are
 * long-distance trains, FlixBus a coach. And ÖBB's data files some REX trains as METRO (S-Bahn)
 * although their route type is regional rail (106), mixed with others of the same line.
 */
function correctedMode(leg: LineFields) {
  if (leg.mode === "METRO" && leg.routeType === 106) return "REGIONAL_RAIL";
  const operator = leg.agencyName ?? "";
  if (operator === "WESTbahn" || /flixtrain/i.test(operator)) return "LONG_DISTANCE";
  if (/flix/i.test(operator)) return leg.mode === "BUS" || leg.mode === "COACH" ? "COACH" : "LONG_DISTANCE";
  return leg.mode;
}

/** What line names are made from: a ride in a journey, or a departure from a stop. */
interface LineFields {
  mode: string;
  /** GTFS' route type, e.g. 3 (bus), 106 (regional rail), 109 (suburban rail), 714 (replacement bus) */
  routeType?: number;
  routeShortName?: string;
  /** The train number, e.g. "000965" */
  tripShortName?: string;
  agencyName?: string;
}

// "RB54 (79063)" → "RB54", "54" → "54"
function shortLineName(leg: LineFields) {
  // WESTbahn's trains are "DRF (965)" in DB's data, but "WB 965" in ÖBB's, on their trains and at stations
  if (leg.agencyName === "WESTbahn") {
    const number = /\((\d+)\)$/.exec(leg.routeShortName ?? "")?.[1] ?? leg.tripShortName?.replace(/^0+/, "");
    return number ? `WB ${number}` : "WB";
  }
  return (leg.routeShortName ?? "").replace(/\s*\(.*\)$/, "").trim() || leg.mode.toLowerCase();
}

// As shortLineName, but a bare number gets its kind ("Bus 54"), as the departures screens show them
function lineName(leg: LineFields) {
  const name = shortLineName(leg);
  if (!/^\d+$/.test(name)) return name;
  if (leg.mode === "BUS" || leg.mode === "COACH") return `Bus ${name}`;
  if (leg.mode === "TRAM") return `Tram ${name}`;
  return `Train ${name}`;
}

function toJourney(itinerary: TransitousItinerary): Journey | undefined {
  const legs = itinerary.legs
    .filter((leg) => leg.mode !== "WALK")
    .map(
      (leg): JourneyLeg => ({
        line: lineName(leg),
        mode: correctedMode(leg),
        from: leg.from.name,
        to: leg.to.name,
        departure: Date.parse(leg.startTime),
        plannedDeparture: Date.parse(leg.scheduledStartTime ?? leg.startTime),
        arrival: Date.parse(leg.endTime),
        plannedArrival: Date.parse(leg.scheduledEndTime ?? leg.endTime),
        realTime: Boolean(leg.realTime),
        cancelled: Boolean(leg.cancelled),
        operator: leg.agencyName ?? "",
        stops: [leg.from, ...(leg.intermediateStops ?? []), leg.to].map(({ name, lat, lon }) => ({ name, lat, lon })),
      }),
    );
  // A journey that is only walking isn't a connection
  if (legs.length === 0) return undefined;
  return { departure: legs[0].departure, arrival: legs.at(-1)!.arrival, changes: itinerary.transfers, legs };
}

/**
 * The next journeys from one stop to another, optionally via others in the given order (all given
 * by name), from now on: JOURNEYS_PER_SEARCH of them when Transitous finds that many, earliest
 * first. Searches are cached for five minutes, so some of the journeys may have left by the time
 * they are shown.
 */
export const loadJourneys = defineSource({
  name: "transitous.journeys",
  params: paramsOf<{ from: string; to: string; via: string[] }>(),
  dependencies: {
    from: [lookupStop, { name: ({ params }) => params.from }],
    to: [lookupStop, { name: ({ params }) => params.to }],
    // One lookup per via stop, in order
    via: [lookupStop, ({ params }) => params.via.map((name) => ({ name }))],
  },
  // On an error, the previous journeys are kept (with `error` set)
  async load({ from: fromName, to: toName, via: viaNames }, { from, to, via }, previous): Promise<JourneysResult> {
    const fallBack = (error: Error): JourneysResult => ({
      from: from?.name ?? previous?.from,
      to: to?.name ?? previous?.to,
      stops: previous?.stops,
      journeys: previous?.journeys,
      error,
    });
    const missing = !from ? fromName : !to ? toName : viaNames.find((_name, i) => !via[i]);
    if (missing) return fallBack(new Error(`Stop ${missing} not found`));
    const query = new URLSearchParams({
      fromPlace: from!.id,
      toPlace: to!.id,
      time: new Date().toISOString(),
      numItineraries: String(JOURNEYS_PER_SEARCH),
    });
    // In order, comma-separated
    if (via.length > 0) query.set("via", via.map((stop) => stop!.id).join(","));
    try {
      const data = (await getJson(`${BASE_URL}/plan?${query}`)) as { itineraries?: TransitousItinerary[] };
      if (!Array.isArray(data.itineraries)) throw new Error("Unexpected Transitous response for a journey search");
      const journeys = data.itineraries
        .map(toJourney)
        .filter((journey) => journey !== undefined)
        .sort((a, b) => a.departure - b.departure);
      return { from: from!.name, to: to!.name, stops: [from!, ...via.map((stop) => stop!), to!], journeys };
    } catch (error) {
      console.error(`Searching journeys from ${from!.name} to ${to!.name} failed: ${asError(error).message}`);
      return { ...fallBack(asError(error)), stops: previous?.stops ?? [from!, ...via.map((stop) => stop!), to!] };
    }
  },
  // A failure is kept briefly, so a rate limit isn't hit again by every request
  maxAge: (result) => (result.error ? retryDelay(result.error) : JOURNEY_MAX_AGE_MS),
  // A search takes seconds (with via stops up to about 12), so the next one starts in the
  // background while screens still show this one; screens showing it are requested every minute,
  // so one comes within that time. Not for a failure, whose retry delay is meant to be waited out.
  refreshAhead: (result) => (result.error ? 0 : JOURNEY_REFRESH_AHEAD_MS),
  // Once expired, still shown (while the next search runs) until half its journeys have left:
  // departed ones are hidden anyway. Without journeys, never: an empty list says nothing about now.
  staleUntil: ({ journeys }) => (journeys?.length ? journeys[Math.floor((journeys.length - 1) / 2)].departure : 0),
});

// Departures: up to this many per request, so the next ones on each line are usually among them
const DEPARTURES_PER_REQUEST = 100;
// At most one request per stop per minute, however many devices and browser tabs show it
const DEPARTURES_MAX_AGE_MS = 55_000;

export interface StopDeparturesResult {
  /** Undefined if the name couldn't be looked up */
  station?: Stop;
  /** Earliest first; undefined if the lookup or the request failed */
  departures?: Departure[];
  error?: Error;
}

// The parts of a stop time (a departure) that are used here
interface TransitousStopTime extends LineFields {
  routeLongName?: string;
  routeId?: string;
  directionId?: string;
  headsign?: string;
  cancelled?: boolean;
  tripCancelled?: boolean;
  place: { departure?: string; scheduledDeparture?: string; pickupType?: string };
}

/** How Transitous' modes are drawn (see DepartureKind). */
function kindOfMode(mode: string): DepartureKind {
  if (mode === "BUS" || mode === "COACH") return "bus";
  if (mode === "TRAM") return "tram";
  // MOTIS calls the S-Bahn METRO
  if (mode === "METRO" || mode === "SUBURBAN") return "s-bahn";
  return "other";
}

// Rail replacement buses: GTFS' route type for them, the words in their names, ÖBB's line names
// for them ("SV524"), and ÖBB's rail company running a bus (its ordinary buses are Postbus')
const RAIL_REPLACEMENT_ROUTE_TYPE = 714;
const RAIL_REPLACEMENT_WORDS = /\b(sev|ersatz\w*|schienenersatz\w*)\b/i;
const RAIL_REPLACEMENT_LINE = /^SV\s?\d+$/i;
const RAIL_OPERATOR = /^(ÖBB|OEBB)[- ]Personenverkehr/i;

/** Whether a departure is a bus replacing trains ("SEV", Schienenersatzverkehr). */
function isRailReplacement(st: TransitousStopTime) {
  if (st.routeType === RAIL_REPLACEMENT_ROUTE_TYPE) return true;
  const bus = st.mode === "BUS" || st.mode === "COACH";
  if (bus && RAIL_OPERATOR.test(st.agencyName ?? "")) return true;
  if (RAIL_REPLACEMENT_LINE.test(st.routeShortName ?? "")) return true;
  return [st.routeShortName, st.routeLongName, st.headsign].some((text) => RAIL_REPLACEMENT_WORDS.test(text ?? ""));
}

/**
 * Which departures count as the same line and direction, for the "next" times. ÖBB's data gives
 * every train its own route ID, but the ID starts with what looks like a line code after the
 * dataset's name: "…_2-RX2-T-j26-118.TA.…" → "2-RX2-T" (REX 2 in Tyrol; whatever follows, e.g. a
 * timetable version, is left out). Trains without one (e.g. Railjets) go by their type and
 * destination ("RJX" to "Bregenz Bahnhof"); buses, trams and other datasets by their route ID.
 */
function lineIdOf(st: TransitousStopTime, line: string) {
  const code = /_(\d+-[A-Z0-9]+-[A-Z])-/.exec(st.routeId ?? "")?.[1];
  if (code) return `${code}|${st.directionId ?? st.headsign ?? ""}`;
  const kind = kindOfMode(st.mode);
  if (kind !== "bus" && kind !== "tram") return `${trainType(line)}|${st.headsign ?? ""}`;
  return st.routeId ? `${st.routeId}|${st.directionId ?? ""}` : "";
}

/** A train's type from its name: "REX 5323" → "REX", "RJX 19960" → "RJX"; other names stay as they are. */
const trainType = (line: string) => /^([A-Za-z]+)\s+\d+$/.exec(line)?.[1] ?? line;

// Regional trains are shown by their type only ("REX", "CJX", "R", as MVG does): ÖBB's data names
// them by train number ("REX 5323"), which means little at the station and makes long labels.
// Long-distance trains keep theirs ("RJX 19960"), which is shown at stations.
const TYPE_ONLY_MODES = new Set(["REGIONAL_RAIL", "REGIONAL_FAST_RAIL"]);

/**
 * The same train can come from two datasets at one stop (e.g. "RJ 83" from ÖBB's data and "89",
 * train number 000083, from DB's): departures with the same scheduled time and train number are
 * one, and the one with the more telling name ("RJ 83" rather than a bare number) is kept.
 */
function withoutDuplicates(stopTimes: TransitousStopTime[]) {
  const trainNumber = (st: TransitousStopTime) => /(\d+)\s*$/.exec(st.tripShortName ?? "")?.[1]?.replace(/^0+/, "");
  const kept = new Map<string, TransitousStopTime>();
  const result: TransitousStopTime[] = [];
  for (const st of stopTimes) {
    const number = trainNumber(st);
    if (!number || kindOfMode(st.mode) === "bus" || kindOfMode(st.mode) === "tram") {
      result.push(st);
      continue;
    }
    const key = `${st.place.scheduledDeparture}|${number}`;
    const other = kept.get(key);
    if (!other) {
      kept.set(key, st);
      result.push(st);
    } else if (/^\d+$/.test(shortLineName(other)) && !/^\d+$/.test(shortLineName(st))) {
      result[result.indexOf(other)] = st;
      kept.set(key, st);
    }
  }
  return result;
}

/**
 * The next departures from a stop, given by name: `{ station, departures, error }`, earliest
 * first. Transitous merges the datasets serving stops of the same name (e.g. Innsbruck Hbf's
 * trains from ÖBB's data, its trams and buses from Tyrol's). Transitous has no notes ("Fährt nur
 * bis …"). Rail replacement buses get the type "RAIL_REPLACEMENT" (see isRailReplacement). If the lookup or request failed, `error` is set, and the departures are the previous
 * ones, if any.
 */
export const loadDepartures = defineSource({
  name: "transitous.departures",
  params: paramsOf<{ station: string }>(),
  dependencies: {
    stop: [lookupStop, { name: ({ params }) => params.station }],
  },
  // On an error, the previous departures are kept (with `error` set)
  async load({ station }, { stop }, previous): Promise<StopDeparturesResult> {
    const fallBack = (error: Error): StopDeparturesResult => ({
      station: stop ?? previous?.station,
      departures: previous?.departures,
      error,
    });
    if (!stop) return fallBack(new Error(`Stop ${station} not found`));
    const query = new URLSearchParams({ stopId: stop.id, n: String(DEPARTURES_PER_REQUEST) });
    try {
      const data = (await getJson(`${BASE_URL}/stoptimes?${query}`)) as { stopTimes?: TransitousStopTime[] };
      if (!Array.isArray(data.stopTimes)) throw new Error("Unexpected Transitous response for departures");
      const departures = withoutDuplicates(
        // Only departures: a trip ending here can't be boarded
        data.stopTimes.filter((st) => st.place.departure && st.place.pickupType !== "NOT_ALLOWED"),
      )
        .map((st): Departure => {
          // Replacement buses have a type of their own, so hiding "BUS" doesn't hide them
          const replacement = isRailReplacement(st);
          const type = replacement ? "RAIL_REPLACEMENT" : correctedMode(st);
          const name = shortLineName(st);
          const line = replacement && (!st.routeShortName || name === st.mode.toLowerCase()) ? "SEV" : name;
          return {
            line: TYPE_ONLY_MODES.has(type) ? trainType(line) : line,
            type,
            kind: replacement ? "bus" : kindOfMode(type),
            lineId: lineIdOf(st, line),
            destination: st.headsign ?? "",
            time: Date.parse(st.place.departure!),
            planned: Date.parse(st.place.scheduledDeparture ?? st.place.departure!),
            cancelled: Boolean(st.cancelled || st.tripCancelled),
            messages: [],
          };
        })
        .filter((d) => Number.isFinite(d.time))
        .sort((a, b) => a.time - b.time);
      return { station: stop, departures };
    } catch (error) {
      console.error(`Fetching departures for ${stop.name} failed: ${asError(error).message}`);
      return fallBack(asError(error));
    }
  },
  // A failure is kept briefly, so a rate limit isn't hit again by every request
  maxAge: (result) => (result.error ? retryDelay(result.error) : DEPARTURES_MAX_AGE_MS),
});
