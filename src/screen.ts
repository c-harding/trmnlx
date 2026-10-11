import { readdir } from "node:fs/promises";
import type { Device } from "./config.ts";
import { isScreen, type Screen, type ScreenDevice } from "./define-screen.ts";
import { currentEntry } from "./device-state.ts";
import { renderPng } from "./render.ts";
import { telemetryFor, type Telemetry } from "./telemetry.ts";

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
 * how many seconds it stays valid, and how many colours it uses. Used by the server and the dev
 * server.
 */
export async function renderScreen(screen: Screen, { device, now, telemetry, inputs }: RenderOptions) {
  const { layout, ttl } = await screen.render({ device, now, telemetry, inputs });
  const png = await renderPng(layout, { colors: screen.colors });
  return { png, ttl, colors: screen.colors };
}

/**
 * The device's current screen as a PNG, and how many seconds it stays valid: its current playlist
 * entry, with that entry's inputs. Shared by the device API and the browser preview.
 */
export function renderDeviceScreen(device: Device) {
  const { entry } = currentEntry(device);
  return renderScreen(screens[entry.screen], { device, now: new Date(), telemetry: telemetryFor(device), inputs: entry.inputs });
}
