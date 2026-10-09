import { readdir } from "node:fs/promises";
import { renderPng } from "./render.js";
import { telemetryFor } from "./telemetry.js";

// Every file in src/screens/ is a screen, named after the file (helpers belong elsewhere). The
// build turns each into its own module in screens/ next to the server (esbuild with code
// splitting, so shared code exists once), and they're found and imported here at startup.
//
// A screen module exports:
// - view(props) and ttl(props): seconds the screen stays valid, Infinity if it never changes;
// - optionally load(props): async, fetches and caches its data, passed on as props.data;
// - optionally colors: 2 or 4 (default 4);
// - optionally inputs: its settings, e.g. { station: { type: "string", default: "Marienplatz" } },
//   with type "string", "number" or "boolean". The values (on the server, for now always the
//   defaults; in the dev server, from its form) are passed to load, view and ttl as props.inputs,
//   with defaults filled in.
const SCREENS_DIR = new URL("./screens/", import.meta.url);

export const screens = Object.fromEntries(
  await Promise.all(
    (await readdir(SCREENS_DIR))
      .filter((file) => file.endsWith(".js"))
      .sort()
      .map(async (file) => [file.slice(0, -".js".length), await import(new URL(file, SCREENS_DIR).href)]),
  ),
);

export class InputError extends Error {}

/** The values for a screen's inputs: the given ones converted to their type, defaults for the rest. */
export function resolveInputs(definitions = {}, given = {}) {
  const inputs = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const raw = given[name];
    if (raw === undefined || raw === "") {
      inputs[name] = definition.default;
    } else if (definition.type === "number") {
      inputs[name] = Number(raw);
      if (!Number.isFinite(inputs[name])) throw new InputError(`${name} must be a number`);
    } else if (definition.type === "boolean") {
      inputs[name] = raw === true || raw === "true";
    } else {
      inputs[name] = String(raw);
    }
  }
  return inputs;
}

/**
 * Renders a screen for a device, at a given time and with given telemetry and inputs: the PNG,
 * how many seconds it stays valid, and how many colours it uses. Used by the server and the dev
 * server.
 */
export async function renderScreen(screen, { device, now, telemetry, inputs }) {
  const props = {
    device,
    name: device.username,
    now,
    timeZone: device.timeZone,
    telemetry,
    inputs: resolveInputs(screen.inputs, inputs),
  };
  if (screen.load) props.data = await screen.load(props);
  const colors = screen.colors ?? 4;
  const png = await renderPng(screen.view(props), { colors });
  return { png, ttl: screen.ttl(props), colors };
}

/**
 * The device's current screen (device.screen, chosen in config.js) as a PNG, and how many seconds
 * it stays valid. Shared by the device API and the browser preview. Inputs can't be configured per
 * device yet, so screens always get their defaults.
 */
export const renderDeviceScreen = (device) =>
  renderScreen(screens[device.screen], { device, now: new Date(), telemetry: telemetryFor(device), inputs: {} });
