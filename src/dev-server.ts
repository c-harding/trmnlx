// A local server for developing screens: renders any screen with device data entered in a form,
// without TOKEN_SECRET or a real device. If there's a devices.yaml, an entry of a device's or a named
// playlist can be loaded into the form (see dev-config.ts). Run with `npm run dev`, which rebuilds
// and restarts it whenever the code changes.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import { inputTypeName, matchesInput, type InputDefinitions } from "./define-screen.ts";
import { readDevConfig } from "./dev-config.ts";
import { CREDITS_SCRIPT, creditsHtml } from "./credits.ts";
import { DEVICE_DEFAULTS, playlistPage } from "./dev-playlist.ts";
import { LOADING_MARK, loadingMarkCss } from "./loading-mark.ts";
import { renderScreen, screens } from "./screen.ts";

const port = Number(process.env.DEV_PORT ?? 7778);
// The project's devices.yaml, next to .dev/ where the dev server is built
const DEVICES_FILE = new URL("../devices.yaml", import.meta.url);

const app = express();

// Each screen's inputs, for generating its form fields in the browser
const screenInputs = Object.fromEntries(
  Object.entries(screens).map(([name, s]) => [name, s.inputs ?? {}]),
);
// Safe inside a <script>: no "</script>" can appear in the JSON
const screenInputsJson = JSON.stringify(screenInputs).replaceAll("<", "\\u003c");

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>TRMNLx screen development</title>
<style>
/* One column as high as the window: the controls as high as they need, scrolling once they don't
   fit; the Load button and info always visible, right above the preview, which is at the bottom.
   The preview is as high as it can be, but gives up space first (its shrink factor is far larger)
   down to half the page; only then do the controls shrink. (The factors add up to at least 1 on
   purpose: below that, flex only takes away that fraction of the overflow.) */
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; }
#controls { flex: 0 1 auto; min-height: 0; overflow: auto; padding: 0 8px; }
#bar { flex: none; margin-top: auto; padding: 8px; }
#bar p { margin: 0; }
/* "Load" (bold) when the settings changed since the last render, otherwise "Reload": both words in the
   button's one grid cell, the other one hidden, so it's always as wide as the wider and never moves */
#load-button { display: inline-grid; justify-items: center; }
#load-button > span { grid-area: 1 / 1; }
#load-button .load { font-weight: bold; }
#load-button:not(.changed) .load, #load-button.changed .reload { visibility: hidden; }
#preview-area { flex: 0 1000 min(482px, 60vw); min-height: min(482px, 60vw, 50%); display: flex; container-type: size; overflow: hidden; padding: 0 8px 8px; }
/* At native size, it wants the preview's whole height, taking it from the controls down to half the
   page as before, and scrolls beyond that. Otherwise the preview fits by its size, so the area
   doesn't scroll: rounding a fractional height can make it a pixel too high (overflow: hidden) */
#preview-area:has(.native) { flex-basis: 482px; min-height: min(482px, 50%); overflow: auto; }
/* The rendered screen's credits, under the preview */
#credits { flex: none; margin: 0; padding: 0 8px 8px; }
</style>
<div id="controls">
<h1>TRMNLx screen development</h1>
<form id="form">
<p id="load" hidden><label>Load from <a href="/playlist" id="playlist-link">playlist</a> <select id="load-select"></select></label> <span id="load-error"></span></p>
<p><label>Screen <select name="screen" id="screen-select">${Object.keys(screens)
  .map((s) => `<option>${s}</option>`)
  .join("")}</select></label></p>
