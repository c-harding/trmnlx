import { readFileSync } from "node:fs";
import { parse } from "yaml";

const DEVICES_FILE = new URL("./devices.yaml", import.meta.url);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function checkTimeZone(timeZone, source) {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    fail(`Unknown time zone ${JSON.stringify(timeZone)} in ${source}`);
  }
  return timeZone;
}

function loadDevices() {
  let text;
  try {
    text = readFileSync(DEVICES_FILE, "utf8");
  } catch {
    fail(`Could not read ${DEVICES_FILE.pathname}: copy devices.yaml.sample to devices.yaml and run the build`);
  }

  let data;
  try {
    data = parse(text);
  } catch (error) {
    fail(`devices.yaml is not valid YAML: ${error.message}`);
  }
  if (!Array.isArray(data?.devices) || data.devices.length === 0) {
    fail("devices.yaml must contain a non-empty `devices` list");
  }

  const defaultTimeZone = checkTimeZone(process.env.TZ || "UTC", "TZ");
  const usernames = new Set();

  return data.devices.map((device, i) => {
    const where = `devices[${i}]`;
    for (const field of ["mac", "username", "password"]) {
      if (typeof device?.[field] !== "string" || device[field] === "") {
        fail(`${where}.${field} must be a non-empty string (quote MAC addresses)`);
      }
    }
    if (device.token !== undefined && (typeof device.token !== "string" || device.token === "")) {
      fail(`${where}.token must be a non-empty string if set`);
    }
    if (usernames.has(device.username)) fail(`${where}.username ${device.username} is used twice`);
    usernames.add(device.username);

    return {
      mac: device.mac.toUpperCase(),
      username: device.username,
      password: device.password,
      token: device.token,
      timeZone: device.timezone ? checkTimeZone(device.timezone, `${where}.timezone`) : defaultTimeZone,
    };
  });
}

function loadTokenSecret() {
  const secret = process.env.TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    fail("TOKEN_SECRET must be set to at least 32 characters, e.g. from `openssl rand -base64 32`");
  }
  return secret;
}

export const devices = loadDevices();
export const tokenSecret = loadTokenSecret();

export const findDeviceByUsername = (username) => devices.find((device) => device.username === username);
