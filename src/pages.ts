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

/** Where the device is in its playlist, and when it's expected to check in next. */
export interface PlaylistStatus {
  /** The current playlist entry's screen, its position (from 1) and the playlist's length */
  screen: string;
  position: number;
  count: number;
  expectedCheckIn: Date | undefined;
  now: Date;
  timeZone: string;
}

/**
 * The screen page's text about the playlist, as plain text: sent with the page, and again with
 * each /screen.png (X-Status), so the page keeps up when the device checks in or another tab
 * moves the playlist on.
 */
export function statusText({ screen, position, count, expectedCheckIn, now, timeZone }: PlaylistStatus) {
  const showing = count > 1 ? `Showing ${screen} (${position} of ${count}).` : `Showing ${screen}.`;
  // The device only picks up a change at its next check-in, if that's known
  let checkIn = "It hasn't checked in since the server started.";
  if (expectedCheckIn) {
    const time = formatTime(expectedCheckIn, now, timeZone);
    checkIn = expectedCheckIn >= now ? `Its next check-in is expected around ${time}.` : `Its next check-in was expected around ${time}.`;
  }
  return { showing, checkIn: `The device shows changes from its next check-in. ${checkIn}` };
}

export const screenPage = (name: string, status: PlaylistStatus) => {
  const { showing, checkIn } = statusText(status);
  const showingHtml = `<span id="showing">${escapeHtml(showing)}</span>`;
  const playlist =
    status.count > 1
      ? `<form method="post" action="/next"><p>${showingHtml} <button>Next</button></p></form>`
      : `<p>${showingHtml}</p>`;
  return page(
    `TRMNL: ${name}`,
    `${playlist}
<p id="check-in">${escapeHtml(checkIn)}</p>
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
        const { showing, checkIn } = JSON.parse(decodeURIComponent(status));
        document.getElementById("showing").textContent = showing;
        document.getElementById("check-in").textContent = checkIn;
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
