import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { Device } from "../src/config.ts";
import {
  firmwareLogEntries,
  serverLog,
  streamLogs,
  watchLogs,
  type LogEntry,
} from "../src/logs.ts";

const device = (username: string) => ({ username }) as Device;

test("a firmware log upload: its entries, with their time, level and details", () => {
  const now = Date.UTC(2026, 9, 17, 12);
  const entries = firmwareLogEntries(
    {
      logs: [
        {
          created_at: 1_790_000_000,
          id: 7,
          message: "Receiving failed; file size too big: 95000",
          source_line: 2007,
          source_path: "src/bl.cpp",
          battery_voltage: 4.1,
          firmware_version: "1.6.9",
          level: "error",
        },
        // Before the device's clock was set, and with an unknown level
        { created_at: 12, message: "WiFi connected", level: "loud" },
        // Not entries
        { created_at: 1_790_000_000 },
        "text",
      ],
    },
    now,
  );
  assert.deepEqual(entries, [
    {
      time: 1_790_000_000_000,
      source: "device",
      level: "error",
      message: "Receiving failed; file size too big: 95000",
      details: { source: "src/bl.cpp:2007", firmware: "1.6.9", "battery (V)": 4.1, "log ID": 7 },
    },
    { time: now, source: "device", level: "info", message: "WiFi connected", details: {} },
  ]);
  assert.deepEqual(firmwareLogEntries(undefined), []);
  assert.deepEqual(firmwareLogEntries({ logs: "x" }), []);
});

test("log entries go to the device's watchers only, until they stop", () => {
  const seen: string[] = [];
  const stop = watchLogs(device("kitchen"), (entry) => seen.push(entry.message));
  serverLog(device("kitchen"), "info", "one");
  serverLog(device("hallway"), "info", "elsewhere");
  stop();
  serverLog(device("kitchen"), "info", "after");
  assert.deepEqual(seen, ["one"]);
});

test("the stream sends entries from when it connects, nothing earlier", async () => {
  const app = express();
  app.get("/stream", (req, res) => streamLogs(device("kitchen"), req, res, 20));
  const server = app.listen(0);
  try {
    serverLog(device("kitchen"), "info", "before anyone watched");
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`, {
      signal: controller.signal,
    });
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = (await reader.read()).value ?? "";
    assert.match(text, /^: connected/);
    serverLog(device("kitchen"), "warn", "now");
    // The entry, and pings (every 20 ms here) in between
    while (!text.includes("data: ")) text += (await reader.read()).value ?? "";
    while (!text.includes("\n\n", text.indexOf("data: "))) text += (await reader.read()).value;
    const data = text.slice(
      text.indexOf("data: ") + 6,
      text.indexOf("\n\n", text.indexOf("data: ")),
    );
    const entry = JSON.parse(data) as LogEntry;
    assert.equal(entry.message, "now");
    assert.equal(entry.level, "warn");
    assert.ok(!text.includes("before anyone watched"));
    controller.abort();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
