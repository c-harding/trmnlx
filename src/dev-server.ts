// A local server for developing screens: renders any screen with device data entered in a form,
// without devices.yaml, TOKEN_SECRET or a real device. Run with `npm run dev`, which rebuilds and
// restarts it whenever the code changes.
import express, { type ErrorRequestHandler } from "express";
import { inputTypeName, matchesInput, type InputDefinitions } from "./define-screen.ts";
import { renderScreen, screens } from "./screen.ts";

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
    // A list is a textarea with one entry per line
    const field = document.createElement(definition.type === "list" ? "textarea" : "input");
    field.name = "input." + name;
    if (definition.type === "list") {
      field.rows = Math.max(2, (definition.default ?? []).length);
      field.value = (definition.default ?? []).join("\\n"); // "\\n": this script is inside a template literal
    } else if (definition.type === "boolean") {
      field.type = "checkbox";
      field.checked = Boolean(definition.default);
    } else {
      field.type = definition.type === "number" || definition.type === "int" ? "number" : "text";
      // Any number, not only whole ones (e.g. a map's zoom or coordinates); an int keeps the
      // browser's step of 1
      if (definition.type === "number") field.step = "any";
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

// Renders the screen with the form's settings, and renders it again when its X-TTL runs out (as the
// server's screen page does), unless the time is fixed. Clicking Load renders straight away.
let timer;
const schedule = (seconds) => {
  clearTimeout(timer);
  // setTimeout treats delays beyond 2^31 - 1 ms (about 24.8 days), and Infinity, as 0
  if (Number.isFinite(seconds)) timer = setTimeout(render, Math.min(Math.max(seconds, 1) * 1000, 2 ** 31 - 1));
};

async function render() {
  clearTimeout(timer);
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
      // Not again by itself: the settings need fixing
      info.textContent = "Error: " + (await res.text());
      return;
    }
    blob = await res.blob();
  } catch (error) {
    // The request itself failed, e.g. because the dev server is restarting after a change
    info.textContent = "Error: could not reach the dev server (" + error.message + "); trying again";
    schedule(2);
    return;
  }
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  img.hidden = false;
  // Number(null) would be 0, so a missing header needs its own check
  const header = res.headers.get("X-TTL");
  const ttl = header === null ? NaN : Number(header);
  // A fixed time gives the same image again
  const again = !time && Number.isFinite(ttl);
  info.textContent = [
    "ttl " + (header === "Infinity" ? "∞ (never changes)" : header + " s"),
    res.headers.get("X-Colors") + " colours",
    blob.size + " bytes",
    "data loaded in " + res.headers.get("X-Load-Ms") + " ms",
    "rendered in " + res.headers.get("X-Render-Ms") + " ms",
    again ? "again at " + new Date(Date.now() + ttl * 1000).toLocaleTimeString() : "not again by itself",
  ].join(" · ");
  if (again) schedule(ttl);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  render();
});
</script>
</html>
`;

app.get("/", (req, res) => res.type("html").send(page));

const number = (value: string | undefined) => (value === undefined || value === "" ? undefined : Number(value));

class InputError extends Error {}

/**
 * The screen's inputs from the form, where they arrive as text named input.<name>, converted to
 * their types: a list has one entry per line (empty text is an empty list), a checkbox is "true" or
 * "false", and an empty field means the default.
 */
function formInputs(definitions: InputDefinitions, q: Record<string, string>) {
  const inputs: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const text = q[`input.${name}`];
    if (text === undefined) continue;
    if (definition.type === "list") {
      inputs[name] = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    } else if (definition.type === "boolean") {
      inputs[name] = text === "true";
    } else if (text === "") {
      continue;
    } else if (definition.type === "number" || definition.type === "int") {
      inputs[name] = Number(text);
      if (!matchesInput(definition, inputs[name])) throw new InputError(`${name} must be ${inputTypeName(definition)}`);
    } else {
      inputs[name] = text;
    }
  }
  return inputs;
}

app.get("/render", async (req, res) => {
  // Only plain values count: a repeated parameter arrives as an array
  const q = Object.fromEntries(
    Object.entries(req.query).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const screen = q.screen !== undefined && Object.hasOwn(screens, q.screen) ? screens[q.screen] : undefined;
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
  let inputs;
  try {
    inputs = formInputs(screen.inputs, q);
  } catch (error) {
    if (error instanceof InputError) return res.status(400).type("text").send(error.message);
    throw error;
  }

  const result = await renderScreen(screen, { device, now, telemetry, inputs });
  res
    .type("png")
    .set({
      "Cache-Control": "no-store",
      "X-TTL": String(result.ttl),
      "X-Colors": String(result.colors),
      "X-Load-Ms": result.loadMs.toFixed(0),
      "X-Render-Ms": result.renderMs.toFixed(0),
    })
    .send(result.png);
});

app.use(((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).type("text").send(err.message);
}) satisfies ErrorRequestHandler);

app.listen(port, () => console.log(`Screen development server on http://localhost:${port}`));
