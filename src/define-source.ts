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

/** A data source: called with one parameters object. */
export interface Source<P, T> {
  (params: P): Promise<T>;
  /** e.g. "mvg.departures", for logs */
  readonly sourceName: string;
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
      const params =
        typeof spec === "function"
          ? (spec as (context: C) => unknown)(context)
          : Object.fromEntries(
              Object.entries(spec as Record<string, (context: C) => unknown>).map(([field, get]) => [field, get(context)]),
            );
      return [name, Array.isArray(params) ? await Promise.all(params.map(call)) : await call(params)] as const;
    }),
  );
  return Object.fromEntries(entries) as ResolvedDependencies<D>;
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
  /** A load in progress: requests arriving meanwhile wait for it */
  pending?: Promise<T>;
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

  async function refresh(key: string, params: P, previous: { value: T } | undefined): Promise<T> {
    try {
      const dependencies = await resolveDependencies<D, { params: P }>(definition.dependencies, { params });
      const value = await definition.load(params, dependencies, previous?.value);
      cache.set(key, { result: { value }, expiresAt: Date.now() + maxAgeOf(value) });
      return value;
    } catch (error) {
      // Nothing new cached: the next request tries again, still with the previous result
      if (previous) cache.set(key, { result: previous, expiresAt: 0 });
      else cache.delete(key);
      throw error;
    }
  }

  const source = async (params: P): Promise<T> => {
    const key = canonicalKey(definition.cacheKey ? definition.cacheKey(params) : params);
    const entry = cache.get(key);
    if (entry?.pending) return entry.pending;
    if (entry?.result && Date.now() < entry.expiresAt) return entry.result.value;
    const pending = refresh(key, params, entry?.result);
    cache.set(key, { result: entry?.result, expiresAt: 0, pending });
    return pending;
  };
  return Object.assign(source, { sourceName: definition.name });
}
