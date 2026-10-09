import { createHmac } from "node:crypto";
import { findDeviceByMac, tokenSecret } from "./config.js";
import { safeEqual, sha256 } from "./crypto.js";

/**
 * The token a device must send as Access-Token: the one stored in devices.yaml for a device adopted
 * from another server, otherwise derived from its MAC. The "device-token" label keeps these apart
 * from the session signatures made with the same secret.
 */
export const deviceToken = (device) =>
  device.token ??
  createHmac("sha256", tokenSecret).update(`device-token\n${device.mac}`).digest("base64url").slice(0, 22);

/** A short code the device shows on its screen while pairing. Not secret. */
export const friendlyId = (device) => sha256(device.mac).toString("hex").slice(0, 6).toUpperCase();

/**
 * The device sending this request, identified by its ID header (MAC) and checked against its
 * Access-Token header, or undefined.
 */
export function authenticateDevice(req) {
  const mac = req.get("ID");
  if (!mac) return undefined;
  const device = findDeviceByMac(mac);
  // Compare against something even for unknown MACs, so the timing doesn't reveal which exist
  const matches = safeEqual(req.get("Access-Token") ?? "", device ? deviceToken(device) : "");
  return device && matches ? device : undefined;
}
