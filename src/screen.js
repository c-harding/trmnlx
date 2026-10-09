import { renderPng } from "./render.js";
import { view as placeholder } from "./screens/placeholder.jsx";

/** The device's current screen as a PNG. Shared by the device API and the browser preview. */
export const renderDeviceScreen = (device) =>
  renderPng(placeholder({ name: device.username, now: new Date(), timeZone: device.timeZone }));
