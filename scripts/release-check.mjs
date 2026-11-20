#!/usr/bin/env node
// /release: the version comparison, and the remembered answer — without the network.
import assert from "node:assert/strict";
import { compareVersions, releaseStatus, _resetRelease } from "../functions/src/release.js";
const VERSION = "2.36.0";

assert.equal(compareVersions("2.37.0", "2.36.9"), 1);
assert.equal(compareVersions("2.36.0", "2.36.0"), 0);
assert.equal(compareVersions("2.9.0", "2.10.0"), -1, "numbers, not strings");
assert.equal(compareVersions("v3.0.0", "2.99.99"), 1);
assert.equal(compareVersions("dev", "2.36.0"), null);

const bump = () => "2.37.0";
let calls = 0;
let answer = { version: bump(VERSION) };
globalThis.fetch = async (url) => {
  calls++;
  assert.equal(url, "https://www.dutyboard.com/deploy/latest/altengine.json");
  if (answer === "down") throw new Error("offline");
  return new Response(JSON.stringify(answer), { status: 200 });
};
const cfg = { app: "dutyboard" };

_resetRelease();
let r = await releaseStatus({}, cfg, 1_000, VERSION);
assert.deepEqual([r.current, r.latest, r.update_available, r.app], [VERSION, bump(VERSION), true, "dutyboard"]);
await releaseStatus({}, cfg, 2_000, VERSION);
assert.equal(calls, 1, "remembered: one fetch for many page loads");

answer = { version: VERSION };
r = await releaseStatus({}, cfg, 1_000 + 7 * 3600_000, VERSION);
assert.equal(calls, 2, "asked again once it is stale");
assert.equal(r.update_available, false, "up to date");

_resetRelease();
answer = "down";
r = await releaseStatus({}, { app: "" }, 0, VERSION);
assert.deepEqual([r.latest, r.update_available, r.app], [null, false, null], "a site that cannot be reached says nothing");
await releaseStatus({}, cfg, 10 * 60_000, VERSION);
assert.equal(calls, 3, "a failure is retried sooner, not every load");

console.log("release passed: versions compare as numbers, the answer is remembered, and a failure says nothing.");
