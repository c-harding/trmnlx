import { createHmac } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { findDeviceByUsername, tokenSecret, type Device } from "./config.ts";
import { safeEqual, sha256 } from "./crypto.ts";

export const SESSION_COOKIE = "session";
const SESSION_DAYS = 30;

/** The device whose username and password these are, or undefined. */
export function checkLogin(username: string, password: string) {
  const device = findDeviceByUsername(username);
  // Compare against something even for unknown users, so the timing doesn't reveal which exist
  const matches = safeEqual(password ?? "", device?.password ?? "");
  return device && matches ? device : undefined;
}

// The password hash is part of the signature, so changing a password ends that user's sessions.
// The "session" label keeps these signatures apart from the device tokens derived from the same secret.
const sign = (payload: string, device: Device) =>
  createHmac("sha256", tokenSecret)
    .update(`session\n${payload}\n`)
    .update(sha256(device.password))
    .digest("base64url");

const cookieOptions = (req: Request): CookieOptions => ({ httpOnly: true, sameSite: "lax", path: "/", secure: req.secure });

export function startSession(req: Request, res: Response, device: Device) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ u: device.username, exp })).toString("base64url");
  res.cookie(SESSION_COOKIE, `${payload}.${sign(payload, device)}`, {
    ...cookieOptions(req),
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function endSession(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

/** The device of the logged-in user, or undefined if there is no valid session. */
export function sessionDevice(req: Request) {
  const cookie: unknown = req.cookies?.[SESSION_COOKIE];
  const [payload, signature, ...rest] = (typeof cookie === "string" ? cookie : "").split(".");
  if (!payload || !signature || rest.length > 0) return undefined;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const device = typeof data?.u === "string" ? findDeviceByUsername(data.u) : undefined;
  if (!device || !safeEqual(signature, sign(payload, device))) return undefined;
  if (typeof data.exp !== "number" || data.exp < Date.now() / 1000) return undefined;
  return device;
}
