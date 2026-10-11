// Journeys from Transitous (transitous.org), a community-run journey planner for Europe built on
// MOTIS, with timetables and live data from many operators (DB, ÖBB, MVG, …). No API key; it's
// run by volunteers, so requests are kept few: journey searches are cached for five minutes.
//
// Two sources: lookupStop (a name to a stop) and loadJourneys, which depends on it.

import { defineSource, paramsOf } from "../define-source.ts";

const BASE_URL = "https://api.transitous.org/api/v1";
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
    headers: { Accept: "application/json", "User-Agent": "trmnl-server (self-hosted e-ink display)" },
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
 * long-distance trains, FlixBus a coach.
 */
function correctedMode(leg: TransitousLeg) {
  const operator = leg.agencyName ?? "";
  if (operator === "WESTbahn" || /flixtrain/i.test(operator)) return "LONG_DISTANCE";
  if (/flix/i.test(operator)) return leg.mode === "BUS" || leg.mode === "COACH" ? "COACH" : "LONG_DISTANCE";
  return leg.mode;
}

// "RB54 (79063)" → "RB54"; a bare number gets its kind ("Bus 54"), as the departures screen shows them
function lineName(leg: TransitousLeg) {
  // WESTbahn's trains are "DRF (965)" in DB's data, but "WB 965" in ÖBB's, on their trains and at stations
  if (leg.agencyName === "WESTbahn") {
    const number = /\((\d+)\)$/.exec(leg.routeShortName ?? "")?.[1] ?? leg.tripShortName?.replace(/^0+/, "");
    return number ? `WB ${number}` : "WB";
  }
  const name = (leg.routeShortName ?? "").replace(/\s*\(.*\)$/, "").trim();
  if (!/^\d+$/.test(name)) return name || leg.mode.toLowerCase();
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
});
