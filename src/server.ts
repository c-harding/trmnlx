import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import { checkOnly, devices, serverDomain, setupEnabled, type Device } from "./config.ts";
import { deviceApi } from "./device-api.ts";
import { loginPage, screenPage, statusText, type PlaylistStatus } from "./pages.ts";
import {
  activePlaylist,
  choosePlaylist,
  currentEntry,
  lastCheckIn,
  moveOn,
} from "./device-state.ts";
import type { MapView } from "./map-drawing.ts";
import type { PlaylistEntry } from "./playlists.ts";
import { renderDeviceScreen, screens, warmAtWindowChanges, warmDeviceScreens } from "./screen.ts";
import { loadMap, removeUnusedMaps } from "./sources/map.ts";
import { checkLogin, endSession, sessionDevice, startSession } from "./session.ts";
import { flushState, persistTo } from "./state-file.ts";

const port = Number(process.env.SERVER_PORT ?? 7777);

// Loading the config (on import) has checked it, and would have stopped here if it were wrong
if (checkOnly) {
  console.log(`Config OK: ${devices.length} device(s)`);
  process.exit(0);
}

// Next to server.js: a Docker volume on the server (see docker-compose.yml)
persistTo(new URL("./state/", import.meta.url));

// Saved maps of views no longer in devices.yaml, or drawn in an older style, take up space for nothing.
// The views in use: what every entry's of every playlist (and default screen's) render would ask the
// map source for
const mapViews = devices.flatMap((device) =>
  [...device.playlists.flatMap((playlist) => playlist.entries), device.defaultScreen].flatMap(
    (entry) =>
      screens[entry.screen]
        .calls({ device, now: new Date(), telemetry: undefined, inputs: entry.inputs })
        .filter((call) => call.source === loadMap)
        .map((call) => call.params as MapView),
  ),
);
removeUnusedMaps(mapViews).catch((error) => console.error("Removing unused maps failed:", error));

// What each device can show next, so the first switch after a deploy needn't wait for slow data,
// and again whenever its `when` windows change that
for (const device of devices) {
  warmDeviceScreens(device);
  warmAtWindowChanges(device);
}

const app = express();
app.disable("x-powered-by");
// Caddy on the host sets X-Forwarded-Proto, so req.secure reflects HTTPS. Requests arrive from
// Docker's bridge network rather than loopback, so trust any proxy: the port is only published on
// 127.0.0.1, so nothing else can reach the server to fake these headers.
app.set("trust proxy", true);
app.use(deviceApi);
app.use(cookieParser());

app.get("/", (req, res) => {
  const device = sessionDevice(req);
  if (!device) return res.redirect(303, "/login");
  res.type("html").send(screenPage(device.username, playlistStatus(device)));
});

/** An entry as the page names it: its screen, and its label if it has one, e.g. "map: Graz". */
function entryName({ screen, inputs }: PlaylistEntry) {
  const label = screens[screen].label(inputs);
  return label ? `${screen}: ${label}` : screen;
}

function playlistStatus(device: Device): PlaylistStatus {
  const { entry, index, applying } = currentEntry(device);
  const checkIn = lastCheckIn(device);
  const playlist = activePlaylist(device);
  return {
    playlist: playlist.name,
    choices: device.playlists.filter((p) => p.offered).map((p) => p.name),
    screen: entryName(entry),
    index,
    position: applying.indexOf(index) + 1,
    count: applying.length,
    otherTimes: [
      ...new Set(playlist.entries.filter((_entry, i) => !applying.includes(i)).map(entryName)),
    ],
    checkIn,
    now: new Date(),
    timeZone: device.timeZone,
  };
}

// Move the device's playlist on or back, as KEY3 does; the device shows it from its next check-in
for (const [path, step] of [
  ["/next", 1],
  ["/previous", -1],
] as const) {
  app.post(path, (req, res) => {
    const device = sessionDevice(req);
    if (!device) return res.redirect(303, "/login");
    moveOn(device, step);
    warmDeviceScreens(device);
    res.redirect(303, "/");
  });
}

// Switch the device to another of its playlists; the device shows it from its next check-in
app.post("/playlist", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
  const device = sessionDevice(req);
  if (!device) return res.redirect(303, "/login");
  const { name } = req.body ?? {};
  if (typeof name === "string") {
    choosePlaylist(device, name);
    warmDeviceScreens(device);
    // Its `when` windows are another playlist's
    warmAtWindowChanges(device);
  }
  res.redirect(303, "/");
});

app.get("/screen.png", async (req, res) => {
  const device = sessionDevice(req);
  if (!device) return res.status(401).type("text").send("Not logged in\n");
  // Before rendering, so the screens one press away load while this one renders
  warmDeviceScreens(device);
  // Before rendering too, so it describes the same entry even if another request moves on meanwhile
  const status = playlistStatus(device);
  const { png, ttl, credits } = await renderDeviceScreen(device);
  // X-TTL tells the page's script when to fetch the next image; X-Status and X-Check-In keep its
  // text up to date (URI-encoded, as header values can't take all of Unicode)
  res
    .type("png")
    .set({
      "Cache-Control": "no-store",
      "X-TTL": String(ttl),
      "X-Status": encodeURIComponent(JSON.stringify(statusText(status))),
      "X-Check-In": String(status.checkIn?.next.getTime() ?? ""),
      // What this image shows may need crediting (see credits.ts)
      "X-Credits": encodeURIComponent(JSON.stringify(credits)),
    })
    .send(png);
});

app.get("/login", (req, res) => {
  if (sessionDevice(req)) return res.redirect(303, "/");
  res.type("html").send(loginPage({ error: "error" in req.query }));
});

app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
  const { username, password } = req.body ?? {};
  // Repeated form fields arrive as arrays, so only plain strings count as a login attempt
  const device =
    typeof username === "string" && typeof password === "string" && checkLogin(username, password);
  if (!device) return res.redirect(303, "/login?error");
  startSession(req, res, device);
  res.redirect(303, "/");
});

app.post("/logout", (req, res) => {
  endSession(req, res);
  res.redirect(303, "/login");
});

app.use(((err, req, res, next) => {
  // Client errors (e.g. 413 from body parsing) come with a status and need no stack trace
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return next(err);
  res
    .status(status)
    .type("text")
    .send(status === 500 ? "Internal error\n" : `${err.message}\n`);
}) satisfies ErrorRequestHandler);

const server = app.listen(port, () => {
  console.log(`Listening on port ${port}`);
  if (!serverDomain)
    console.warn("SERVER_DOMAIN is not set: image URLs are built from each request's Host header");
  if (setupEnabled)
    console.warn(
      "SETUP_ENABLED=1: /api/setup hands out tokens to any listed MAC. Turn it off after pairing.",
    );
});

// docker stop sends SIGTERM (node as PID 1 would otherwise ignore it until killed): end open
// requests, save pending state and stop
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
    flushState();
    process.exit(0);
  });
}
