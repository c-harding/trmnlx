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
// Fetches the screen, shows it, and fetches it again when its X-TTL (seconds) runs out.
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
      delay = Number(res.headers.get("X-TTL")) || 60;
    }
  } catch {}
  setTimeout(refresh, delay * 1000);
}
refresh();
</script>`,
  );
