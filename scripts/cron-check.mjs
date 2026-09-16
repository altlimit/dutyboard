#!/usr/bin/env node
// The clock behind recurring duties, checked on its own.
//
// Everything here is arithmetic — no datastore, no network — and it is the part of schedules.js
// that is hardest to see is wrong: a schedule that fires an hour late twice a year, or twice in
// one minute, or never, looks exactly like a schedule that works until the day it matters. The
// smoke suite exercises the tick end to end against the emulator; this checks the maths under it.
//
//   node scripts/cron-check.mjs

import { parseCron, nextRun, nextRuns } from "../functions/src/schedules.js";

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

/** A run as UTC, for comparing against what a person would have written down. */
const iso = (ms) => (ms == null ? "never" : new Date(ms).toISOString().replace(".000Z", "Z"));
const at = (s) => Date.parse(s);
const runs = (expr, from, offset = 0, count = 3) => nextRuns(parseCron(expr), at(from), offset, count).map(iso);

console.log("cron");
check(
  "9am every Monday, in UTC",
  runs("0 9 * * 1", "2026-09-15T20:00:00Z")[0] === "2026-09-21T09:00:00Z",
  runs("0 9 * * 1", "2026-09-15T20:00:00Z")[0],
);
check("every weekday morning", JSON.stringify(runs("30 6 * * 1-5", "2026-09-18T12:00:00Z", 0, 3)) === JSON.stringify(["2026-09-21T06:30:00Z", "2026-09-22T06:30:00Z", "2026-09-23T06:30:00Z"]), runs("30 6 * * 1-5", "2026-09-18T12:00:00Z", 0, 3).join(", "));
check("the first of the month", runs("0 0 1 * *", "2026-09-15T20:00:00Z")[0] === "2026-10-01T00:00:00Z");
check("every four hours", JSON.stringify(runs("0 */4 * * *", "2026-09-15T09:10:00Z", 0, 2)) === JSON.stringify(["2026-09-15T12:00:00Z", "2026-09-15T16:00:00Z"]));
check("weekday names, and Sunday as both 0 and 7", runs("0 12 * * sun", "2026-09-15T00:00:00Z")[0] === runs("0 12 * * 7", "2026-09-15T00:00:00Z")[0]);
check("month names", runs("0 0 1 jan *", "2026-09-15T00:00:00Z")[0] === "2027-01-01T00:00:00Z");
check("a step from a start, '5/15'", JSON.stringify(runs("5/15 * * * *", "2026-09-15T09:00:00Z", 0, 3)) === JSON.stringify(["2026-09-15T09:05:00Z", "2026-09-15T09:20:00Z", "2026-09-15T09:35:00Z"]));
check("a list of hours", JSON.stringify(runs("0 9,17 * * *", "2026-09-15T10:00:00Z", 0, 2)) === JSON.stringify(["2026-09-15T17:00:00Z", "2026-09-16T09:00:00Z"]));
check("leap day comes round in a leap year", runs("0 0 29 2 *", "2026-09-15T00:00:00Z")[0] === "2028-02-29T00:00:00Z");

// Cron's oldest wart, honoured rather than fixed: with BOTH day fields restricted, either matches.
// Every Friday AND the 13th of each month: from Tuesday 15 September that is the next four
// Fridays, then Tuesday 13 October.
const both = runs("0 0 13 * 5", "2026-09-15T00:00:00Z", 0, 6);
check("both day fields restricted means either may match", both[0] === "2026-09-18T00:00:00Z" && both.includes("2026-10-13T00:00:00Z"), both.join(", "));

console.log("timezones, as an offset");
// The whole point of the offset: the expression is local time.
check(
  "9am Monday in Chicago on standard time (UTC-6) is 15:00 UTC",
  runs("0 9 * * 1", "2026-11-25T00:00:00Z", -360)[0] === "2026-11-30T15:00:00Z",
  runs("0 9 * * 1", "2026-11-25T00:00:00Z", -360)[0],
);
check(
  "the same 9am on daylight time (UTC-5) is 14:00 UTC",
  runs("0 9 * * 1", "2026-09-15T00:00:00Z", -300)[0] === "2026-09-21T14:00:00Z",
  runs("0 9 * * 1", "2026-09-15T00:00:00Z", -300)[0],
);
check("a zone ahead of UTC (Manila, +8) moves the day too", runs("0 9 * * 1", "2026-09-15T00:00:00Z", 480)[0] === "2026-09-21T01:00:00Z");
check("an offset that is not whole hours (Kolkata, +5:30)", runs("0 9 * * *", "2026-09-15T00:00:00Z", 330)[0] === "2026-09-15T03:30:00Z");

console.log("edges");
check("a run is never returned in the past", nextRun(parseCron("* * * * *"), at("2026-09-15T09:00:30Z")) > at("2026-09-15T09:00:30Z"));
check("and never twice in the same minute", nextRun(parseCron("* * * * *"), at("2026-09-15T09:00:00Z")) === at("2026-09-15T09:01:00Z"));
check("an expression that never comes round answers nothing", nextRun(parseCron("0 0 31 2 *"), at("2026-09-15T00:00:00Z")) === null);
check("31st of the month skips the months that have none", JSON.stringify(runs("0 0 31 * *", "2026-09-15T00:00:00Z", 0, 2)) === JSON.stringify(["2026-10-31T00:00:00Z", "2026-12-31T00:00:00Z"]));

console.log("refusals");
const refuses = (expr, why) => {
  try {
    parseCron(expr);
    check(why, false, "it was accepted");
  } catch (err) {
    check(why, /INVALID_ARGUMENT/.test(err.code || "") || err.status === 400, String(err && err.message).slice(0, 80));
  }
};
refuses("0 9 * *", "four fields is not a schedule");
refuses("", "nothing is not a schedule");
refuses("60 * * * *", "minute 60 does not exist");
refuses("0 9 * * funday", "an unknown day name");
refuses("0 9-5 * * *", "a range that counts backwards");
refuses("0 */0 * * *", "a step of zero");

console.log(failed ? `\n✗ ${failed} failed` : "\n✔ all cron checks passed");
process.exit(failed ? 1 : 0);
