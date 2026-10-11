import { CREDITS_SCRIPT, creditsHtml } from "./credits.ts";
import { LOADING_MARK, loadingMarkCss } from "./loading-mark.ts";

// The commit the server was built from, with a * for changes not committed: set by scripts/build,
// missing in tests
declare const BUILD_VERSION: string | undefined;
const version = typeof BUILD_VERSION === "string" ? BUILD_VERSION : undefined;


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
    "TRMNL login",
    `<h1>TRMNL</h1>
${error ? "<p>Wrong username or password.</p>\n" : ""}<form method="post" action="/login">
<p><label>Username <input name="username" autocomplete="username" required autofocus></label></p>
<p><label>Password <input type="password" name="password" autocomplete="current-password" required></label></p>
<p><button>Log in</button></p>
</form>`,
  );

/** The time, with the date if it isn't today (a device can be offline for days). */
function formatTime(date: Date, now: Date, timeZone: string) {
  const day = (d: Date) => d.toLocaleDateString("en-GB", { timeZone });
  return new Intl.DateTimeFormat("en-GB", { timeStyle: "short", ...(day(date) !== day(now) && { dateStyle: "medium" }), timeZone }).format(date);
}

/** Where the device is in its playlist, and what it got at its last check-in. */
export interface PlaylistStatus {
  /** The screen shown now */
  screen: string;
  /** Its entry's index in the playlist, or -1 for the default screen (no entry applies) */
  index: number;
  /** Its position (from 1) among the entries that apply now, and how many apply */
  position: number;
  count: number;
  /** The screens of the entries that don't apply now */
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
export function statusText({ screen, index, position, count, otherTimes, checkIn, now, timeZone }: PlaylistStatus) {
  const showing =
    index < 0
      ? `Showing ${screen}, the default: nothing in the playlist applies now`
      : count > 1
        ? `Showing ${screen} (${position}/${count})`
        : `Showing ${screen}`;
  const title = otherTimes.length ? `Also in the playlist, at other times: ${otherTimes.join(", ")}` : "";
  let caption = "Preview (will be applied when device comes online):";
  if (checkIn?.shown === index) caption = "Live preview:";
  // An overdue device: it's offline, or its battery is flat
  else if (checkIn && checkIn.next >= now) caption = `Preview (will be applied at ${formatTime(checkIn.next, now, timeZone)}):`;
  // Prev and Next only with something to move to
  return { showing, title, caption, canMove: index >= 0 && count > 1 };
}

export const screenPage = (name: string, status: PlaylistStatus, playlistLength: number) => {
  const { showing, title, caption, canMove } = statusText(status);
  const showingHtml = `<span id="showing" title="${escapeHtml(title)}">${escapeHtml(showing)}</span>`;
  // With one entry, there's never anything to move to; otherwise the buttons show when there is
  const playlist =
    playlistLength > 1
      ? `<form method="post" action="/next"><p>${showingHtml} <span id="moves"${canMove ? "" : " hidden"}><button formaction="/previous">Prev</button> <button>Next</button></span></p></form>`
      : `<p>${showingHtml}</p>`;
  return page(
    `TRMNL: ${name}`,
    `${playlist}
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
body.actual-size { height: auto; min-height: 100%; }
body.actual-size .preview-area { flex: none; container-type: normal; }
body.actual-size #preview { width: 802px; cursor: zoom-out; }
${loadingMarkCss("#preview")}
</style>
<div class="preview-area"><div id="preview"><img id="screen" width="800" height="480" alt="Screen for ${escapeHtml(name)}">${LOADING_MARK}</div></div>
${creditsHtml([])}
<noscript><p><img src="/screen.png" width="800" height="480" alt="Screen for ${escapeHtml(name)}" style="max-width: 100%; height: auto"></p></noscript>
<form method="post" action="/logout" class="footer"><p>${version ? `Version <code>${escapeHtml(version)}</code> • ` : ""}Logged in as: <strong>${escapeHtml(name)}</strong> <button>Log out</button></p></form>
<script>
// Fetches the screen, shows it, and fetches it again when its X-TTL (seconds) runs out, or soon
// after the device's expected check-in (X-Check-In, in ms) if that's sooner, to update the text
// from X-Status. An X-TTL of Infinity means the screen never changes: no further fetch then.
const img = document.getElementById("screen");
const preview = document.getElementById("preview");
preview.addEventListener("click", () => document.body.classList.toggle("actual-size"));
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
        const { showing, title, caption, canMove } = JSON.parse(decodeURIComponent(status));
        document.getElementById("showing").textContent = showing;
        document.getElementById("showing").title = title;
        const moves = document.getElementById("moves");
        if (moves) moves.hidden = !canMove;
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
