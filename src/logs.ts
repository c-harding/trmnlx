// Live logs per device, for the /logs page: what the device sends to /api/log, and the server's own
// events for it. Sent only to the browsers watching at the time, as Server-Sent Events: nothing is
// kept, in memory or on disk, and nothing goes to stdout (Docker's default logging driver keeps
// all of that, with no rotation).
import type { Request, Response } from "express";
import type { Device } from "./config.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  /** When it happened, in ms */
  time: number;
  /** Who logged it: the device (its firmware) or the server */
  source: "device" | "server";
  level: LogLevel;
  message: string;
  /** More about it, e.g. where in the firmware, or the device's battery and Wi-Fi */
  details?: Record<string, string | number | boolean>;
}

// The browsers watching each device's logs, by username
const watchers = new Map<string, Set<(entry: LogEntry) => void>>();

/** Calls `listener` with each of the device's log entries from now on, until the returned stop. */
export function watchLogs(device: Device, listener: (entry: LogEntry) => void) {
  const forDevice = watchers.get(device.username) ?? new Set();
  forDevice.add(listener);
  watchers.set(device.username, forDevice);
  return () => {
    forDevice.delete(listener);
    if (forDevice.size === 0) watchers.delete(device.username);
  };
}

/** Sends an entry to whoever is watching the device's logs; with nobody watching, it's dropped. */
export function logEntry(device: Device, entry: LogEntry) {
  for (const listener of watchers.get(device.username) ?? []) listener(entry);
}

/** One of the server's own events about the device, e.g. a check-in or a rejected token. */
export function serverLog(
  device: Device,
  level: LogLevel,
  message: string,
  details?: LogEntry["details"],
) {
  logEntry(device, { time: Date.now(), source: "server", level, message, details });
}

const LEVELS = new Set<string>(["debug", "info", "warn", "error", "fatal"]);
// Before this, a device's clock hasn't been set (from NTP) yet: its entries get the time they arrive
const EARLIEST_CLOCK_S = Date.UTC(2024, 0, 1) / 1000;
// The firmware's fields that go into an entry's details, renamed
const DETAILS: Record<string, string> = {
  firmware_version: "firmware",
  battery_voltage: "battery (V)",
  wifi_signal: "Wi-Fi signal (dBm)",
  wifi_status: "Wi-Fi status",
  wake_reason: "wake reason",
  sleep_duration: "slept (s)",
  refresh_rate: "refresh rate (s)",
  special_function: "special function",
  free_heap_size: "free heap (bytes)",
  max_alloc_size: "largest block (bytes)",
  retry: "retry",
  id: "log ID",
};

/**
 * The entries of a firmware log upload: `{ logs: [{ created_at, level, message, source_path,
 * source_line, …device status }] }` (see serialize_log.cpp in the firmware). Anything else is
 * skipped.
 */
export function firmwareLogEntries(body: unknown, now = Date.now()): LogEntry[] {
  const logs = (body as { logs?: unknown } | undefined)?.logs;
  if (!Array.isArray(logs)) return [];
  return logs.flatMap((log): LogEntry[] => {
    if (typeof log !== "object" || log === null) return [];
    const fields = log as Record<string, unknown>;
    if (typeof fields.message !== "string") return [];
    const createdAt = Number(fields.created_at);
    const details: Record<string, string | number | boolean> = {};
    if (typeof fields.source_path === "string")
      details.source = `${fields.source_path}${fields.source_line ? `:${fields.source_line}` : ""}`;
    for (const [key, name] of Object.entries(DETAILS)) {
      const value = fields[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        details[name] = value;
    }
    return [
      {
        time: Number.isFinite(createdAt) && createdAt >= EARLIEST_CLOCK_S ? createdAt * 1000 : now,
        source: "device",
        level: LEVELS.has(String(fields.level)) ? (fields.level as LogLevel) : "info",
        message: fields.message,
        details,
      },
    ];
  });
}

// A comment line this often, as Cloudflare closes connections that stay silent for about 100 s
const PING_MS = 30_000;

/**
 * Streams the device's log entries to a browser as Server-Sent Events, from now until it
 * disconnects (its EventSource reconnects by itself). Each event's data is a LogEntry as JSON.
 */
export function streamLogs(device: Device, req: Request, res: Response, pingMs = PING_MS) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    // So a proxy passes each event on straight away
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  // Something to read straight away, so the page knows it's connected
  res.write(": connected\n\n");
  const stop = watchLogs(device, (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
  req.on("close", () => {
    stop();
    clearInterval(ping);
  });
}
