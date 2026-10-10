// What a screen is: every file in src/screens/ default-exports defineScreen({ ... }). The types tie
// a screen's parts together (the inputs' values follow from their definitions, `data` from what
// `load` returns), and screen.ts checks at startup that each default export came from here.
//
// Kept apart from screen.ts, which imports every screen: a screen importing screen.ts would be a
// circular import.
import { inspect } from "node:util";
import type { VNode } from "preact";
import type { Telemetry } from "./telemetry.ts";

/** A screen setting, with the type of its value and the value used when none is given. */
export type InputDefinition =
  | { type: "string"; default: string }
  | { type: "number"; default: number }
  | { type: "boolean"; default: boolean }
  // Edited one entry per line in the dev server
  | { type: "list"; default: readonly string[] };

export type InputDefinitions = Record<string, InputDefinition>;

// By type rather than from the default, which is inferred as a literal ("Marienplatz", not string)
type InputValue<D extends InputDefinition> = D extends { type: "string" }
  ? string
  : D extends { type: "number" }
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

/** Inputs for `load` */
export interface LoadProps<I extends InputDefinitions> {
  device: ScreenDevice;
  now: Date;
  telemetry: Telemetry | undefined;
  inputs: InputValues<I>;
}

/** Inputs for `view` and `ttl` */
export interface ViewProps<I extends InputDefinitions, D> extends LoadProps<I> {
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

/** A screen that fetches data: `load` returns it, and `view` and `ttl` get it as props.data. */
export interface DefinitionWithLoad<I extends InputDefinitions, D> extends CommonDefinition<I, D> {
  load: (props: LoadProps<I>) => Promise<D>;
}

/** A screen without data: props.data is undefined. */
export interface DefinitionWithoutLoad<I extends InputDefinitions> extends CommonDefinition<I, undefined> {
  load?: undefined;
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
  render: (props: RenderProps) => Promise<{ layout: VNode; ttl: number }>;
}

// Whether a value has the type its definition asks for
function matches(definition: InputDefinition, value: unknown) {
  switch (definition.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
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
    const valid = value !== undefined && matches(definition, value);
    if (value !== undefined && !valid) {
      console.error(`Input ${name} should be a ${definition.type}, not ${inspect(value)}: using its default`);
    }
    const resolved = valid ? value : definition.default;
    // A copy, so a screen changing its list can't change the default
    inputs[name] = Array.isArray(resolved) ? [...resolved] : resolved;
  }
  // Built field by field, which the type checker can't follow: each value has the type its
  // definition asks for
  return inputs as InputValues<I>;
}

// Every screen made by defineScreen, so screen.ts can tell a screen from any other default export
const defined = new WeakSet<object>();

/**
 * Defines a screen. Infers the types of its inputs from `inputs` and of `data` from `load`, and
 * checks `view` and `ttl` against them.
 */
export function defineScreen<const I extends InputDefinitions = {}, D = undefined>(definition: DefinitionWithLoad<I, D>): Screen;
export function defineScreen<const I extends InputDefinitions = {}>(definition: DefinitionWithoutLoad<I>): Screen;
export function defineScreen<I extends InputDefinitions, D>(definition: DefinitionWithLoad<I, D> | DefinitionWithoutLoad<I>): Screen {
  const screen: Screen = {
    inputs: definition.inputs ?? {},
    colors: definition.colors ?? 4,
    async render({ device, now, telemetry, inputs }) {
      const props: LoadProps<I> = {
        device,
        now,
        telemetry,
        inputs: resolveInputs(definition.inputs, inputs),
      };
      if (definition.load) {
        const viewProps = { ...props, data: await definition.load(props) };
        return { layout: definition.view(viewProps), ttl: definition.ttl(viewProps) };
      }
      const viewProps = { ...props, data: undefined };
      return { layout: definition.view(viewProps), ttl: definition.ttl(viewProps) };
    },
  };
  defined.add(screen);
  return screen;
}

export const isScreen = (value: unknown): value is Screen =>
  typeof value === "object" && value !== null && defined.has(value);