<details open>
<summary>Screen settings</summary>
<p><label>Time <input type="datetime-local" name="time" step="1"></label> (empty: now)</p>
<div id="screen-inputs"></div>
</details>
<details>
<summary>Device settings (devices.yaml)</summary>
<p><label>Name <input name="name" value="${DEVICE_DEFAULTS.name}"></label></p>
<p><label>Time zone <input name="timeZone" value="${DEVICE_DEFAULTS.timeZone}"></label></p>
</details>
<details>
<summary>Sent by the device (/api/display headers)</summary>
<p><label>Battery-Voltage <input name="batteryVoltage" type="number" step="0.01" value="${DEVICE_DEFAULTS.batteryVoltage}"></label> (empty: unknown)</p>
<p><label><input type="checkbox" name="charging"> Battery-Charging</label>
<label><input type="checkbox" name="usbConnected"> USB-Connected</label></p>
<p><label>RSSI <input name="rssi" type="number" value="${DEVICE_DEFAULTS.rssi}"></label></p>
<p><label>FW-Version <input name="firmwareVersion" value="${DEVICE_DEFAULTS.firmwareVersion}"></label></p>
</details>
</form>
</div>
<div id="bar"><p><button form="form" id="load-button" class="changed"><span class="load">Load</span><span class="reload">Reload</span></button> <span id="info"></span></p></div>
<style>
/* The preview, white like the screen, as big as fits the area's width and height, keeping 5:3, at
   most its native size; a click toggles the native size (the area then scrolls). margin-top: auto
   puts it at the bottom, like align-items: flex-end, but when it's too high for the area (at native
   size) the margin becomes 0 and it overflows downwards, where it can be scrolled to, rather than
   upwards out of reach. While a render runs, it shows TRMNL's mark (see loading-mark.ts) */
#preview { display: grid; grid-template: 1fr / 1fr; flex: none; margin-top: auto; width: min(802px, 100cqw, 100cqh * 5 / 3); aspect-ratio: 5 / 3; box-sizing: border-box; border: 1px solid; background: #fff; cursor: zoom-in; }
#preview.native { width: 802px; cursor: zoom-out; }
#preview img { display: block; width: 100%; height: 100%; }
/* Before the first image (no src yet): nothing, rather than the browser's broken-image icon */
#preview img:not([src]) { visibility: hidden; }
${loadingMarkCss("#preview")}</style>
<div id="preview-area"><div id="preview"><img id="screen" width="800" height="480" alt="Rendered screen">${LOADING_MARK}</div></div>
${creditsHtml([])}
<script>
const SCREEN_INPUTS = ${screenInputsJson};
const form = document.getElementById("form");
const select = document.getElementById("screen-select");
const inputsBox = document.getElementById("screen-inputs");
const img = document.getElementById("screen");
const preview = document.getElementById("preview");
preview.addEventListener("click", () => preview.classList.toggle("native"));
${CREDITS_SCRIPT}
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

// Deep links: any of the form's fields as a query parameter, by its name ("input.zoom=13",
// "timeZone=Europe/Vienna", "time=2026-10-13T08:00"; a list with one entry per line), filled in once
// the screen (and an "entry") is chosen; with any of them, it renders straight away. The form doesn't
// write back to the URL, so choosing another screen or entry drops them.
const queryFields = [...new URLSearchParams(location.search)].filter(([name]) => name !== "screen" && name !== "entry");
function applyQuery(renderAnyway = false) {
  for (const [name, value] of queryFields) {
    const field = form.elements[name];
    if (!field) continue;
    if (field.type === "checkbox") field.checked = ["true", "on", "1"].includes(value);
    else field.value = value;
  }
  if (queryFields.length > 0 || renderAnyway) render();
  else markChanged();
}
function dropQuery() {
  const url = new URL(location.href);
  for (const [name] of queryFields) url.searchParams.delete(name);
  history.replaceState(null, "", url);
  queryFields.length = 0;
}

