import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { screens } from "./screen.ts";

const DEVICES_FILE = new URL("./devices.yaml", import.meta.url);

// The firmware's own default: 15 minutes
const DEFAULT_REFRESH_RATE = 900;

// How the firmware drives the panel. For the 7.5" panel: "default" uses the EP75_800x480 driver,
// "a" the panel's built-in fast and 4-gray modes (EP75_800x480_GEN2), "b" darker grays.
const TEMPERATURE_PROFILES = ["default", "a", "b"] as const;
type TemperatureProfile = (typeof TEMPERATURE_PROFILES)[number];

/** A device from devices.yaml, checked and with defaults filled in. */
export interface Device {
  mac: string;
  username: string;
  password: string;
  token: string | undefined;
  timeZone: string;
  refreshRate: number;
  screen: string;
  temperatureProfile: TemperatureProfile | undefined;
  fullRefresh: boolean;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function checkTimeZone(timeZone: string, source: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    fail(`Unknown time zone ${JSON.stringify(timeZone)} in ${source}`);
  }
  return timeZone;
}

/**
 * The screen for devices that don't name one: devices.yaml's defaultScreen if set, otherwise the
 * placeholder if there is one, otherwise the first screen found.
 */
function chooseDefaultScreen(configured: unknown) {
  const available = Object.keys(screens);
  if (available.length === 0) fail("No screens found next to the server (screens/*.js)");
  if (configured === undefined) return available.includes("placeholder") ? "placeholder" : available[0];
  if (typeof configured !== "string" || !available.includes(configured)) fail(`defaultScreen must be one of ${available.join(", ")}`);
  return configured;
}

function loadDevices(): Device[] {
  let text;
  try {
    text = readFileSync(DEVICES_FILE, "utf8");
  } catch {
    fail(`Could not read ${DEVICES_FILE.pathname}: copy devices.yaml.sample to devices.yaml and run the build`);
  }

  // Checked field by field below
  let data: { devices?: unknown; defaultScreen?: unknown } | undefined;
  try {
    data = parse(text);
  } catch (error) {
    fail(`devices.yaml is not valid YAML: ${(error as Error).message}`);
  }
  if (!Array.isArray(data?.devices) || data.devices.length === 0) {
    fail("devices.yaml must contain a non-empty `devices` list");
  }

  const defaultTimeZone = checkTimeZone(process.env.TZ || "UTC", "TZ");
  const defaultScreen = chooseDefaultScreen(data!.defaultScreen);
  const usernames = new Set<string>();
  const macs = new Set<string>();

  return (data!.devices as Record<string, any>[]).map((device, i) => {
    const where = `devices[${i}]`;
    for (const field of ["mac", "username", "password"]) {
      if (typeof device?.[field] !== "string" || device[field] === "") {
        fail(`${where}.${field} must be a non-empty string (quote MAC addresses)`);
      }
    }
    if (device.token !== undefined && (typeof device.token !== "string" || device.token === "")) {
      fail(`${where}.token must be a non-empty string if set`);
    }
    if (
      device.refreshRate !== undefined &&
      !(Number.isInteger(device.refreshRate) && device.refreshRate >= 60)
    ) {
      fail(`${where}.refreshRate must be a whole number of seconds, at least 60`);
    }
    if (device.screen !== undefined && !Object.hasOwn(screens, device.screen)) {
      fail(`${where}.screen must be one of ${Object.keys(screens).join(", ")}`);
    }
    if (device.temperatureProfile !== undefined && !TEMPERATURE_PROFILES.includes(device.temperatureProfile)) {
      fail(`${where}.temperatureProfile must be one of ${TEMPERATURE_PROFILES.join(", ")}`);
    }
    if (device.fullRefresh !== undefined && typeof device.fullRefresh !== "boolean") {
      fail(`${where}.fullRefresh must be true or false`);
    }
    if (usernames.has(device.username)) fail(`${where}.username ${device.username} is used twice`);
    usernames.add(device.username);
    const mac = device.mac.toUpperCase();
    if (macs.has(mac)) fail(`${where}.mac ${mac} is used twice`);
    macs.add(mac);

    return {
      mac,
      username: device.username,
      password: device.password,
      token: device.token,
      timeZone: device.timezone ? checkTimeZone(device.timezone, `${where}.timezone`) : defaultTimeZone,
      refreshRate: device.refreshRate ?? DEFAULT_REFRESH_RATE,
      screen: device.screen ?? defaultScreen,
      temperatureProfile: device.temperatureProfile,
      // Partial refreshes leave traces of earlier screens on the DIY kit (see ARCHITECTURE.md), so
      // full refreshes are the default until that's understood
      fullRefresh: device.fullRefresh ?? true,
    };
  });
}

function loadTokenSecret(): string {
  const secret = process.env.TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    fail("TOKEN_SECRET must be set to at least 32 characters, e.g. from `openssl rand -base64 32`");
  }
  return secret;
}

export const devices = loadDevices();
export const tokenSecret = loadTokenSecret();

/** Whether /api/setup hands out tokens. Only while pairing a device: the MAC it checks isn't secret. */
export const setupEnabled = process.env.SETUP_ENABLED === "1";

/**
 * The public address, e.g. https://trmnl.charding.dev. Image URLs must start with exactly the URL
 * configured on the device, or the firmware doesn't send its token with the image request.
 */
export const serverDomain = process.env.SERVER_DOMAIN?.replace(/\/+$/, "") || undefined;

export const findDeviceByUsername = (username: string) => devices.find((device) => device.username === username);
export const findDeviceByMac = (mac: string) => devices.find((device) => device.mac === mac.toUpperCase());
