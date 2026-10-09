const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title, body) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
${body}
</html>
`;

export const loginPage = ({ error }) =>
  page(
    "TRMNL login",
    `<h1>TRMNL</h1>
${error ? "<p>Wrong username or password.</p>\n" : ""}<form method="post" action="/login">
<p><label>Username <input name="username" autocomplete="username" required autofocus></label></p>
<p><label>Password <input type="password" name="password" autocomplete="current-password" required></label></p>
<p><button>Log in</button></p>
</form>`,
  );

export const screenPage = ({ name }) =>
  page(
    `TRMNL: ${name}`,
    `<p><img id="screen" width="800" height="480" alt="Screen for ${escapeHtml(name)}"></p>
<noscript><p><img src="/screen.png" width="800" height="480" alt="Screen for ${escapeHtml(name)}"></p></noscript>
<form method="post" action="/logout"><button>Log out</button></form>
<script>
// Fetches the screen, shows it, and fetches it again when its X-TTL (seconds) runs out. An X-TTL
// of Infinity means the screen never changes: no further fetch.
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
    }
  } catch {}
  // setTimeout treats delays beyond 2^31 - 1 ms (about 24.8 days), and Infinity, as 0
  if (Number.isFinite(delay)) setTimeout(refresh, Math.min(delay * 1000, 2 ** 31 - 1));
}
refresh();
</script>`,
  );
