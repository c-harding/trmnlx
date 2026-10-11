// What a screen is: every file in src/screens/ default-exports defineScreen({ ... }). The types tie
// a screen's parts together (the inputs' values follow from their definitions, the dependencies'
// params are checked against their sources, `data` is what `prepare` returns), and screen.ts checks
// at startup that each default export came from here.
//
// Kept apart from screen.ts, which imports every screen: a screen importing screen.ts would be a
// circular import.
import { inspect } from "node:util";
import type { VNode } from "preact";
import {
  resolveDependenciesWithExpiry,
  warmDependencies,
  type AnyDependencies,
  type CheckedDependencies,
  type ResolvedDependencies,
} from "./define-source.ts";
import { SAFETY_SECONDS } from "./time.ts";
import type { Telemetry } from "./telemetry.ts";

/** A screen setting, with the type of its value and the value used when none is given. */
export type InputDefinition =
  | { type: "string"; default: string }
  | { type: "number"; default: number }
  // A whole number, e.g. how many rows to show
  | { type: "int"; default: number }
  | { type: "boolean"; default: boolean }
  // Edited one entry per line in the dev server
  | { type: "list"; default: readonly string[] };

export type InputDefinitions = Record<string, InputDefinition>;

// By type rather than from the default, which is inferred as a literal ("Marienplatz", not string)
type InputValue<D extends InputDefinition> = D extends { type: "string" }
  ? string
  : D extends { type: "number" | "int" }
    ? number
    : D extends { type: "boolean" }
      ? boolean
      : string[];

/** The values of a screen's inputs, e.g. { station: string } for { station: { type: "string", … } }. */
export type InputValues<I extends InputDefinitions> = { [K in keyof I]: InputValue<I[K]> };

/** What screens need to know about the device: also met by the dev server's made-up device. */
export interface ScreenDevice {
  username: string;
  timeZone: string;
}

/** What every part of a screen gets, and the context for its dependencies' params */
export interface ScreenProps<I extends InputDefinitions> {
  device: ScreenDevice;
  now: Date;
  telemetry: Telemetry | undefined;
  inputs: InputValues<I>;
}

/** What `prepare` gets: also the results of the dependencies */
export interface PrepareProps<I extends InputDefinitions, Deps> extends ScreenProps<I> {
  dependencies: ResolvedDependencies<Deps>;
}

/** What `view` and `ttl` get: also what `prepare` returned (undefined without `prepare`) */
export interface ViewProps<I extends InputDefinitions, D> extends ScreenProps<I> {
  data: D;
}

interface CommonDefinition<I extends InputDefinitions, D> {
  /** Its settings, e.g. { station: { type: "string", default: "Marienplatz" } } */
  inputs?: I;
  /** 2 (black and white) or 4 grays (default) */
  colors?: 2 | 4;
  /** Seconds the screen stays valid, Infinity if it never changes */
  ttl: (props: ViewProps<I, D>) => number;
  /** The layout, in JSX */
  view: (props: ViewProps<I, D>) => VNode;
}

/**
 * A screen with data: its dependencies (sources, with params computed from the props) are resolved
 * first, then `prepare` turns their results into `data` for `view` and `ttl`, which don't see the
 * dependencies themselves.
 */
export interface DefinitionWithData<I extends InputDefinitions, Deps extends AnyDependencies, D>
  extends CommonDefinition<I, D> {
  dependencies?: Deps & CheckedDependencies<Deps, ScreenProps<I>>;
  /** Synchronous: anything that waits belongs in a source */
  prepare: (props: PrepareProps<I, Deps>) => D;
}

/** A screen without data: props.data is undefined. */
export interface DefinitionWithoutData<I extends InputDefinitions> extends CommonDefinition<I, undefined> {
  dependencies?: undefined;
  prepare?: undefined;
}

/** What screen.ts passes to a screen's `render`. */
export interface RenderProps {
  device: ScreenDevice;
  now: Date;
  telemetry: Telemetry | undefined;
  /** Raw values, e.g. from the dev server's form; resolved against the screen's own definitions */
  inputs: Record<string, unknown>;
}

/**
 * A screen as screen.ts sees it. `render` runs the screen's own parts in order, so its types never
 * need to leave defineScreen.
 */
export interface Screen {
  inputs: InputDefinitions;
  colors: 2 | 4;
  /** The layout, how long it stays valid (s), and how long loading its data took (ms) */
  render: (props: RenderProps) => Promise<{ layout: VNode; ttl: number; loadMs: number }>;
  /**
   * Warms the sources a render with these props would use (see Source.warm), without rendering
   * or waiting: so it can be shown without waiting for slow data.
   */
  warm: (props: RenderProps) => void;
}

