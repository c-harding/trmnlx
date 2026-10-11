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
  /** The current playlist entry's position (from 1) and screen, and the playlist's length */
  position: number;
  screen: string;
  count: number;
  /**
   * Its last check-in: the position of the entry it was sent, and when the next is expected;
   * undefined if none since the server started
   */
  checkIn: { shown: number; next: Date } | undefined;
  now: Date;
  timeZone: string;
}

/**
 * The screen page's text about the playlist, as plain text: sent with the page, and again with
 * each /screen.png (X-Status), so the page keeps up when the device checks in or another tab
 * moves the playlist. The caption says whether the preview is live: whether the device got this
 * entry at its last check-in (by entry, not image: the preview is rendered fresh, so its data can
 * be newer), or when it will.
 */
export function statusText({ position, screen, count, checkIn, now, timeZone }: PlaylistStatus) {
  const showing = count > 1 ? `Showing ${screen} (${position}/${count})` : `Showing ${screen}`;
  let caption = "Preview (will be applied when device comes online):";
  if (checkIn?.shown === position) caption = "Live preview:";
  // An overdue device: it's offline, or its battery is flat
  else if (checkIn && checkIn.next >= now) caption = `Preview (will be applied at ${formatTime(checkIn.next, now, timeZone)}):`;
  return { showing, caption };
}

export const screenPage = (name: string, status: PlaylistStatus) => {
  const { showing, caption } = statusText(status);
  const showingHtml = `<span id="showing">${escapeHtml(showing)}</span>`;
  const playlist =
    status.count > 1
      ? `<form method="post" action="/next"><p>${showingHtml} <button formaction="/previous">Prev</button> <button>Next</button></p></form>`
      : `<p>${showingHtml}</p>`;
  return page(
    `TRMNL: ${name}`,
    `${playlist}
<p id="caption">${escapeHtml(caption)}</p>
<p><img id="screen" width="800" height="480" alt="Screen for ${escapeHtml(name)}"></p>
<noscript><p><img src="/screen.png" width="800" height="480" alt="Screen for ${escapeHtml(name)}"></p></noscript>
<form method="post" action="/logout"><button>Log out</button></form>
<script>
// Fetches the screen, shows it, and fetches it again when its X-TTL (seconds) runs out, or soon
// after the device's expected check-in (X-Check-In, in ms) if that's sooner, to update the text
// from X-Status. An X-TTL of Infinity means the screen never changes: no further fetch then.
const img = document.getElementById("screen");
async function refresh() {
  let delay = 30;
  try {
    const res = await fetch("/screen.png", { cache: "no-store" });
    if (res.status === 401) return location.assign("/login");
    if (res.ok) {
      const old = img.src;
      img.src = URL.createObjectURL(await res.blob());
      if (old) URL.revokeObjectURL(old);
      // Number(null) would be 0, so a missing header needs its own check
      const header = res.headers.get("X-TTL");
      const ttl = header === null ? NaN : Number(header);
      delay = Number.isNaN(ttl) ? 60 : Math.max(ttl, 1);
      const status = res.headers.get("X-Status");
      if (status) {
        const { showing, caption } = JSON.parse(decodeURIComponent(status));
        document.getElementById("showing").textContent = showing;
        document.getElementById("caption").textContent = caption;
      }
      const untilCheckIn = (Number(res.headers.get("X-Check-In")) - Date.now()) / 1000 + 30;
      if (untilCheckIn > 0) delay = Math.min(delay, untilCheckIn);
    }
  } catch {}
  // setTimeout treats delays beyond 2^31 - 1 ms (about 24.8 days), and Infinity, as 0
  if (Number.isFinite(delay)) setTimeout(refresh, Math.min(delay * 1000, 2 ** 31 - 1));
}
refresh();
</script>`,
  );
};