const setUrl = (name, value) => {
  const url = new URL(location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  history.replaceState(null, "", url);
};

select.addEventListener("change", () => {
  dropQuery();
  setUrl("screen", select.value);
  setUrl("entry", "");
  showScreenInputs();
  markChanged();
});

// Entries from devices.yaml (none without the file): loading one fills the form, which then works
// as before. Read again with every page load, so edits show up without a restart.
const loadBox = document.getElementById("load");
const loadSelect = document.getElementById("load-select");
const loadable = new Map();

function loadEntry(key) {
  const found = loadable.get(key);
  if (!found) return;
  const { group, entry } = found;
  select.value = entry.screen;
  showScreenInputs();
  for (const [name, value] of Object.entries(entry.inputs)) {
    const field = form.elements["input." + name];
    if (!field) continue;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = Array.isArray(value) ? value.join("\\n") : String(value); // "\\n": inside a template literal
  }
  if (group.device) {
    form.elements.name.value = group.device.name;
    form.elements.timeZone.value = group.device.timeZone;
  }
  setUrl("screen", entry.screen);
  setUrl("entry", key);
  // "playlist" in "Load from playlist" leads to this entry's playlist page
  document.getElementById("playlist-link").href =
    "/playlist/" + (group.id.startsWith("playlist/") ? group.id.slice("playlist/".length) : group.id).split("/").map(encodeURIComponent).join("/");
  markChanged();
}

async function loadConfig() {
  const res = await fetch("/config");
  if (res.status === 404) return;
  const config = await res.json();
  loadBox.hidden = false;
  if (config.error) {
    loadSelect.hidden = true;
    document.getElementById("load-error").textContent = "devices.yaml isn't valid: " + config.error;
    return;
  }
  loadSelect.append(new Option("—", ""));
  for (const group of config.groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    group.entries.forEach((entry, i) => {
      const key = group.id + "/" + (i + 1);
      loadable.set(key, { group, entry });
      optgroup.append(new Option(entry.label, key));
    });
    // Every entry was left out: its screens don't exist here (see the dev server's log)
    if (group.entries.length === 0) {
      const none = new Option("No entries: unknown screens, see the dev server's log (a new screen needs a restart)", "");
      none.disabled = true;
      optgroup.append(none);
    }
    loadSelect.append(optgroup);
  }
  const fromUrl = new URLSearchParams(location.search).get("entry");
  if (loadable.has(fromUrl)) {
    loadSelect.value = fromUrl;
    loadEntry(fromUrl);
  }
}

loadSelect.addEventListener("change", () => {
  dropQuery();
  loadEntry(loadSelect.value);
});
// With an entry in the URL (e.g. from the playlist page), a deep link's fields go on top of it, once
// it's loaded (or not found), and it renders straight away if it was found
const entryInUrl = new URLSearchParams(location.search).has("entry");
loadConfig().finally(() => {
  if (entryInUrl) applyQuery(loadSelect.value !== "");
});

// The form's settings, as sent for a render
function settings() {
  const params = new URLSearchParams(new FormData(form));
  const time = form.elements.time.value;
  if (time) params.set("time", new Date(time).toISOString()); // the browser's time zone
  // Unchecked checkboxes are left out of form data, so send every screen boolean explicitly
  for (const box of inputsBox.querySelectorAll("input[type=checkbox]")) params.set(box.name, String(box.checked));
  return params;
}

// The button says "Load" while the form differs from the last render's settings (also before the
// first, and when a change is undone it says "Reload" again); either way, it renders
const loadButton = document.getElementById("load-button");
let rendered;
const markChanged = () => loadButton.classList.toggle("changed", settings().toString() !== rendered);
form.addEventListener("input", markChanged);
form.addEventListener("change", markChanged);

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
  const params = settings();
  const time = form.elements.time.value;
  preview.classList.add("loading");
  let res, blob;
  try {
    res = await fetch("/render?" + params);
    if (!res.ok) {
      // Not again by itself: the settings need fixing
      info.textContent = "Error: " + (await res.text());
      return;
    }
    blob = await res.blob();
    rendered = params.toString();
    markChanged();
  } catch (error) {
    // The request itself failed, e.g. because the dev server is restarting after a change
    info.textContent = "Error: could not reach the dev server (" + error.message + "); trying again";
    schedule(2);
    return;
  } finally {
    preview.classList.remove("loading");
  }
  // Sent URI-encoded, as header values can't take all of Unicode
  showCredits(JSON.parse(decodeURIComponent(res.headers.get("X-Credits") ?? "%5B%5D")));
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  // Number(null) would be 0, so a missing header needs its own check
  const header = res.headers.get("X-TTL");
  const ttl = header === null ? NaN : Number(header);
  // A fixed time gives the same image again
  const again = !time && Number.isFinite(ttl);
  // How long it stays valid, and when it's rendered again: not with the time overridden (the same
  // time gives the same image), nor when it never changes
  const validity =
    header === "Infinity"
      ? "never changes"
      : time
        ? "time overridden: not refreshed"
        : Number.isFinite(ttl)
          ? "valid for " + ttl + " s, again at " + new Date(Date.now() + ttl * 1000).toLocaleTimeString()
          : "ttl unknown";
  info.textContent = [
    validity,
    res.headers.get("X-Colors") + " colours",
    blob.size + " bytes",
    "data loaded in " + res.headers.get("X-Load-Ms") + " ms",
    "rendered in " + res.headers.get("X-Render-Ms") + " ms",
  ].join(" · ");
  if (again) schedule(ttl);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  render();
});