/** What an input's definition asks for, for messages: e.g. "a string", "a whole number". */
export function inputTypeName(definition: InputDefinition) {
  switch (definition.type) {
    case "int":
      return "a whole number";
    case "list":
      return "a list of strings";
    default:
      return `a ${definition.type}`;
  }
}

/** Whether a value has the type an input's definition asks for. */
export function matchesInput(definition: InputDefinition, value: unknown) {
  switch (definition.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "int":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
}

/**
 * The values for a screen's inputs: the given ones where they have the right type, defaults for
 * the rest. Converting text (e.g. from a form) is up to the caller; a value of the wrong type is
 * logged and replaced by the default.
 */
export function resolveInputs<I extends InputDefinitions>(
  definitions: I | undefined,
  given: Record<string, unknown>,
): InputValues<I> {
  const inputs: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries<InputDefinition>(definitions ?? {})) {
    const value = given[name];
    const valid = value !== undefined && matchesInput(definition, value);
    if (value !== undefined && !valid) {
      console.error(`Input ${name} should be ${inputTypeName(definition)}, not ${inspect(value)}: using its default`);
    }
    const resolved = valid ? value : definition.default;
    // A copy, so a screen changing its list can't change the default
    inputs[name] = Array.isArray(resolved) ? [...resolved] : resolved;
  }
  // Built field by field, which the type checker can't follow: each value has the type its
  // definition asks for
  return inputs as InputValues<I>;
}

// Data shown stale is replaced in the background: the screen is asked for again this soon (s)
const STALE_TTL = 15;
// Otherwise data never makes a screen valid for less than this (s): a screen that changes every
// minute anyway has data that lasts a little under a minute, and would otherwise be asked for twice
// (with the same margin as untilNextMinute, so a minute screen keeps its whole ttl)
const MIN_DATA_TTL = 60 + SAFETY_SECONDS;

/**
 * A screen's ttl (s), capped by its data: no longer than until the earliest of its sources'
 * results expires (but at least MIN_DATA_TTL), and at most STALE_TTL if one was shown stale. So a
 * screen with a long ttl still shows new data once its sources have it.
 */
export function dataTtl(ttl: number, expiresAt: number, stale: boolean, now: Date) {
  if (stale) return Math.min(ttl, STALE_TTL);
  if (expiresAt === Infinity) return ttl;
  return Math.min(ttl, Math.max(Math.ceil((expiresAt - now.getTime()) / 1000), MIN_DATA_TTL));
}

// Every screen made by defineScreen, so screen.ts can tell a screen from any other default export
const defined = new WeakSet<object>();

/**
 * Defines a screen. Infers the types of its inputs from `inputs`, of its dependencies' results from
 * their sources and of `data` from `prepare`, and checks everything that uses them.
 */
export function defineScreen<const I extends InputDefinitions = {}, const Deps extends AnyDependencies = {}, D = undefined>(
  definition: DefinitionWithData<I, Deps, D>,
): Screen;
export function defineScreen<const I extends InputDefinitions = {}>(definition: DefinitionWithoutData<I>): Screen;
export function defineScreen<I extends InputDefinitions, Deps extends AnyDependencies, D>(
  definition: DefinitionWithData<I, Deps, D> | DefinitionWithoutData<I>,
): Screen {
  const screen: Screen = {
    inputs: definition.inputs ?? {},
    colors: definition.colors ?? 4,
    async render({ device, now, telemetry, inputs }) {
      const props: ScreenProps<I> = {
        device,
        now,
        telemetry,
        inputs: resolveInputs(definition.inputs, inputs),
      };
      if (definition.prepare) {
        const start = performance.now();
        const { dependencies, expiresAt, stale } = await resolveDependenciesWithExpiry<Deps, ScreenProps<I>>(definition.dependencies, props);
        const loadMs = performance.now() - start;
        const viewProps = { ...props, data: definition.prepare({ ...props, dependencies }) };
        return { layout: definition.view(viewProps), ttl: dataTtl(definition.ttl(viewProps), expiresAt, stale, now), loadMs };
      }
      const viewProps = { ...props, data: undefined };
      return { layout: definition.view(viewProps), ttl: definition.ttl(viewProps), loadMs: 0 };
    },
    warm({ device, now, telemetry, inputs }) {
      warmDependencies(definition.dependencies, { device, now, telemetry, inputs: resolveInputs(definition.inputs, inputs) });
    },
  };
  defined.add(screen);
  return screen;
}

export const isScreen = (value: unknown): value is Screen =>
  typeof value === "object" && value !== null && defined.has(value);
