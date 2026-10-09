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