// A deep link's fields, unless it names an entry (see loadConfig above)
if (!entryInUrl) applyQuery();
</script>
</html>
`;

app.get("/", (req, res) => res.type("html").send(page));
// A playlist's screens, all at once (see dev-playlist.ts); the page reads the name from its path
app.get(["/playlist", "/playlist/*name"], (req, res) => res.type("html").send(playlistPage));

// devices.yaml's entries for the form; 404 without the file, the message if it isn't valid
app.get("/config", (req, res) => {
  let text;
  try {
    text = readFileSync(DEVICES_FILE, "utf8");
  } catch {
    return res.status(404).json({});
  }
  try {
    res.json({
      groups: readDevConfig(text, screenInputs, process.env.TZ || "UTC", (screen, inputs) =>
        screens[screen]?.label(inputs),
      ),
    });
  } catch (error) {
    res.json({ error: (error as Error).message });
  }
});

const number = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : Number(value);

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
      inputs[name] = text
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (definition.type === "boolean") {
      inputs[name] = text === "true";
    } else if (text === "") {
      continue;
    } else if (definition.type === "number" || definition.type === "int") {
      inputs[name] = Number(text);
      if (!matchesInput(definition, inputs[name]))
        throw new InputError(`${name} must be ${inputTypeName(definition)}`);
    } else {
      inputs[name] = text;
    }
  }
  return inputs;
}

app.get("/render", async (req, res) => {
  // Only plain values count: a repeated parameter arrives as an array
  const q = Object.fromEntries(
    Object.entries(req.query).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const screen =
    q.screen !== undefined && Object.hasOwn(screens, q.screen) ? screens[q.screen] : undefined;
  if (!screen) return res.status(400).type("text").send(`Unknown screen ${q.screen}`);

  const timeZone = q.timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    return res.status(400).type("text").send(`Unknown time zone ${timeZone}`);
  }
  const now = q.time ? new Date(q.time) : new Date();
  if (Number.isNaN(now.getTime()))
    return res.status(400).type("text").send(`Invalid time ${q.time}`);

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
      "X-Credits": encodeURIComponent(JSON.stringify(result.credits)),
      "X-Render-Ms": result.renderMs.toFixed(0),
    })
    .send(result.png);
});

app.use(((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).type("text").send(err.message);
}) satisfies ErrorRequestHandler);

// Only on this computer, as it shows devices.yaml's playlists: on both loopback addresses, as
// "localhost" may resolve to either
for (const host of ["127.0.0.1", "::1"]) {
  createServer(app)
    .listen(port, host, () =>
      console.log(
        `Screen development server on http://${host.includes(":") ? `[${host}]` : host}:${port}`,
      ),
    )
    .on("error", (error) => console.error(`Not listening on ${host}: ${error.message}`));
}
