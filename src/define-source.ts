// Data sources, and how screens and sources declare what they depend on.
//
// A source is defined with defineSource({ name, params, dependencies, load, maxAge, cacheKey })
// and called like a function with one parameters object. Its dependencies are other sources,
// declared as `name: [source, params]` and resolved before `load` runs, so `load` gets their
// results.
//
// Results are cached per source and cache key for `maxAge`. The key is the params, or what the
// source's `cacheKey` makes of them (e.g. with a list sorted), compared deeply. An expired result
// stays: the next load gets it as `previous`, e.g. to fall back to when a fetch fails. So params
// should be few and stable (a station, a route), never e.g. the current time.
//
// A slow source can declare `staleUntil`: an expired result is then still shown until then while
// the next one loads in the background, and `warm` loads one ahead of need (see screen.ts) once
// there's none that can be shown.

/** A data source: called with one parameters object. */
export interface Source<P, T> {
  (params: P): Promise<T>;
  /** e.g. "mvg.departures", for logs */
  readonly sourceName: string;
  /**
   * Starts loading in the background if there's no result that can be shown (none yet, or one
   * both expired and past its `staleUntil`), so a later call needn't wait. Only for sources with `staleUntil`: the
   * others are fast enough to load when needed.
   */
  warm(params: P): void;
  /** Like calling the source, with when the result expires and whether it was shown stale. */
  withExpiry(params: P): Promise<Fetched<T>>;
}

/** A source's result, with what a screen needs to know how long it stays valid. */
export interface Fetched<T> {
  value: T;
  /**
   * When it expires (ms since the epoch): Infinity if kept until restart. The source's own expiry:
   * its dependencies' are part of its `maxAge` if they matter.
   */
  expiresAt: number;
  /** Already expired, shown while the next one loads (see staleUntil) */
  stale: boolean;
}

/**
 * How a dependency gets its parameters, from a context (a screen's props, or a source's
 * `{ params }`): one function per field, or one function for the whole object. If that function
 * returns an array, the source is called once per entry and the dependency resolves to an array.
 */
export type ParamsSpec<P, C> = { [K in keyof P]: (context: C) => P[K] } | ((context: C) => P | readonly P[]);

// Any source. Its result is `unknown` rather than `any`, so a dependency whose type can't be
// inferred shows up as an error instead of switching off the checks (params need `any`: with
// `never`, TypeScript can't infer them from the source any more)
type AnyDependency = readonly [Source<any, unknown>, unknown];
export type AnyDependencies = Record<string, AnyDependency>;

/** Checks each dependency's params against its source's, with C as the context. */
export type CheckedDependencies<D, C> = {
  [K in keyof D]: D[K] extends readonly [Source<infer P, infer T>, unknown] ? readonly [Source<P, T>, ParamsSpec<P, C>] : never;
};

/** The results of resolved dependencies: the source's result, or an array of them for array params. */
export type ResolvedDependencies<D> = {
  [K in keyof D]: D[K] extends readonly [Source<never, infer T>, infer S]
    ? S extends (...args: never[]) => readonly unknown[]
      ? T[]
      : T
    : never;
};

/**
 * Resolves dependencies with the given context: computes each one's params, calls the sources in
 * parallel and returns their results by name. A source that throws makes this throw: sources
 * return values (such as null) for failures a screen should show.
 */
export async function resolveDependencies<D extends AnyDependencies, C>(
  dependencies: D | undefined,
  context: C,
): Promise<ResolvedDependencies<D>> {
  const entries = await Promise.all(
    Object.entries(dependencies ?? {}).map(async ([name, [source, spec]]) => {
      // Typed by CheckedDependencies where the dependencies are declared; here they're erased
      const call = source as unknown as (params: unknown) => Promise<unknown>;
      const params = paramsFor(spec, context);
      return [name, Array.isArray(params) ? await Promise.all(params.map(call)) : await call(params)] as const;
    }),
  );
  return Object.fromEntries(entries) as ResolvedDependencies<D>;
}

/**
 * Like resolveDependencies, also giving when the earliest result expires and whether any was shown
 * stale: so a screen knows how long what it shows stays valid.
 */
