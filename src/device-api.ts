// The routes the TRMNL firmware calls. See the Protocol section of README.md for what it expects.
//
// Rejected requests get an HTTP error status: the firmware then shows an error screen and keeps its
// token and Wi-Fi. Never answer with a body status of 500 or reset_firmware: true, which make it
// wipe all its settings, Wi-Fi included.
import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { findDeviceByMac, serverDomain, setupEnabled, type Device } from "./config.ts";
import { authenticateDevice, deviceToken, friendlyId } from "./device-auth.ts";
import { renderPng } from "./render.ts";
import { renderDeviceScreen } from "./screen.ts";
import { Paired } from "./screens/paired.tsx";
import { buttonStep, pressButton, recordCheckIn } from "./device-state.ts";
import { recordTelemetry } from "./telemetry.ts";

export const deviceApi = express.Router();

// The firmware only sends its token with the image request if the image URL starts with exactly
// the server URL configured on the device, so prefer the configured SERVER_DOMAIN.
const baseUrl = (req: Request) => serverDomain ?? `${req.protocol}://${req.get("host")}`;

// Sets res.locals.device for the routes after it
function requireDevice(req: Request, res: Response<unknown, { device: Device }>, next: NextFunction) {
  const device = authenticateDevice(req);
  if (!device) {
    console.log(`Rejected ${req.method} ${req.path} from ${req.get("ID") ?? "a device without ID"}`);
    return res.status(401).type("text").send("Unknown device or wrong token\n");
  }
  res.locals.device = device;
  next();
}

type DeviceResponse = Response<unknown, { device: Device }>;

// The last few images rendered for each device, by filename. A device downloads its image right
// after /api/display, so only recent ones are needed.
const images = new Map<string, Map<string, Buffer>>();
const IMAGES_KEPT = 3;

function rememberImage(device: Device, filename: string, png: Buffer) {
  const forDevice = images.get(device.mac) ?? new Map();
  forDevice.delete(filename);
  forDevice.set(filename, png);
  while (forDevice.size > IMAGES_KEPT) forDevice.delete(forDevice.keys().next().value!);
  images.set(device.mac, forDevice);
}

deviceApi.get("/api/setup", (req, res) => {
  const mac = req.get("ID") ?? "";
  const device = mac && findDeviceByMac(mac);
  // HTTP 200 with a body status of 404 makes the firmware show "MAC not registered" with this
  // message, and try again in 15 minutes. It keeps its Wi-Fi.
  if (!setupEnabled || !device) {
    console.log(`Refused setup for ${mac || "a device without ID"}: ${setupEnabled ? "unknown MAC" : "setup is disabled"}`);
    return res.json({
      status: 404,
      api_key: null,
      friendly_id: null,
      image_url: null,
      message: setupEnabled ? `Device ${mac} is not registered` : "Setup is not enabled on this server",
    });
  }
  console.log(`Paired ${device.username} (${device.mac})`);
  res.json({
    status: 200,
    api_key: deviceToken(device),
    friendly_id: friendlyId(device),
    image_url: `${baseUrl(req)}/setup.png`,
    filename: "setup",
    message: `Paired as ${device.username}`,
  });
});

let pairedPng: Buffer | undefined;

// Downloaded by the firmware right after setup, without its token, so it must be public. It shows
// nothing about any device.
deviceApi.get("/setup.png", async (req, res) => {
  pairedPng ??= await renderPng(Paired());
  res.type("png").send(pairedPng);
});

// The button's special function (double click or 1–5 s hold) that the firmware is told to use, and
// that the server treats as "back": the firmware runs whichever one the server last sent, and
// guest_mode is the one that downloads image_url and takes refresh_rate like a normal check-in.
// (rewind would fit by name, but only redraws the device's previous image from flash.)
const BACK_FUNCTION = "guest_mode";

// The shortest sleep we ask for, e.g. when a request arrives just before the screen changes
const MIN_REFRESH_RATE = 5;

/**
 * Seconds the device should sleep: until the screen changes, but at least every refreshRate seconds.
 * The firmware starts its sleep timer only after downloading and drawing the image, so subtract the
 * time it was awake in its last cycle (Wake-Time, in ms); otherwise every wake lands that much late.
 */
function refreshRate(req: Request, device: Device, ttl: number) {
  const wakeMs = Number(req.get("Wake-Time"));
  const wakeSeconds = Number.isFinite(wakeMs) && wakeMs > 0 ? Math.min(wakeMs / 1000, 120) : 0;
  return Math.min(device.refreshRate, Math.max(Math.round(ttl - wakeSeconds), MIN_REFRESH_RATE));
}

deviceApi.get("/api/display", requireDevice, async (req, res: DeviceResponse) => {
  const device = res.locals.device;
  // Before rendering, so the screen shows the readings from this very wake
  recordTelemetry(device, req);
  // KEY3: a short press moves to the next playlist entry, the special function back to the previous
  const step = buttonStep(req.get("Update-Source"), req.get("special_function"));
  if (step) pressButton(device, step, req.get("Wake-Time"));
  const { png, ttl, index } = await renderDeviceScreen(device);
  // Named after its content: the firmware skips the download and the redraw if it's unchanged
  const filename = createHash("sha256").update(png).digest("hex").slice(0, 16);
  rememberImage(device, filename, png);
  const sleep = refreshRate(req, device, ttl);
  // So the screen page can say when the device will pick up a change, and KEY3 knows what the
  // device shows: what it was sent, as the firmware doesn't confirm it. (A Next pressed while this
  // rendered isn't in this image: it only shows from the check-in after.)
  recordCheckIn(device, sleep, index);
  res.json({
    status: 0,
    image_url: `${baseUrl(req)}/images/${filename}.png`,
    filename,
    refresh_rate: sleep,
    update_firmware: false,
    firmware_url: null,
    reset_firmware: false,
    // Saved by the firmware for the next special function; answering one, it needs its name here
    special_function: BACK_FUNCTION,
    ...(step < 0 && { action: BACK_FUNCTION }),
    // A full refresh on every update, rather than the partial refreshes the firmware uses for
    // black-and-white images (which flash less, but leave traces on the DIY kit)
    maximum_compatibility: device.fullRefresh,
    // Saved by the firmware and used from its next wake on; leaving it out means "default"
    ...(device.temperatureProfile && { temperature_profile: device.temperatureProfile }),
  });
});

deviceApi.get("/images/:name", requireDevice, (req: Request<{ name: string }>, res: DeviceResponse) => {
  const png = images.get(res.locals.device.mac)?.get(req.params.name.replace(/\.png$/, ""));
  if (!png) return res.status(404).type("text").send("No such image\n");
  // The firmware needs exactly "image/png" to decode it as a PNG, and a Content-Length to stream it
  res.type("png").set("Cache-Control", "no-store").send(png);
});

// Sent by the firmware after a failure. Accepted and dropped for now; a live log stream comes later.
deviceApi.post("/api/log", requireDevice, express.json({ limit: "256kb" }), (req, res) => {
  res.status(204).end();
});
