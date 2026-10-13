import type { Request } from "express";
import { savedState, stateChanged, type StateDevice } from "./state-file.ts";

/** The readings a device sends with /api/display. Each is undefined if the device didn't send it. */
export interface Telemetry {
  batteryVoltage: number | undefined;
  rssi: number | undefined;
  firmwareVersion: string | undefined;
  charging: boolean | undefined;
  usbConnected: boolean | undefined;
  seenAt: Date;
}

// The latest readings each device sent with /api/display, by MAC. Saved across restarts, in the
// device's file (see state-file.ts), read on first need.
const latest = new Map<string, Telemetry>();
const SECTION = "telemetry";

/** Readings as saved (seenAt as text), or undefined if there are none or they're broken. */
export function restoreTelemetry(saved: unknown): Telemetry | undefined {
  if (typeof saved !== "object" || saved === null) return undefined;
  const record = saved as Record<string, unknown>;
  const seenAt = typeof record.seenAt === "string" ? new Date(record.seenAt) : undefined;
  if (!seenAt || Number.isNaN(seenAt.getTime())) return undefined;
  const ofType = <T>(value: unknown, type: string) =>
    typeof value === type ? (value as T) : undefined;
  return {
    batteryVoltage: ofType(record.batteryVoltage, "number"),
    rssi: ofType(record.rssi, "number"),
    firmwareVersion: ofType(record.firmwareVersion, "string"),
    charging: ofType(record.charging, "boolean"),
    usbConnected: ofType(record.usbConnected, "boolean"),
    seenAt,
  };
}

const number = (value: string | undefined) =>
  value == null || value === "" || !Number.isFinite(Number(value)) ? undefined : Number(value);

/** Stores the readings from the headers of a device's /api/display request. */
export function recordTelemetry(device: StateDevice, req: Request) {
  const charging = req.get("Battery-Charging");
  const usb = req.get("USB-Connected");
  const telemetry: Telemetry = {
    batteryVoltage: number(req.get("Battery-Voltage")),
    rssi: number(req.get("RSSI")),
    firmwareVersion: req.get("FW-Version"),
    charging: charging === "1" ? true : charging === "0" ? false : undefined,
    usbConnected: usb === "true" ? true : usb === "false" ? false : undefined,
    seenAt: new Date(),
  };
  latest.set(device.mac, telemetry);
  stateChanged(device, SECTION, () => telemetry);
}

/** The device's latest readings, or undefined if it has never polled. */
export function telemetryFor(device: StateDevice) {
  if (!latest.has(device.mac)) {
    const saved = restoreTelemetry(savedState(device, SECTION));
    if (saved) latest.set(device.mac, saved);
  }
  return latest.get(device.mac);
}

// A typical single-cell lithium battery under light load: voltage → rough charge left (%).
// Only an estimate: the curve depends on the battery, its age and the temperature.
const DISCHARGE_CURVE = [
  [4.2, 100],
  [4.1, 90],
  [4.0, 80],
  [3.9, 65],
  [3.8, 50],
  [3.75, 40],
  [3.7, 30],
  [3.65, 20],
  [3.6, 10],
  [3.5, 5],
  [3.3, 0],
];

/** A rough battery percentage from its voltage, interpolated along a typical discharge curve. */
export function batteryPercent(voltage: number) {
  if (voltage >= DISCHARGE_CURVE[0][0]) return 100;
  for (let i = 1; i < DISCHARGE_CURVE.length; i++) {
    const [v1, p1] = DISCHARGE_CURVE[i - 1];
    const [v2, p2] = DISCHARGE_CURVE[i];
    if (voltage >= v2) return Math.round(p2 + ((voltage - v2) / (v1 - v2)) * (p1 - p2));
  }
  return 0;
}

/** The battery line shown on screens, e.g. "Battery 3.92 V · ≈68%". */
/** As batteryText, as two short lines: the voltage, then the charge (e.g. "3.92 V", "≈68%"). */
export function batteryLines(telemetry: Telemetry | undefined): [string, string] {
  const voltage = telemetry?.batteryVoltage;
  if (voltage === undefined) return ["Battery", "unknown"];
  const charging = telemetry?.charging || telemetry?.usbConnected ? " · charging" : "";
  return [`${voltage.toFixed(2)} V`, `≈${batteryPercent(voltage)}%${charging}`];
}

export function batteryText(telemetry: Telemetry | undefined) {
  const voltage = telemetry?.batteryVoltage;
  if (voltage === undefined) return "Battery unknown";
  const charging = telemetry?.charging || telemetry?.usbConnected ? " · charging" : "";
  return `Battery ${voltage.toFixed(2)} V · ≈${batteryPercent(voltage)}%${charging}`;
}