export async function resolveDependenciesWithExpiry<D extends AnyDependencies, C>(
  dependencies: D | undefined,
  context: C,
): Promise<{ dependencies: ResolvedDependencies<D>; expiresAt: number; stale: boolean }> {
  let expiresAt = Infinity;
  let stale = false;
  const entries = await Promise.all(
    Object.entries(dependencies ?? {}).map(async ([name, [source, spec]]) => {
      const fetch = async (params: unknown) => {
        const fetched = await source.withExpiry(params);
        expiresAt = Math.min(expiresAt, fetched.expiresAt);
        stale ||= fetched.stale;
        return fetched.value;
      };
      const params = paramsFor(spec, context);
      return [name, Array.isArray(params) ? await Promise.all(params.map(fetch)) : await fetch(params)] as const;
    }),
  );
  return { dependencies: Object.fromEntries(entries) as ResolvedDependencies<D>, expiresAt, stale };
}

/** Warms dependencies (see Source.warm) with the given context, without waiting for anything. */
export function warmDependencies<C>(dependencies: AnyDependencies | undefined, context: C) {
  for (const [source, spec] of Object.values(dependencies ?? {})) {
    const params = paramsFor(spec, context);
    for (const each of Array.isArray(params) ? params : [params]) source.warm(each);
  }
}

/** A dependency's params from the context: an object, or an array for one call per entry. */
function paramsFor<C>(spec: unknown, context: C): unknown {
  return typeof spec === "function"
    ? (spec as (context: C) => unknown)(context)
    : Object.fromEntries(Object.entries(spec as Record<string, (context: C) => unknown>).map(([field, get]) => [field, get(context)]));
}

/**
 * A canonical string for a cache key, equal for deeply equal keys: object keys sorted, undefined
 * fields left out, Dates as ISO strings (like JSON). Keys must be plain JSON data (objects,
 * arrays, strings, finite numbers, booleans, null) or Dates: NaN gives the same key as null, and a
 * Map or Set the same as {}. A key of undefined gives "undefined", shared by all such params.
 */
