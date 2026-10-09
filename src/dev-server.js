// A local server for developing screens: renders any screen with device data entered in a form,
// without devices.yaml, TOKEN_SECRET or a real device. Run with `npm run dev`, which rebuilds and
// restarts it whenever the code changes.
import express from "express";
import { InputError, renderScreen, screens } from "./screen.js";

const port = Number(process.env.DEV_PORT ?? 7778);

const app = express();

// Each screen's inputs, for generating its form fields in the browser
const screenInputs = Object.fromEntries(Object.entries(screens).map(([name, s]) => [name, s.inputs ?? {}]));
// Safe inside a <script>: no "</script>" can appear in the JSON
const screenInputsJson = JSON.stringify(screenInputs).replaceAll("<", "\\u003c");

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>TRMNL screen development</title>
<h1>TRMNL screen development</h1>
<form id="form">
<p><label>Screen <select name="screen" id="screen-select">${Object.keys(screens).map((s) => `<option>${s}</option>`).join("")}</select></label></p>
<details open>
<summary>Screen settings</summary>
<p><label>Time <input type="datetime-local" name="time" step="1"></label> (empty: now)</p>
<div id="screen-inputs"></div>
</details>
<details>
<summary>Device settings (devices.yaml)</summary>
<p><label>Name <input name="name" value="kitchen"></label></p>
<p><label>Time zone <input name="timeZone" value="Europe/Berlin"></label></p>
</details>
<details>
<summary>Sent by the device (/api/display headers)</summary>
<p><label>Battery-Voltage <input name="batteryVoltage" type="number" step="0.01" value="3.92"></label> (empty: unknown)</p>
<p><label><input type="checkbox" name="charging"> Battery-Charging</label>
<label><input type="checkbox" name="usbConnected"> USB-Connected</label></p>
<p><label>RSSI <input name="rssi" type="number" value="-60"></label></p>
<p><label>FW-Version <input name="firmwareVersion" value="1.8.10"></label></p>
</details>
<p><button>Load</button></p>
</form>
<p id="info"></p>
<p><img id="screen" width="800" height="480" alt="Rendered screen" style="border: 1px solid" hidden></p>
<script>
const SCREEN_INPUTS = ${screenInputsJson};
const form = document.getElementById("form");
const select = document.getElementById("screen-select");
const inputsBox = document.getElementById("screen-inputs");
const img = document.getElementById("screen");
const info = document.getElementById("info");

// One field per input of the selected screen, named "input.<name>"
function showScreenInputs() {
  inputsBox.replaceChildren();
  for (const [name, definition] of Object.entries(SCREEN_INPUTS[select.value] ?? {})) {
    const field = document.createElement("input");
    field.name = "input." + name;
    if (definition.type === "boolean") {
      field.type = "checkbox";
      field.checked = Boolean(definition.default);
    } else {
      field.type = definition.type === "number" ? "number" : "text";
      if (definition.default !== undefined) field.value = definition.default;
    }
    const label = document.createElement("label");
    label.append(name + " ", field);
    const p = document.createElement("p");
    p.append(label);
    inputsBox.append(p);
  }
}

const fromUrl = new URLSearchParams(location.search).get("screen");
if (fromUrl in SCREEN_INPUTS) select.value = fromUrl;
showScreenInputs();

select.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("screen", select.value);
  history.replaceState(null, "", url);
  showScreenInputs();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const params = new URLSearchParams(new FormData(form));
  const time = form.elements.time.value;
  if (time) params.set("time", new Date(time).toISOString()); // the browser's time zone
  // Unchecked checkboxes are left out of form data, so send every screen boolean explicitly
  for (const box of inputsBox.querySelectorAll("input[type=checkbox]")) params.set(box.name, String(box.checked));
  info.textContent = "Rendering…";
  let res, blob;
  try {
    res = await fetch("/render?" + params);
    if (!res.ok) {
      info.textContent = "Error: " + (await res.text());
      return;
    }
    blob = await res.blob();
  } catch (error) {
    // The request itself failed, e.g. because the dev server isn't running
    info.textContent = "Error: could not reach the dev server (" + error.message + ")";
    return;
  }
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  img.hidden = false;
  info.textContent = [
    "ttl " + (res.headers.get("X-TTL") === "Infinity" ? "∞ (never changes)" : res.headers.get("X-TTL") + " s"),
    res.headers.get("X-Colors") + " colours",
    blob.size + " bytes",
    "rendered in " + res.headers.get("X-Render-Ms") + " ms",
  ].join(" · ");
});
</script>
</html>
`;

app.get("/", (req, res) => res.type("html").send(page));

const number = (value) => (value === undefined || value === "" ? undefined : Number(value));

app.get("/render", async (req, res) => {
  const q = req.query;
  const screen = Object.hasOwn(screens, q.screen) ? screens[q.screen] : undefined;
  if (!screen) return res.status(400).type("text").send(`Unknown screen ${q.screen}`);

  const timeZone = q.timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    return res.status(400).type("text").send(`Unknown time zone ${timeZone}`);
  }
  const now = q.time ? new Date(q.time) : new Date();
  if (Number.isNaN(now.getTime())) return res.status(400).type("text").send(`Invalid time ${q.time}`);

  const device = { username: q.name || "device", timeZone };
  const telemetry = {
    batteryVoltage: number(q.batteryVoltage),
    rssi: number(q.rssi),
    firmwareVersion: q.firmwareVersion || undefined,
    charging: q.charging === "on",
    usbConnected: q.usbConnected === "on",
    seenAt: now,
  };
  // The screen's inputs arrive as input.<name>
  const inputs = Object.fromEntries(
    Object.entries(q)
      .filter(([key]) => key.startsWith("input."))
      .map(([key, value]) => [key.slice("input.".length), value]),
  );

  const start = performance.now();
  let result;
  try {
    result = await renderScreen(screen, { device, now, telemetry, inputs });
  } catch (error) {
    if (error instanceof InputError) return res.status(400).type("text").send(error.message);
    throw error;
  }
  res
    .type("png")
    .set({
      "Cache-Control": "no-store",
      "X-TTL": String(result.ttl),
      "X-Colors": String(result.colors),
      "X-Render-Ms": (performance.now() - start).toFixed(0),
    })
    .send(result.png);
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).type("text").send(err.message);
});

app.listen(port, () => console.log(`Screen development server on http://localhost:${port}`));
