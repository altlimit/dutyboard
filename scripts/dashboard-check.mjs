#!/usr/bin/env node
// The boards page's numbers, checked without a datastore.
//
// What it counts has to be true in the cases that are easy to get wrong: a duty sent back and
// finished again, a cancellation, a suggestion turned down, a duty marked done by hand, a board
// whose done duties are removed a day later, and a fortnight that crosses a clock change.
//
//   node scripts/dashboard-check.mjs

import assert from "node:assert/strict";
import { enqueueDuty, claimDuty, completeDuty, failDuty, cancelDuty, reopenDuty, updateDuty, sweepOldFinishes, FINISHES_KEPT_MS } from "../functions/src/duties.js";
import { createSchedule, updateSchedule, upcomingSchedules } from "../functions/src/schedules.js";
import { listUpcoming } from "../functions/src/projects.js";
import { finishesByDay, finishesRequest, lastDays, machinesOnline, runsByDuty, totals, TREND_DAYS } from "../app/src/lib/boards.js";
import { until } from "../app/src/lib/duties.js";
import { testStore } from "./test-store.mjs";

let failed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${what}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${what} — ${err.message}`);
  }
};

const { store, table } = testStore();
const human = { kind: "human", uid: "owner", name: "Owner" };
const machine = { kind: "agent", projectId: "board", machineId: "m1", ownerUid: "owner", agentPrefix: "machine", defaultAgentId: "machine/1", machineRow: { machine_id: "m1", cli_version: "9.9.9" } };
const ctx = (caller = human) => ({ caller, store, cfg: {}, env: {}, publish: async () => {} });
await store.putOne("projects", "board", { owner_uid: "owner", name: "Board" });
await store.putOne("machine_links", "board:m1", { project_id: "board", machine_id: "m1", owner_uid: "owner", agent_prefix: "machine" });

const file = async (title) => (await enqueueDuty(ctx(), { project_id: "board", title, brief: "Do it" })).duty_id;
const work = async (id) => claimDuty(ctx(machine), { duty_id: id, agent_id: "machine/1" });
const finishes = () => [...table("finishes").values()];

console.log("finishes");
await check("a claim stamps when it started, and finishing stamps when it ended", async () => {
  const id = await file("one");
  await work(id);
  const claimed = table("duties").get(id).claimed_at;
  assert.ok(claimed > 0);
  await completeDuty(ctx(machine), { duty_id: id, agent_id: "machine/1", outcome_summary: "done" });
  const duty = table("duties").get(id);
  assert.ok(duty.finished_at >= claimed);
  const row = table("finishes").get(`${id}-0`);
  assert.deepEqual([row.done, row.failed, row.claimed_at, row.project_id, row.owner_uid, row.agent_id], [1, 0, claimed, "board", "owner", "machine/1"]);
  assert.equal(row.hour, Math.floor(row.finished_at / 3600000));
});

await check("sent back and finished again counts twice, and the reopened duty is not finished", async () => {
  const id = await file("twice");
  await work(id);
  await completeDuty(ctx(machine), { duty_id: id, agent_id: "machine/1", outcome_summary: "first" });
  await reopenDuty(ctx(), { duty_id: id, note: "it does not work" });
  assert.equal(table("duties").get(id).finished_at, null);
  await work(id);
  await completeDuty(ctx(machine), { duty_id: id, agent_id: "machine/1", outcome_summary: "second" });
  assert.ok(table("finishes").get(`${id}-0`) && table("finishes").get(`${id}-1`));
});

await check("an agent's failure counts as failed", async () => {
  const id = await file("broken");
  await work(id);
  await failDuty(ctx(machine), { duty_id: id, agent_id: "machine/1", reason: "could not" });
  assert.deepEqual([table("finishes").get(`${id}-0`).done, table("finishes").get(`${id}-0`).failed], [0, 1]);
});

await check("a cancellation is not counted as a failure", async () => {
  const id = await file("never mind");
  await cancelDuty(ctx(), { duty_id: id, reason: "changed my mind" });
  assert.equal(table("duties").get(id).status, "failed");
  assert.equal(table("finishes").get(`${id}-0`), undefined);
});

await check("marked done by hand counts; moved to failed by hand does not", async () => {
  const a = await file("by hand");
  await updateDuty(ctx(), { duty_id: a, status: "done" });
  assert.equal(table("finishes").get(`${a}-0`).done, 1);
  assert.ok(table("duties").get(a).finished_at > 0);
  const b = await file("called off");
  await updateDuty(ctx(), { duty_id: b, status: "failed" });
  assert.equal(table("finishes").get(`${b}-0`), undefined);
  await updateDuty(ctx(), { duty_id: a, status: "queued" });
  assert.equal(table("duties").get(a).finished_at, null);
});

await check("a finish outlives the duty it counts", async () => {
  const id = await file("short-lived");
  await work(id);
  await completeDuty(ctx(machine), { duty_id: id, agent_id: "machine/1", outcome_summary: "done" });
  table("duties").delete(id);
  assert.ok(table("finishes").get(`${id}-0`));
});

await check("finishes past what the page shows are forgotten, and only those", async () => {
  const now = Date.now();
  await store.putOne("finishes", "old-0", { project_id: "board", owner_uid: "owner", done: 1, failed: 0, hour: 1, finished_at: now - FINISHES_KEPT_MS - 1 });
  const before = finishes().length;
  assert.equal(await sweepOldFinishes(ctx(), now), 1);
  assert.equal(finishes().length, before - 1);
  assert.equal(table("finishes").get("old-0"), undefined);
});

console.log("up next");
await check("enabled schedules, soonest first, with each board's next", async () => {
  await store.putOne("projects", "other", { owner_uid: "owner", name: "Other" });
  const a = (await createSchedule(ctx(), { project_id: "board", title: "weekly", brief: "b", cron: "0 9 * * 1", tz: "UTC" })).schedule;
  const b = (await createSchedule(ctx(), { project_id: "other", title: "daily", brief: "b", cron: "0 6 * * *", tz: "UTC" })).schedule;
  const c = (await createSchedule(ctx(), { project_id: "board", title: "paused", brief: "b", cron: "0 7 * * *", tz: "UTC" })).schedule;
  await updateSchedule(ctx(), { schedule_id: c.schedule_id, enabled: false });
  const res = await upcomingSchedules(ctx(), ["board", "other"]);
  assert.deepEqual(res.schedules.map((s) => s.title).sort(), ["daily", "weekly"]);
  assert.ok(res.schedules[0].next_due_at <= res.schedules[1].next_due_at);
  assert.equal(res.total, 2);
  assert.equal(res.next.board.schedule_id, a.schedule_id);
  assert.equal(res.next.other.schedule_id, b.schedule_id);
});

await check("a board you are not on refuses the whole request", async () => {
  await store.putOne("projects", "theirs", { owner_uid: "someone-else", name: "Theirs" });
  await assert.rejects(() => listUpcoming(ctx(), { project_ids: ["board", "theirs"] }), /do not own/);
  await assert.rejects(() => listUpcoming(ctx(), { project_ids: ["board", "missing"] }), /not found/);
  assert.equal((await listUpcoming(ctx(), { project_ids: ["board"] })).total, 1);
});

console.log("the page's sums");
await check("totals add every board's statuses", () => {
  const t = totals({ a: { queued: 2, active: 1, needs_decision: 1 }, b: { queued: 3, failed: 1, done: 4 } });
  assert.deepEqual([t.queued, t.active, t.needs_decision, t.failed, t.done, t.blocked], [5, 1, 1, 1, 4, 0]);
});

await check("hours fold into local days, today last, and the request starts at the first of them", () => {
  const now = Date.parse("2026-11-18T15:00:00");
  const req = finishesRequest(now);
  const first = req.where[0].value;
  const h = Math.floor(now / 3600000);
  const days = finishesByDay(
    [
      { group: { hour: h }, metrics: { done: 3, failed: 1 } },
      { group: { hour: h - 24 }, metrics: { done: 2, failed: 0 } },
      { group: { hour: first }, metrics: { done: 5, failed: 0 } },
      { group: { hour: first - 1 }, metrics: { done: 99, failed: 0 } },
    ],
    now,
  );
  assert.equal(days.length, TREND_DAYS);
  assert.deepEqual([days[0].done, days[12].done, days[13].done], [5, 2, 3]);
  assert.equal(lastDays(days, 7, "done"), 5);
  assert.equal(lastDays(days, 7, "failed"), 1);
  assert.equal(lastDays(days, TREND_DAYS, "done"), 10);
  assert.equal(new Date(days[0].start).getHours(), 0);
});

await check("a fortnight across a clock change still starts every day at midnight", () => {
  const days = finishesByDay([], Date.parse("2026-11-08T12:00:00"));
  for (const d of days) assert.equal(new Date(d.start).getHours(), 0);
  for (let i = 1; i < days.length; i++) assert.ok(days[i].start > days[i - 1].start);
});

await check("machines are counted once however many boards they work", () => {
  const link = (id, online, runs = []) => ({ machine_id: id, machine_name: id, online, runs });
  const runners = { a: [link("m1", true, [{ duty_id: "d1", state: "limited" }]), link("m2", false)], b: [link("m1", true)] };
  assert.equal(machinesOnline(runners), 1);
  assert.equal(runsByDuty(runners).d1.state, "limited");
  assert.equal(runsByDuty(runners).d1.machine, "m1");
});

await check("time until a run, in words", () => {
  const now = 1_000_000_000_000;
  assert.equal(until(now + 30_000, now), "due now");
  assert.equal(until(now - 120_000, now), "due now");
  assert.equal(until(now + 40 * 60_000, now), "in 40m");
  assert.equal(until(now + 3 * 3600_000, now), "in 3h");
  assert.equal(until(now + 50 * 3600_000, now), "in 2d");
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
