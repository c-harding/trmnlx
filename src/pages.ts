import { CREDITS_SCRIPT, creditsHtml } from "./credits.ts";
import { LOADING_MARK, loadingMarkCss } from "./loading-mark.ts";
import { version } from "./version.ts";

const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
${body}
</html>
`;

export const loginPage = ({ error }: { error: boolean }) =>
  page(
    "TRMNLx login",
    `<h1>TRMNLx</h1>
${error ? "<p>Wrong username or password.</p>\n" : ""}<form method="post" action="/login">
<p><label>Username <input name="username" autocomplete="username" required autofocus></label></p>
<p><label>Password <input type="password" name="password" autocomplete="current-password" required></label></p>
<p><button>Log in</button></p>
</form>`,
  );

/** The time, with the date if it isn't today (a device can be offline for days). */
function formatTime(date: Date, now: Date, timeZone: string) {
  const day = (d: Date) => d.toLocaleDateString("en-GB", { timeZone });
  return new Intl.DateTimeFormat("en-GB", {
    timeStyle: "short",
    ...(day(date) !== day(now) && { dateStyle: "medium" }),
    timeZone,
  }).format(date);
}

/** Which playlist the device shows, where it is in it, and what it got at its last check-in. */
export interface PlaylistStatus {
  /** The playlist's name (`default` for the device's `playlist`), and those the page offers */
  playlist: string;
  choices: string[];
  /** The entry shown now: its screen, and its label if it has one ("map: Graz") */
  screen: string;
  /** Its entry's index in the playlist, or -1 for the default screen (no entry applies) */
  index: number;
  /** Its position (from 1) among the entries that apply now, and how many apply */
  position: number;
  count: number;
  /** The entries that don't apply now, named the same way */
  otherTimes: string[];
  /**
   * Its last check-in: the index of the entry it was sent (-1 for the default screen, undefined if
   * unknown), and when the next is expected; undefined if it has never checked in
   */
  checkIn: { shown: number | undefined; next: Date } | undefined;
  now: Date;
  timeZone: string;
}

/**
 * The screen page's text about the playlist, as plain text: sent with the page, and again with
 * each /screen.png (X-Status), so the page keeps up when the device checks in or another tab
 * moves the playlist. The position counts the entries that apply now, which Prev and Next move
 * through, so it can change during the day; `title` names the others, as a tooltip. The caption
 * says whether the preview is live: whether the device got this entry at its last check-in (by
 * entry, not image: the preview is rendered fresh, so its data can be newer), or when it will.
 */
export function statusText({
  playlist,
  screen,
  index,
  position,
  count,
  otherTimes,
  checkIn,
  now,
  timeZone,
}: PlaylistStatus) {
  const showing =
    index < 0
      ? `Showing ${screen}, the default: nothing in the playlist applies now`
      : count > 1
        ? `Showing ${screen} (${position}/${count})`
        : `Showing ${screen}`;
  const title = otherTimes.length
    ? `Also in the playlist, at other times: ${otherTimes.join(", ")}`
    : "";
  let caption = "Preview (will be applied when device comes online):";
  if (checkIn?.shown === index) caption = "Live preview:";
  // An overdue device: it's offline, or its battery is flat
  else if (checkIn && checkIn.next >= now)
    caption = `Preview (will be applied at ${formatTime(checkIn.next, now, timeZone)}):`;
  // Prev and Next only with something to move to
  return { playlist, showing, title, caption, canMove: index >= 0 && count > 1 };
}

/**
 * The choice of playlist: when there's another to switch to. Before one is chosen, a device
 * without its own `playlist` shows the default screen, which isn't a choice of its own.
 */
export function playlistChoice({
  playlist,
  choices,
}: Pick<PlaylistStatus, "playlist" | "choices">) {
  const offered = choices.includes(playlist);
  if (choices.length < (offered ? 2 : 1)) return "";
  const none = offered ? "" : `<option value="" selected disabled>none (default screen)</option>`;
  const options = choices.map(
    (choice) =>
      `<option value="${escapeHtml(choice)}"${choice === playlist ? " selected" : ""}>${escapeHtml(choice)}</option>`,
  );
  return `<form method="post" action="/playlist"><p><label>Playlist <select name="name" id="playlist">${none}${options.join("")}</select></label> <noscript><button>Switch</button></noscript></p></form>\n`;
}

export const screenPage = (name: string, status: PlaylistStatus) => {
  const { showing, title, caption, canMove } = statusText(status);
  // The buttons show when there's something to move to, which can change with the time and the playlist
  const playlist = `<form method="post" action="/next"><p><span id="showing" title="${escapeHtml(title)}">${escapeHtml(showing)}</span> <span id="moves"${canMove ? "" : " hidden"}><button formaction="/previous">Prev</button> <button>Next</button></span></p></form>`;
  return page(
    `TRMNLx: ${name}`,
    `${playlistChoice(status)}${playlist}
