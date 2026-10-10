import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import { serverDomain, setupEnabled } from "./config.ts";
import { deviceApi } from "./device-api.ts";
import { loginPage, screenPage } from "./pages.ts";
import { renderDeviceScreen } from "./screen.ts";
import { checkLogin, endSession, sessionDevice, startSession } from "./session.ts";

const port = Number(process.env.SERVER_PORT ?? 7777);

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
  res.type("html").send(screenPage({ name: device.username }));
});

app.get("/screen.png", async (req, res) => {
  const device = sessionDevice(req);
  if (!device) return res.status(401).type("text").send("Not logged in\n");
  const { png, ttl } = await renderDeviceScreen(device);
  // X-TTL tells the page's script when to fetch the next image
  res.type("png").set({ "Cache-Control": "no-store", "X-TTL": String(ttl) }).send(png);
});

app.get("/login", (req, res) => {
  if (sessionDevice(req)) return res.redirect(303, "/");
  res.type("html").send(loginPage({ error: "error" in req.query }));
});

app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
  const { username, password } = req.body ?? {};
  // Repeated form fields arrive as arrays, so only plain strings count as a login attempt
  const device = typeof username === "string" && typeof password === "string" && checkLogin(username, password);
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
  res.status(status).type("text").send(status === 500 ? "Internal error\n" : `${err.message}\n`);
}) satisfies ErrorRequestHandler);

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
  if (!serverDomain) console.warn("SERVER_DOMAIN is not set: image URLs are built from each request's Host header");
  if (setupEnabled) console.warn("SETUP_ENABLED=1: /api/setup hands out tokens to any listed MAC. Turn it off after pairing.");
});
