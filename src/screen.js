import { renderPng } from "./render.js";
import * as placeholder from "./screens/placeholder.jsx";
import { telemetryFor } from "./telemetry.js";

/**
 * The device's current screen as a PNG, and how many seconds it stays valid. Shared by the device
 * API and the browser preview.
 */
export async function renderDeviceScreen(device) {
  const props = {
    name: device.username,
    now: new Date(),
    timeZone: device.timeZone,
    telemetry: telemetryFor(device),
  };
  return { png: await renderPng(placeholder.view(props)), ttl: placeholder.ttl(props) };
}
