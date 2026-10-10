// Data sources, and how screens and sources declare what they depend on.
//
// A source is defined with defineSource({ name, params, dependencies, load }) and called like a
// function with one parameters object. Its dependencies are other sources, declared as
// `name: [source, params]` and resolved before `load` runs, so `load` gets their results.
//
// Sources cache for themselves for now (see sources/mvg.ts). The framework knows every source by
// name and parameters, so it could take caching over later.

/** A data source: called with one parameters object. */
export interface Source<P, T> {
  (params: P): Promise<T>;
  /** e.g. "mvg.departures", for logs (and, later, cache keys) */
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
 * Declares a source's params type, as `params: paramsOf<{ station: string }>()`. Only for the
 * types: the source's dependencies need it before anything else can be inferred.
 */
export const paramsOf = <P>() => undefined as P;

/**
 * Defines a source. `load` gets the params and the results of the dependencies, whose params are
 * computed from `{ params }`.
 */
export function defineSource<P, T, const D extends AnyDependencies = {}>(definition: {
  name: string;
  params: P;
  dependencies?: D & CheckedDependencies<D, { params: P }>;
  load: (params: P, dependencies: ResolvedDependencies<D>) => Promise<T>;
}): Source<P, T> {
  const source = async (params: P) =>
    definition.load(params, await resolveDependencies<D, { params: P }>(definition.dependencies, { params }));
  return Object.assign(source, { sourceName: definition.name });
}
