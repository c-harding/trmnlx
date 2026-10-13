// The dev server's playlist page (/playlist, /playlist/<name>): a device's or a named playlist's
// screens from devices.yaml, all rendered one after another, for scrolling through. A named
// playlist is /playlist/travel, a device's /playlist/device/kitchen. Each screen links to the main
// page with its entry loaded (?entry=).
import { LOADING_MARK, loadingMarkCss } from "./loading-mark.ts";

/** What the main page's form has for the device, unless the entry's device says otherwise. */
export const DEVICE_DEFAULTS = {
  name: "kitchen",
  timeZone: "Europe/Berlin",
  // Its location, e.g. for the weather: Munich, as in devices.yaml.sample
  lat: "48.14",
  lon: "11.58",
  batteryVoltage: "3.92",
  rssi: "-60",
  firmwareVersion: "1.8.10",
};

export const playlistPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Playlists · TRMNLx screen development</title>
<style>
/* One column as high as the window: the title and the bar with the playlist and the zoom stay at
   the top, the screens below scroll */
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; padding: 0 8px; box-sizing: border-box; }
h1, #bar { flex: none; }
#bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; margin: 0 0 16px; }
/* The breadcrumb's and the captions' links (credits) in the text's colour, still underlined */
h1 a, #screens figcaption a { color: inherit; }
/* The screens at the zoom's scale (--scale, from ¼ to their native size), wrapping */
#screens { flex: 1; min-height: 0; overflow: auto; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 16px; padding-bottom: 8px; }
/* As wide as its screen, so a long caption is cut off with "…" rather than widening it */
#screens figure { margin: 0; width: calc(802px * var(--scale, 1)); }
/* A screen: a link to it on the main page, white with a border (in the text's colour, not the
   link's), holding its image and, while it loads, TRMNL's mark as on the main page */
#screens a.screen { display: grid; grid-template: 1fr / 1fr; width: calc(802px * var(--scale, 1)); aspect-ratio: 5 / 3; box-sizing: border-box; border: 1px solid; background: #fff; color: inherit; text-decoration: none; }
#screens a.screen img { display: block; width: 100%; height: 100%; }
/* In place of a screen that couldn't be rendered: why, in the middle of its rectangle */
#screens .failed { grid-area: 1 / 1; display: flex; align-items: center; justify-content: center; padding: 16px; text-align: center; overflow: auto; }
${loadingMarkCss("#screens a.screen")}
#zoom-value { display: inline-block; min-width: 4ch; }
/* Hidden while fitting, but keeping its space, so the bar doesn't change height or move */
#fit.fitting { visibility: hidden; }
#screens figcaption { margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
<h1><a href="/">TRMNLx screen development</a> › <a href="/playlist">playlists</a><span id="crumb"></span></h1>
<p id="bar">
<span><label>Playlist <select id="playlist-select"></select></label> <span id="message"></span></span>
<span id="zoom-bar" hidden><label>Zoom <input type="range" id="zoom" min="0.25" max="1" step="0.01"></label> <output id="zoom-value" for="zoom"></output> <button type="button" id="fit">Fit</button></span>
</p>
<div id="screens"></div>
<script>
const DEVICE_DEFAULTS = ${JSON.stringify(DEVICE_DEFAULTS)};
const LOADING_MARK = ${JSON.stringify(LOADING_MARK)};
const select = document.getElementById("playlist-select");
const message = document.getElementById("message");

// A group's path under /playlist: "travel" for a named playlist, "device/kitchen" for a device
const pathOf = (id) => (id.startsWith("playlist/") ? id.slice("playlist/".length) : id);
const urlOf = (path) => "/playlist/" + path.split("/").map(encodeURIComponent).join("/");
const current = location.pathname.split("/").slice(2).filter(Boolean).map(decodeURIComponent).join("/");

// The parameters for /render, as the main page's form sends them
function renderParams(group, entry) {
  const params = new URLSearchParams({ screen: entry.screen, ...DEVICE_DEFAULTS, ...group.device });
  for (const [name, value] of Object.entries(entry.inputs)) {
    params.set("input." + name, Array.isArray(value) ? value.join("\\n") : String(value)); // "\\n": inside a template literal
  }
  return params;
}

