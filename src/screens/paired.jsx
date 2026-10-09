// Shown once, as the setup image, right after a device has paired; also selectable as a screen.

/** It never changes: devices wake at their refreshRate, and the browser page doesn't refetch it. */
export const ttl = () => Infinity;

export function view() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        width: "100%",
        height: "100%",
        background: "#fff",
        color: "#000",
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", fontSize: 72, fontWeight: 700 }}>Paired</div>
      <div style={{ display: "flex", fontSize: 32, color: "#555", marginTop: 16 }}>The first screen follows shortly</div>
    </div>
  );
}
