import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALWAYS,
  all,
  any,
  applies,
  inTimeZone,
  nextChange,
  not,
  parseHours,
} from "../src/conditions.ts";

const bavaria = { country: "de", state: "Bayern" };
const berlin = <T>(fn: () => T) => inTimeZone("Europe/Berlin", fn);

test("conditions apply in the device's time zone", () => {
  const mornings = parseHours("Mo-Fr 06:30-09:00", undefined);
  // Thursday 1 Oct 2026, 07:00 in Berlin is 01:00 in New York
  const at = new Date("2026-10-01T07:00:00+02:00");
  assert.equal(
    berlin(() => applies(mornings, at)),
    true,
  );
  assert.equal(
    inTimeZone("America/New_York", () => applies(mornings, at)),
    false,
  );
  assert.deepEqual(
    berlin(() => nextChange(mornings, at)),
    new Date("2026-10-01T09:00:00+02:00"),
  );
});

test("the time zone is restored afterwards, even on an error", () => {
  const before = process.env.TZ;
  berlin(() => undefined);
  assert.equal(process.env.TZ, before);
  assert.throws(() =>
    inTimeZone("Asia/Tokyo", () => {
      throw new Error("boom");
    }),
  );
  assert.equal(process.env.TZ, before);
});

test("over midnight counts for the day it starts; summer time ends correctly", () => {
  const nights = parseHours("Mo-Fr 22:00-02:00", undefined);
  // Saturday 01:30 belongs to Friday night; Sunday 01:30 to Saturday night, which isn't in it
  assert.equal(
    berlin(() => applies(nights, new Date("2026-10-03T01:30:00+02:00"))),
    true,
  );
  assert.equal(
    berlin(() => applies(nights, new Date("2026-10-04T01:30:00+02:00"))),
    false,
  );
  // From Saturday 24 Oct, the next weekday morning is Monday 26 Oct 06:30, after the change to CET
  const mornings = parseHours("Mo-Fr 06:30-09:00", undefined);
  assert.deepEqual(
    berlin(() => nextChange(mornings, new Date("2026-10-24T12:00:00+02:00"))),
    new Date("2026-10-26T06:30:00+01:00"),
  );
});

test("public holidays need a location, and follow its state", () => {
  assert.throws(() => parseHours("Mo-Fr 06:30-09:00; PH off", undefined), /Country code missing/);
  const commute = parseHours("Mo-Fr 06:30-09:00; PH off", bavaria);
  // Monday 1 Nov 2027 is All Saints' Day, a holiday in Bavaria; Tuesday isn't
  assert.equal(
    berlin(() => applies(commute, new Date("2027-11-01T07:00:00+01:00"))),
    false,
  );
  assert.equal(
    berlin(() => applies(commute, new Date("2027-11-02T07:00:00+01:00"))),
    true,
  );
  const inBerlin = parseHours("Mo-Fr 06:30-09:00; PH off", { country: "de", state: "Berlin" });
  assert.equal(
    berlin(() => applies(inBerlin, new Date("2027-11-01T07:00:00+01:00"))),
    true,
  );
});

test("all, any and not combine conditions, and simplify the trivial cases", () => {
  const mornings = parseHours("Mo-Fr 06:30-09:00", undefined);
  const weekend = parseHours("Sa,Su", undefined);
  const otherwise = not(any([mornings, weekend]));
  const thursdayNoon = new Date("2026-10-01T12:00:00+02:00");
  assert.equal(
    berlin(() => applies(otherwise, thursdayNoon)),
    true,
  );
  assert.equal(
    berlin(() => applies(otherwise, new Date("2026-10-03T12:00:00+02:00"))),
    false,
  );
  // Its next change: the earliest of its parts', Friday 06:30
  assert.deepEqual(
    berlin(() => nextChange(otherwise, thursdayNoon)),
    new Date("2026-10-02T06:30:00+02:00"),
  );
  assert.equal(all([ALWAYS, mornings]), mornings);
  assert.equal(any([ALWAYS, mornings]), ALWAYS);
  assert.equal(not(not(mornings)), mornings);
  assert.deepEqual(not(ALWAYS), { kind: "never" });
  assert.equal(nextChange(ALWAYS, thursdayNoon), undefined);
});

test("sunrise and sunset come from the location's coordinates, with offsets", () => {
  const munich = { country: "de", state: "Bayern", lat: 48.137, lon: 11.575 };
  const early = new Date("2026-10-12T05:00:00+02:00");
  const time = (date: Date | undefined) =>
    date?.toLocaleTimeString("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
    });
  // Sunrise in Munich on 12 October is at about 07:28, sunset at about 18:31
  assert.equal(
    time(berlin(() => nextChange(parseHours("sunrise-sunset", munich), early))),
    "07:28",
  );
  assert.equal(
    time(berlin(() => nextChange(parseHours("(sunrise-01:00)-sunrise", munich), early))),
    "06:28",
  );
  const evening = parseHours("sunset-(sunset+00:30)", munich);
  assert.equal(
    berlin(() => applies(evening, new Date("2026-10-12T18:45:00+02:00"))),
    true,
  );
  assert.equal(
    berlin(() => applies(evening, new Date("2026-10-12T19:15:00+02:00"))),
    false,
  );
});