// A screen's rendering into its link: the PNG, with its credits (X-Credits, as on the main page) as
// links after the caption's label; or, if it couldn't be rendered, the dev server's message (sent as
// text) in its rectangle
async function renderInto(link, caption, url, label) {
  const img = document.createElement("img");
  img.width = 800;
  img.height = 480;
  img.alt = label;
  link.classList.add("loading");
  link.insertAdjacentHTML("beforeend", LOADING_MARK);
  link.prepend(img);
  const fail = (text) => {
    const failed = document.createElement("div");
    failed.className = "failed";
    failed.textContent = text;
    img.replaceWith(failed);
  };
  try {
    const res = await fetch(url);
    if (!res.ok) return fail("Couldn't render it: " + (await res.text()));
    img.src = URL.createObjectURL(await res.blob());
    // Sent URI-encoded, as header values can't take all of Unicode
    const credits = JSON.parse(decodeURIComponent(res.headers.get("X-Credits") ?? "%5B%5D"));
    credits.forEach(({ text, url }, i) => {
      const credit = document.createElement("a");
      credit.href = url;
      credit.textContent = text;
      caption.append(i === 0 ? " · " : ", ", credit);
    });
    // The whole caption on hover, in case it's cut off
    caption.title = caption.textContent;
  } catch (error) {
    fail("Couldn't render it: " + error.message);
  } finally {
    link.classList.remove("loading");
  }
}

function showGroup(group) {
  // The zoom only once there are screens to zoom
  document.getElementById("zoom-bar").hidden = false;
  document.getElementById("crumb").textContent = " › " + current;
  document.title = current + " · TRMNLx screen development";
  const screens = group.entries.map((entry, i) => {
    const link = document.createElement("a");
    link.className = "screen";
    link.href = "/?entry=" + encodeURIComponent(group.id + "/" + (i + 1));
    const caption = document.createElement("figcaption");
    caption.textContent = entry.label;
    caption.title = entry.label;
    renderInto(link, caption, "/render?" + renderParams(group, entry), entry.label);
    const figure = document.createElement("figure");
    figure.append(link, caption);
    return figure;
  });
  document.getElementById("screens").replaceChildren(...screens);
}

async function load() {
  const res = await fetch("/config");
  if (res.status === 404) {
    message.textContent = "There's no devices.yaml.";
    return;
  }
  const config = await res.json();
  if (config.error) {
    message.textContent = "devices.yaml isn't valid: " + config.error;
    return;
  }
  select.append(new Option("—", ""));
  for (const group of config.groups) {
    const count = group.entries.length === 1 ? "1 screen" : group.entries.length + " screens";
    select.append(new Option(group.label + " (" + count + ")", pathOf(group.id)));
  }
  if (!current) return;
  const group = config.groups.find((g) => pathOf(g.id) === current);
  if (!group) {
    message.textContent = "No playlist " + current + " in devices.yaml.";
    return;
  }
  select.value = current;
  showGroup(group);
}

select.addEventListener("change", () => location.assign(select.value ? urlOf(select.value) : "/playlist"));

// The zoom: by default as big as fits the screens' area's width (inside its scrollbar; again on every
// resize), at most the native size; once moved, it stays where it was put, and "Fit" goes back to
// fitting
const zoom = document.getElementById("zoom");
const fitButton = document.getElementById("fit");
let fitting = true;
const fitScale = () => Math.min(1, Math.max(0.25, document.getElementById("screens").clientWidth / 802));
function setScale(scale) {
  document.getElementById("screens").style.setProperty("--scale", String(scale));
  zoom.value = String(scale);
  document.getElementById("zoom-value").textContent = Math.round(scale * 100) + "%";
  fitButton.classList.toggle("fitting", fitting);
}
zoom.addEventListener("input", () => {
  fitting = false;
  setScale(Number(zoom.value));
});
fitButton.addEventListener("click", () => {
  fitting = true;
  setScale(fitScale());
});
addEventListener("resize", () => {
  if (fitting) setScale(fitScale());
});
setScale(fitScale());
load();
</script>
</html>
`;