<p id="caption">${escapeHtml(caption)}</p>
<style>
/* The page is a column as high as the window, its lines evenly spaced; the preview shrinks to the
   height the other lines leave */
html { height: 100%; }
body { height: 100%; margin: 0; padding: 8px; box-sizing: border-box; display: flex; flex-direction: column; gap: 1em; }
p { margin: 0; }
.preview-area { flex: 0 1 min(482px, (100vw - 16px) * 0.6); min-height: 0; container-type: size; }
/* At the bottom of the window, or of the page once it scrolls */
.footer { margin-top: auto; }
/* The preview fits that space, keeping 5:3, shrunk and never enlarged (at most 800×480 inside its
   border), white like the screen, its space kept while it loads; a click toggles its actual size, with the page
   scrolling. While the next image loads, it shows TRMNL's mark (see loading-mark.ts) */
#preview { display: grid; grid-template: 1fr / 1fr; width: min(802px, 100cqw, 100cqh * 5 / 3); aspect-ratio: 5 / 3; box-sizing: border-box; border: 1px solid; background: #fff; cursor: zoom-in; }
#preview img { display: block; width: 100%; height: 100%; }
/* Before the first image (no src yet): nothing, rather than the browser's broken-image icon */
#preview img:not([src]) { visibility: hidden; }
body.actual-size { height: auto; min-height: 100%; }
body.actual-size .preview-area { flex: none; container-type: normal; }
body.actual-size #preview { width: 802px; cursor: zoom-out; }
${loadingMarkCss("#preview")}
</style>
<div class="preview-area"><div id="preview"><img id="screen" width="800" height="480" alt="Screen for ${escapeHtml(name)}">${LOADING_MARK}</div></div>
${creditsHtml([])}
<noscript><p><img src="/screen.png" width="800" height="480" alt="Screen for ${escapeHtml(name)}" style="max-width: 100%; height: auto"></p></noscript>
<form method="post" action="/logout" class="footer"><p>${version ? `Version <code>${escapeHtml(version)}</code> • ` : ""}Logged in as: <strong>${escapeHtml(name)}</strong> • <a href="/logs">Logs</a> <button>Log out</button></p></form>
<script>
// Fetches the screen, shows it, and fetches it again when its X-TTL (seconds) runs out, or soon
// after the device's expected check-in (X-Check-In, in ms) if that's sooner, to update the text
// from X-Status. An X-TTL of Infinity means the screen never changes: no further fetch then.
const img = document.getElementById("screen");
const preview = document.getElementById("preview");
preview.addEventListener("click", () => document.body.classList.toggle("actual-size"));
// Choosing a playlist switches to it straight away (without JavaScript, the Switch button does)
const choice = document.getElementById("playlist");
choice?.addEventListener("change", () => choice.form.submit());
${CREDITS_SCRIPT}
async function refresh() {
  let delay = 30;
  preview.classList.add("loading");
  try {
    const res = await fetch("/screen.png", { cache: "no-store" });
    if (res.status === 401) return location.assign("/login");
    if (res.ok) {
      // Its credits come with each image, as they can depend on what it shows
      showCredits(JSON.parse(decodeURIComponent(res.headers.get("X-Credits") ?? "%5B%5D")));
      const old = img.src;
      img.src = URL.createObjectURL(await res.blob());
      if (old) URL.revokeObjectURL(old);
      // Number(null) would be 0, so a missing header needs its own check
      const header = res.headers.get("X-TTL");
      const ttl = header === null ? NaN : Number(header);
      delay = Number.isNaN(ttl) ? 60 : Math.max(ttl, 1);
      const status = res.headers.get("X-Status");
      if (status) {
        const { playlist, showing, title, caption, canMove } = JSON.parse(decodeURIComponent(status));
        // Another tab may have switched it (to one not offered here: the "none" option)
        if (choice) choice.value = [...choice.options].some((option) => option.value === playlist) ? playlist : "";
        document.getElementById("showing").textContent = showing;
        document.getElementById("showing").title = title;
        document.getElementById("moves").hidden = !canMove;
        document.getElementById("caption").textContent = caption;
      }
      const untilCheckIn = (Number(res.headers.get("X-Check-In")) - Date.now()) / 1000 + 30;
      if (untilCheckIn > 0) delay = Math.min(delay, untilCheckIn);
    }
  } catch {
  } finally {
    preview.classList.remove("loading");
  }
  // setTimeout treats delays beyond 2^31 - 1 ms (about 24.8 days), and Infinity, as 0
  if (Number.isFinite(delay)) setTimeout(refresh, Math.min(delay * 1000, 2 ** 31 - 1));
}
refresh();
</script>`,
  );
};

/**
 * The device's live logs (see logs.ts): entries as they arrive from /logs/stream, newest at the
 * bottom, kept only while the page is open. "Autoscroll" (on after every load) keeps the newest in
 * view.
 */
export const logsPage = (name: string) =>
  page(
    `TRMNLx logs: ${name}`,
    `<style>
