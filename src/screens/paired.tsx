// Shown once, as the setup image, right after a device has paired; also selectable as a screen.
import { defineScreen } from "../define-screen.ts";

/** The layout, also used directly by the device API for /setup.png. */
export const Paired = () => (
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

export default defineScreen({
  /** It never changes: devices wake at their refreshRate, and the browser page doesn't refetch it. */
  ttl: () => Infinity,
  view: Paired,
});