export function canonicalKey(key: unknown): string {
  const json = JSON.stringify(key, (_field, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  // JSON.stringify gives undefined for undefined (and functions): one more key, not a missing one
  return json ?? "undefined";
}

interface CacheEntry<T> {
  /** The latest result, if there is one; once expired, it's the next load's `previous` */
  result?: { value: T };
  /** When the result expires (ms since the epoch); Infinity keeps it until restart, 0 while loading */
  expiresAt: number;
  /** A load in progress: requests arriving meanwhile wait for it, and get its result's expiry */
  pending?: Promise<Loaded<T>>;
}

/** A loaded result, and when it expires (ms since the epoch). */
interface Loaded<T> {
  value: T;
  expiresAt: number;
}

/**
 * Declares a source's params type, as `params: paramsOf<{ station: string }>()`. Only for the
 * types: the source's dependencies need it before anything else can be inferred.
 */
export const paramsOf = <P>() => undefined as P;

/**
 * Defines a source. `load` gets the params, the results of the dependencies (whose params are
 * computed from `{ params }`) and the previous result for the same params, if any. Its result is
 * cached for `maxAge`; if it throws, nothing new is cached and the error propagates.
 */
export function defineSource<P, T, const D extends AnyDependencies = {}>(definition: {
  name: string;
  params: P;
  /**
   * How long a result stays valid in ms (Infinity or NaN: until restart), or a function of the result.
   * Write a function after `load`: TypeScript takes the result type from `load`, top to bottom.
   */
  maxAge: number | ((result: NoInfer<T>) => number);
  /**
   * How long before a result expires a request starts loading the next one in the background,
   * while it's answered from the cache: so no request waits for a slow source, as long as one
   * comes in that time. In ms, or a function of the result (e.g. 0 for a failure, which is kept
   * on purpose); without it, results are only loaded again once expired. Write a function after
   * `load`, like `maxAge`.
   */
  refreshAhead?: number | ((result: NoInfer<T>) => number);
  /**
   * Until when (ms since the epoch) an expired result can still be shown: a request then gets it
   * straight away and the next one loads in the background, instead of the request waiting. E.g.
   * journeys until half of them have left. Also makes the source one to warm (see Source.warm).
   * Write it after `load`, like `maxAge`.
   */
  staleUntil?: (result: NoInfer<T>) => number;
  /**
   * What the cache tells apart, made from the params; without it, the params themselves. E.g. with
   * a list sorted, when its order doesn't matter.
   */
  cacheKey?: (params: P) => unknown;
  dependencies?: D & CheckedDependencies<D, { params: P }>;
  load: (params: P, dependencies: ResolvedDependencies<D>, previous: T | undefined) => Promise<T>;
}): Source<P, T> {
  // One entry per cache key, kept until restart: there are only as many as stations or routes
  const cache = new Map<string, CacheEntry<T>>();
  const maxAgeOf = (value: T) => {
    const maxAge = typeof definition.maxAge === "function" ? definition.maxAge(value) : definition.maxAge;
    // NaN means no limit, like Infinity
    return Number.isNaN(maxAge) ? Infinity : maxAge;
  };

  const refreshAheadOf = (value: T) =>
    typeof definition.refreshAhead === "function" ? definition.refreshAhead(value) : (definition.refreshAhead ?? 0);

  const staleUntilOf = (value: T) => definition.staleUntil?.(value) ?? 0;

  /** Loads a result and caches it. On an error, the previous result (if any) stays until `previousExpiresAt`. */
  async function refresh(key: string, params: P, previous: { value: T } | undefined, previousExpiresAt = 0): Promise<Loaded<T>> {
    try {
      const dependencies = await resolveDependencies<D, { params: P }>(definition.dependencies, { params });
      const value = await definition.load(params, dependencies, previous?.value);
      const expiresAt = Date.now() + maxAgeOf(value);
      cache.set(key, { result: { value }, expiresAt });
      return { value, expiresAt };
    } catch (error) {
      // Nothing new cached: the previous result stays as it was, and a later request tries again
      if (previous) cache.set(key, { result: previous, expiresAt: previousExpiresAt });
      else cache.delete(key);
      throw error;
    }
  }

  /** Loads the next result while requests are answered from the cache, or wait for it if there's none. */
  function refreshInBackground(key: string, params: P, entry: CacheEntry<T> | undefined) {
    const pending = refresh(key, params, entry?.result, entry?.expiresAt);
    cache.set(key, { result: entry?.result, expiresAt: entry?.expiresAt ?? 0, pending });
    // Nobody may wait for it: log a failure instead of leaving it unhandled
    pending.catch((error) => console.error(`Refreshing ${definition.name} in the background failed:`, error));
  }

  const keyOf = (params: P) => canonicalKey(definition.cacheKey ? definition.cacheKey(params) : params);

  /** A result once loaded: fresh, with its expiry. */
  const loaded = async (pending: Promise<Loaded<T>>): Promise<Fetched<T>> => ({ ...(await pending), stale: false });

  async function withExpiry(params: P): Promise<Fetched<T>> {
    const key = keyOf(params);
    const entry = cache.get(key);
    const now = Date.now();
    if (entry?.result && now < entry.expiresAt) {
      // About to expire: load the next result in the background, but answer from the cache
      if (!entry.pending && entry.expiresAt - now < refreshAheadOf(entry.result.value)) refreshInBackground(key, params, entry);
      return { value: entry.result.value, expiresAt: entry.expiresAt, stale: false };
    }
    // Expired, but can still be shown: the same, without waiting for the next one
    if (entry?.result && now < staleUntilOf(entry.result.value)) {
      if (!entry.pending) refreshInBackground(key, params, entry);
      return { value: entry.result.value, expiresAt: entry.expiresAt, stale: true };
    }
    if (entry?.pending) return loaded(entry.pending);
    const pending = refresh(key, params, entry?.result);
    cache.set(key, { result: entry?.result, expiresAt: 0, pending });
    return loaded(pending);
  }

  const source = async (params: P): Promise<T> => (await withExpiry(params)).value;

  function warm(params: P) {
    if (!definition.staleUntil) return;
    const key = keyOf(params);
    const entry = cache.get(key);
    if (entry?.pending) return;
    if (entry?.result && Date.now() < Math.max(entry.expiresAt, staleUntilOf(entry.result.value))) return;
    refreshInBackground(key, params, entry);
  }

  return Object.assign(source, { sourceName: definition.name, warm, withExpiry });
}
