// Seconds added to a ttl, so a device or browser that wakes slightly early doesn't redraw the
// minute that is just ending and then wake again straight away.
const SAFETY_SECONDS = 2;

/** Seconds until the next minute starts (plus a margin): the ttl of anything showing minutes. */
export function untilNextMinute(now: Date) {
  // Every time zone in use is offset from UTC by whole minutes, so minutes tick together everywhere
  const msLeft = 60_000 - (now.getTime() % 60_000);
  return Math.ceil(msLeft / 1000) + SAFETY_SECONDS;
}

export const formatTime = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone }).format(date);
