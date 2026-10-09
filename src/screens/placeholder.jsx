import { batteryPercent } from "../telemetry.js";
import { untilNextMinute } from "../time.js";

/** Valid until the displayed time changes. */
export const ttl = ({ now }) => untilNextMinute(now);

export function batteryText(telemetry) {
  const voltage = telemetry?.batteryVoltage;
  if (voltage === undefined) return "Battery unknown";
  const charging = telemetry.charging || telemetry.usbConnected ? " · charging" : "";
  return `Battery ${voltage.toFixed(2)} V · ≈${batteryPercent(voltage)}%${charging}`;
}

export function view({ name, now, timeZone, telemetry }) {
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone }).format(now);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: 40,
        background: "#fff",
        color: "#000",
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", fontSize: 72, fontWeight: 700 }}>{name}</div>
        <div style={{ display: "flex", fontSize: 24, color: "#555", marginTop: 12 }}>{batteryText(telemetry)}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: 120, fontWeight: 700 }}>{time}</div>
        <div style={{ display: "flex", fontSize: 36 }}>{date}</div>
      </div>
    </div>
  );
}
