import { defineScreen } from "../define-screen.ts";
import { batteryText } from "../telemetry.ts";
import { untilNextMinute } from "../time.ts";

export default defineScreen({
  /** Valid until the displayed time changes. */
  ttl: ({ now }) => untilNextMinute(now),

  view({ device, now, telemetry }) {
    const { timeZone } = device;
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
          <div style={{ display: "flex", fontSize: 72, fontWeight: 700 }}>{device.username}</div>
          <div style={{ display: "flex", fontSize: 24, color: "#555", marginTop: 12 }}>{batteryText(telemetry)}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 120, fontWeight: 700 }}>{time}</div>
          <div style={{ display: "flex", fontSize: 36 }}>{date}</div>
        </div>
      </div>
    );
  },
});
