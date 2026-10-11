import { readdir } from "node:fs/promises";
import type { Device } from "./config.ts";
import { isScreen, type Screen, type ScreenDevice } from "./define-screen.ts";
import { earliest } from "./conditions.ts";
import { currentEntry, entriesNearby, evaluate } from "./device-state.ts";
import { renderPng } from "./render.ts";
import { telemetryFor, type Telemetry } from "./telemetry.ts";
import { SAFETY_SECONDS } from "./time.ts";

// Every file in src/screens/ is a screen, named after the file (helpers belong elsewhere), and
// default-exports defineScreen({ ... }) (see define-screen.ts for what a screen has). The build
// turns each into its own module in screens/ next to the server (esbuild with code splitting, so
// shared code exists once), and they're found and imported here at startup.
//
// Inputs' values come from the device's playlist entry (devices.yaml), or the dev server's form.
const SCREENS_DIR = new URL("./screens/", import.meta.url);

async function importScreen(file: string): Promise<[string, Screen]> {
  const name = file.slice(0, -".js".length);
  const module: { default?: unknown } = await import(new URL(file, SCREENS_DIR).href);
  if (!isScreen(module.default)) throw new Error(`Screen ${name} must export default defineScreen({ ... })`);
  return [name, module.default];
}

export const screens: Record<string, Screen> = Object.fromEntries(
  await Promise.all(
    (await readdir(SCREENS_DIR))
      .filter((file) => file.endsWith(".js"))
      .sort()
      .map(importScreen),
  ),
);

interface RenderOptions {
  device: ScreenDevice;
  now: Date;
  telemetry: Telemetry | undefined;
  inputs: Record<string, unknown>;
}

/**
 * Renders a screen for a device, at a given time and with given telemetry and inputs: the PNG,
 * how many seconds it stays valid, how many colours it uses, its credits, and how long loading its
 * data and rendering took (ms). Used by the server and the dev
 * server.
 */
export async function renderScreen(screen: Screen, { device, now, telemetry, inputs }: RenderOptions) {
  const start = performance.now();
  const { layout, ttl, credits, loadMs } = await screen.render({ device, now, telemetry, inputs });
  const png = await renderPng(layout, { colors: screen.colors });
  // Rendering: everything but loading the data (prepare, the view, Satori and sharp)
  return { png, ttl, colors: screen.colors, credits, loadMs, renderMs: performance.now() - start - loadMs };
}

/**
 * The device's current screen as a PNG, how many seconds it stays valid, and which playlist entry
 * it is (its index): the current entry, with its inputs. Valid at most until the playlist moves on
 * by itself (the entry's `duration`), with the same margin as a minute screen, so a device waking
 * slightly early doesn't arrive just before the move. Shared by the device API and the browser
 * preview.
 */
export async function renderDeviceScreen(device: Device) {
  const now = new Date();
  const { entry, index, untilMove } = currentEntry(device, now);
  const rendered = await renderScreen(screens[entry.screen], { device, now, telemetry: telemetryFor(device), inputs: entry.inputs });
  return { ...rendered, ttl: Math.min(rendered.ttl, untilMove + SAFETY_SECONDS), index };
}

/**
 * Warms the data of the device's current entry and those one press away (the previous and the
 * next that apply), so they can be shown without waiting for slow sources (see Source.warm).
 * Called at startup, at each check-in and each browser render, after each move, and when a `when`
 * window starts or ends (see warmAtWindowChanges).
 */
export function warmDeviceScreens(device: Device) {
  const now = new Date();
  // Only ahead of need: a mistake here mustn't break the startup, a check-in or a render
  try {
    const telemetry = telemetryFor(device);
    for (const entry of entriesNearby(device, now)) screens[entry.screen].warm({ device, now, telemetry, inputs: entry.inputs });
  } catch (error) {
    console.error(`Warming the screens of ${device.username} failed:`, error);
  }
}

// The timer for each device's next window change, by MAC
const windowTimers = new Map<string, NodeJS.Timeout>();
// Without a change within the next day, looked at again then
const RECHECK_MS = 24 * 3600 * 1000;

/**
 * Warms the device's screens again whenever a `when` window of its playlist starts or ends, as that
 * changes which entries are one press away (and may move the playlist on), and keeps doing so.
 */
export function warmAtWindowChanges(device: Device) {
  clearTimeout(windowTimers.get(device.mac));
  if (!device.playlist.some((entry) => entry.when)) return;
  const now = new Date();
  const next = earliest(evaluate(device, now).changes);
  // A second after the change, so it counts as past
  const delay = next ? next.getTime() - now.getTime() + 1000 : RECHECK_MS;
  const timer = setTimeout(() => {
    warmDeviceScreens(device);
    try {
      warmAtWindowChanges(device);
    } catch (error) {
      // Looked at again later rather than never, or crashing the server
      console.error(`Finding the next window change of ${device.username} failed:`, error);
      windowTimers.set(device.mac, setTimeout(() => warmAtWindowChanges(device), RECHECK_MS).unref());
    }
  }, delay);
  // Not a reason to keep the process running
  timer.unref();
  windowTimers.set(device.mac, timer);
}
