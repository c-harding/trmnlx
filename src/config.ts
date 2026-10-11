import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  ConfigError,
  devicePlaylists,
  readDefaultScreen,
  readLocation,
  readNamedPlaylists,
  type DevicePlaylist,
  type PlaylistEntry,
  type ScreenInputs,
} from "./playlists.ts";
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
  /**
   * What it can show: `default` (its `playlist`) first, then its `playlists`, each at least one
   * entry; the screen page switches between them (see playlists.ts)
   */
  playlists: DevicePlaylist[];
  /** What it shows when no entry of its playlist applies */
  defaultScreen: PlaylistEntry;
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

/** Runs a check from playlists.ts, stopping with its message if it finds a mistake. */
function orFail<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
}

function loadDevices(): Device[] {
  let text;
  try {
    text = readFileSync(DEVICES_FILE, "utf8");
  } catch {
    fail(`Could not read ${DEVICES_FILE.pathname}: copy devices.yaml.sample to devices.yaml and run the build`);
  }

  // Checked field by field below
  let data: { devices?: unknown; defaultScreen?: unknown; playlists?: unknown; location?: unknown } | undefined;
  try {
    data = parse(text);
  } catch (error) {
    fail(`devices.yaml is not valid YAML: ${(error as Error).message}`);
  }
  if (!Array.isArray(data?.devices) || data.devices.length === 0) {
    fail("devices.yaml must contain a non-empty `devices` list");
  }

  const defaultTimeZone = checkTimeZone(process.env.TZ || "UTC", "TZ");
  const screenInputs: ScreenInputs = Object.fromEntries(Object.entries(screens).map(([name, screen]) => [name, screen.inputs]));
  const defaultScreen = orFail(() => readDefaultScreen(data!.defaultScreen, screenInputs));
  const location = orFail(() => readLocation(data!.location, "location"));
  const playlists = orFail(() => readNamedPlaylists(data!.playlists, screenInputs, location));
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
      playlists: orFail(() => {
        // Its own location for holidays, or the top-level one
        const own = readLocation(device.location, `${where}.location`);
        return devicePlaylists(device, where, playlists, screenInputs, defaultScreen, own ?? location);
      }),
      defaultScreen,
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

/**
 * `node server.js --check-config`: only checks the config (devices.yaml, the screens and the
 * environment), then exits. The image build runs it, so a broken config fails the deploy and the
 * running container stays.
 */
export const checkOnly = process.argv.includes("--check-config");

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
