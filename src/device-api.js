// The routes the TRMNL firmware calls. See the Protocol section of README.md for what it expects.
//
// Rejected requests get an HTTP error status: the firmware then shows an error screen and keeps its
// token and Wi-Fi. Never answer with a body status of 500 or reset_firmware: true, which make it
// wipe all its settings, Wi-Fi included.
import { createHash } from "node:crypto";
import express from "express";
import { findDeviceByMac, serverDomain, setupEnabled } from "./config.js";
import { authenticateDevice, deviceToken, friendlyId } from "./device-auth.js";
import { renderPng } from "./render.js";
import { renderDeviceScreen } from "./screen.js";
import { view as paired } from "./screens/paired.jsx";

export const deviceApi = express.Router();

// The firmware only sends its token with the image request if the image URL starts with exactly
// the server URL configured on the device, so prefer the configured SERVER_DOMAIN.
const baseUrl = (req) => serverDomain ?? `${req.protocol}://${req.get("host")}`;

function requireDevice(req, res, next) {
  const device = authenticateDevice(req);
  if (!device) {
    console.log(`Rejected ${req.method} ${req.path} from ${req.get("ID") ?? "a device without ID"}`);
    return res.status(401).type("text").send("Unknown device or wrong token\n");
  }
  req.device = device;
  next();
}

// The last few images rendered for each device, by filename. A device downloads its image right
// after /api/display, so only recent ones are needed.
const images = new Map();
const IMAGES_KEPT = 3;

function rememberImage(device, filename, png) {
  const forDevice = images.get(device.mac) ?? new Map();
  forDevice.delete(filename);
  forDevice.set(filename, png);
  while (forDevice.size > IMAGES_KEPT) forDevice.delete(forDevice.keys().next().value);
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

let pairedPng;

// Downloaded by the firmware right after setup, without its token, so it must be public. It shows
// nothing about any device.
deviceApi.get("/setup.png", async (req, res) => {
  pairedPng ??= await renderPng(paired());
  res.type("png").send(pairedPng);
});

deviceApi.get("/api/display", requireDevice, async (req, res) => {
  const device = req.device;
  const png = await renderDeviceScreen(device);
  // Named after its content: the firmware skips the download and the redraw if it's unchanged
  const filename = createHash("sha256").update(png).digest("hex").slice(0, 16);
  rememberImage(device, filename, png);
  res.json({
    status: 0,
    image_url: `${baseUrl(req)}/images/${filename}.png`,
    filename,
    refresh_rate: device.refreshRate,
    update_firmware: false,
    firmware_url: null,
    reset_firmware: false,
  });
});

deviceApi.get("/images/:name", requireDevice, (req, res) => {
  const png = images.get(req.device.mac)?.get(req.params.name.replace(/\.png$/, ""));
  if (!png) return res.status(404).type("text").send("No such image\n");
  // The firmware needs exactly "image/png" to decode it as a PNG, and a Content-Length to stream it
  res.type("png").set("Cache-Control", "no-store").send(png);
});

// Sent by the firmware after a failure. Accepted and dropped for now; a live log stream comes later.
deviceApi.post("/api/log", requireDevice, express.json({ limit: "256kb" }), (req, res) => {
  res.status(204).end();
});
