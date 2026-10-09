// Seconds added to the ttl, so a device or browser that wakes slightly early doesn't redraw the
// minute that is just ending and then wake again straight away.
const SAFETY_SECONDS = 2;

/** Seconds until the displayed time changes, i.e. until the next minute starts (plus a margin). */
export function ttl({ now }) {
  // Every time zone in use is offset from UTC by whole minutes, so minutes tick together everywhere
  const msLeft = 60_000 - (now.getTime() % 60_000);
  return Math.ceil(msLeft / 1000) + SAFETY_SECONDS;
}

export function view({ name, now, timeZone }) {
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
      <div style={{ display: "flex", fontSize: 72, fontWeight: 700 }}>{name}</div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: 120, fontWeight: 700 }}>{time}</div>
        <div style={{ display: "flex", fontSize: 36 }}>{date}</div>
        <div style={{ display: "flex", fontSize: 20, color: "#555", marginTop: 8 }}>{timeZone}</div>
      </div>
    </div>
  );
}