body { margin: 0; padding: 8px; font-family: system-ui, sans-serif; }
p { margin: 0 0 8px; }
.bar { position: sticky; top: 0; background: Canvas; padding: 4px 0; display: flex; gap: 1em; align-items: baseline; flex-wrap: wrap; }
#status { color: GrayText; }
table { border-collapse: collapse; font: 13px/1.4 ui-monospace, monospace; width: 100%; }
td { padding: 2px 8px 2px 0; vertical-align: top; }
td.time, td.level, td.source { white-space: nowrap; }
td.message { width: 100%; overflow-wrap: anywhere; }
.details { color: GrayText; }
tr.warn td.level { color: #b26b00; font-weight: bold; }
tr.error td.level, tr.fatal td.level { color: #c00; font-weight: bold; }
tr.debug { color: GrayText; }
#empty { color: GrayText; }
</style>
<div class="bar"><strong>Logs: ${escapeHtml(name)}</strong> <span id="status">Connecting…</span> <label><input type="checkbox" id="autoscroll" checked> Autoscroll</label> <button id="clear">Clear</button> <a href="/">Screen</a></div>
<p id="empty">Nothing yet: entries show here as they happen, from the device (after a failure) and from the server (each check-in). Nothing earlier is kept.</p>
<table><tbody id="entries"></tbody></table>
<script>
const entries = document.getElementById("entries");
const status = document.getElementById("status");
const autoscroll = document.getElementById("autoscroll");
const empty = document.getElementById("empty");
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });
const cell = (className, text) => {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
};
function show(entry) {
  const row = document.createElement("tr");
  row.className = entry.level;
  const message = cell("message", entry.message);
  const details = Object.entries(entry.details ?? {}).map(([key, value]) => key + ": " + value).join(" · ");
  if (details) {
    const span = document.createElement("div");
    span.className = "details";
    span.textContent = details;
    message.append(span);
  }
  row.append(cell("time", time.format(entry.time)), cell("source", entry.source), cell("level", entry.level), message);
  entries.append(row);
  empty.hidden = true;
  if (autoscroll.checked) row.scrollIntoView({ block: "end" });
}
document.getElementById("clear").addEventListener("click", () => {
  entries.replaceChildren();
  empty.hidden = false;
});
autoscroll.addEventListener("change", () => {
  if (autoscroll.checked) entries.lastElementChild?.scrollIntoView({ block: "end" });
});
// Reconnects by itself after a dropped connection (e.g. a server restart); entries from while it
// was away are lost
const source = new EventSource("/logs/stream");
source.addEventListener("open", () => (status.textContent = "Live"));
source.addEventListener("message", (event) => show(JSON.parse(event.data)));
source.addEventListener("error", () => {
  // Closed for good (e.g. 401 after logging out elsewhere) rather than reconnecting
  if (source.readyState === EventSource.CLOSED) {
    status.textContent = "Disconnected: ";
    const link = document.createElement("a");
    link.href = "/logs";
    link.textContent = "reload";
    status.append(link);
  } else status.textContent = "Reconnecting…";
});
</script>`,
  );
