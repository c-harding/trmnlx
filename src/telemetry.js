// The latest readings each device sent with /api/display, by MAC. In memory only: after a restart
// a device's readings are unknown until its next poll.
const latest = new Map();

const number = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? undefined : Number(value));

/** Stores the readings from the headers of a device's /api/display request. */
export function recordTelemetry(device, req) {
  const charging = req.get("Battery-Charging");
  const usb = req.get("USB-Connected");
  latest.set(device.mac, {
    batteryVoltage: number(req.get("Battery-Voltage")),
    rssi: number(req.get("RSSI")),
    firmwareVersion: req.get("FW-Version"),
    charging: charging === "1" ? true : charging === "0" ? false : undefined,
    usbConnected: usb === "true" ? true : usb === "false" ? false : undefined,
    seenAt: new Date(),
  });
}

/** The device's latest readings, or undefined if it hasn't polled since the server started. */
export const telemetryFor = (device) => latest.get(device.mac);

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
export function batteryPercent(voltage) {
  if (voltage >= DISCHARGE_CURVE[0][0]) return 100;
  for (let i = 1; i < DISCHARGE_CURVE.length; i++) {
    const [v1, p1] = DISCHARGE_CURVE[i - 1];
    const [v2, p2] = DISCHARGE_CURVE[i];
    if (voltage >= v2) return Math.round(p2 + ((voltage - v2) / (v1 - v2)) * (p1 - p2));
  }
  return 0;
}
