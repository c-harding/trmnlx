// Departures from MVG, the Munich transport company. This is the unofficial interface behind
// mvg.de and its app: no API key, but undocumented, so it may change without notice.
//
// Two caches with very different lifetimes:
// - station names → station IDs (e.g. "Marienplatz" → "de:09162:2"), kept until the server restarts,
//   since IDs practically never change;
// - departures per station, kept for under a minute.

const BASE_URL = "https://www.mvg.de/api/bgw-pt/v3";

// At most one request per station per minute, however many devices and browser tabs show it
const MAX_AGE_MS = 55_000;
// A failed station lookup is tried again after this long, not on every request
const LOOKUP_RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;

// MVG leaves regional trains (BAHN) and regional buses out unless asked for them explicitly
const TRANSPORT_TYPES = "UBAHN,SBAHN,TRAM,BUS,REGIONAL_BUS,BAHN";

const getJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`MVG answered ${res.status}`);
  return res.json();
};

const stations = new Map();

async function lookUpStation(name) {
  const results = await getJson(
    `${BASE_URL}/locations?query=${encodeURIComponent(name)}&locationTypes=STATION`,
  );
  if (!Array.isArray(results)) throw new Error(`Unexpected MVG response when looking up ${name}`);
  // Prefer an exact match: "Silberhornstraße" also finds "Silberhorn-/Ichostraße"
  const station =
    results.find((r) => r.name?.toLowerCase() === name.toLowerCase() && r.globalId) ??
    results.find((r) => r.globalId);
  if (!station) throw new Error(`MVG knows no station called ${name}`);
  console.log(`MVG station ${JSON.stringify(name)} is ${station.name} (${station.globalId})`);
  return { id: station.globalId, name: station.name };
}

/** The station `{ id, name }` for a station name, looked up once. Throws if it can't be found. */
async function findStation(name) {
  let entry = stations.get(name);
  if (!entry) stations.set(name, (entry = {}));
  if (!entry.station && !entry.pending && !(entry.failedAt > Date.now() - LOOKUP_RETRY_MS)) {
    entry.pending = lookUpStation(name)
      .then((station) => (entry.station = station))
      .catch((error) => {
        console.error(`Looking up MVG station ${name} failed: ${error.message}`);
        entry.failedAt = Date.now();
      })
      .finally(() => (entry.pending = undefined));
  }
  await entry.pending;
  if (!entry.station) throw new Error(`Station ${name} not found yet`);
  return entry.station;
}

const departureCache = new Map();

// More than fit on the screen, so the next departure on the same line and direction is usually
// among them, even for lines that run every 20 minutes
async function fetchDepartures(stationId) {
  const data = await getJson(`${BASE_URL}/departures?globalId=${encodeURIComponent(stationId)}&limit=100&transportTypes=${TRANSPORT_TYPES}`);
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
        .toSorted((a, b) => (b.type === "EARLY_TERMINATION") - (a.type === "EARLY_TERMINATION"))
        .map((info) => info.message)
        .filter(Boolean),
    }))
    .filter((d) => Number.isFinite(d.time))
    .sort((a, b) => a.time - b.time); // MVG doesn't sort by the actual (realtime) departure
}

/**
 * The latest departures for a station, given by name: `{ station, departures, fetchedAt, error }`.
 * Fetches again if the cached list is older than a minute; if that fails, keeps the old list and
 * sets `error`. `station` is `{ id, name }`, or undefined if the name couldn't be looked up yet.
 */
export async function departuresFor(stationName) {
  let station;
  try {
    station = await findStation(stationName);
  } catch (error) {
    return { error };
  }

  let entry = departureCache.get(station.id);
  if (!entry) departureCache.set(station.id, (entry = {}));

  if (!entry.departures || Date.now() - entry.fetchedAt >= MAX_AGE_MS) {
    // Requests arriving while a fetch is running wait for that one
    entry.pending ??= fetchDepartures(station.id)
      .then((departures) => Object.assign(entry, { departures, fetchedAt: Date.now(), error: undefined }))
      .catch((error) => {
        console.error(`Fetching departures for ${station.name} failed: ${error.message}`);
        entry.error = error;
      })
      .finally(() => (entry.pending = undefined));
    await entry.pending;
  }

  return { station, departures: entry.departures, fetchedAt: entry.fetchedAt, error: entry.error };
}

const directCache = new Map();

// MVG's route search returns its few best connections (5 at a time), possibly with changes. The
// direct ones of the wanted transport type answer "the next S-Bahn to Ostbahnhof", including trains
// that end there (which never appear in the target's own departures).
async function fetchNextDirect(from, to, types) {
  const query = new URLSearchParams({
    originStationGlobalId: from.id,
    destinationStationGlobalId: to.id,
    routingDateTime: new Date().toISOString(),
    routingDateTimeIsArrival: "false",
  });
  const routes = await getJson(`${BASE_URL}/routes?${query}`);
  if (!Array.isArray(routes)) throw new Error(`Unexpected MVG response for routes to ${to.name}`);

  const direct = routes
    .map((route) => route.parts ?? [])
    .filter((parts) => parts.length === 1 && types.includes(parts[0].line?.transportType) && !parts[0].isCancelled)
    .map(([part]) => {
      const planned = Date.parse(part.from.plannedDeparture);
      return {
        // Same fields as a departure, so it can be found in (and shown like) the departures list
        line: String(part.line.trainType || part.line.label || "?"),
        type: part.line.transportType,
        destination: String(part.line.destination ?? ""),
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
 * station to another, both given by name: `{ target, connections, error }`. `connections` are shaped
 * like departures, earliest first (several, since the first may have left by the time it's shown).
 * Cached like the departures; if a fetch fails, the last result is kept and `error` set.
 */
export async function nextDirectFor(stationName, targetName, types) {
  let from, to;
  try {
    [from, to] = await Promise.all([findStation(stationName), findStation(targetName)]);
  } catch (error) {
    return { target: targetName, error };
  }

  const key = `${from.id}|${to.id}|${[...types].sort().join("|")}`;
  let entry = directCache.get(key);
  if (!entry) directCache.set(key, (entry = {}));

  if (entry.connections === undefined || Date.now() - entry.fetchedAt >= MAX_AGE_MS) {
    entry.pending ??= fetchNextDirect(from, to, types)
      .then((connections) => Object.assign(entry, { connections, fetchedAt: Date.now(), error: undefined }))
      .catch((error) => {
        console.error(`Fetching the next ${types.join("/")} from ${from.name} to ${to.name} failed: ${error.message}`);
        entry.error = error;
      })
      .finally(() => (entry.pending = undefined));
    await entry.pending;
  }

  return { target: to.name, connections: entry.connections ?? [], error: entry.error };
}
