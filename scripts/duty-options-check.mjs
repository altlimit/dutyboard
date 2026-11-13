#!/usr/bin/env node
import assert from "node:assert/strict";
import { enqueueDuty, updateDuty, getDuty, claimDuty } from "../functions/src/duties.js";
import { createSchedule, updateSchedule, runDueSchedules } from "../functions/src/schedules.js";
import { updateMachine, machineMe, pollMachine, retryMachine } from "../functions/src/machines.js";
import { enabledAgentOptions, dutyAgentOptions } from "../functions/src/profile.js";
import { availableOptions } from "../app/src/lib/runners.js";
import { scheduleDraft, schedulePayload } from "../app/src/lib/schedules.js";
import { testStore } from "./test-store.mjs";

const { store, table } = testStore();
const human = { kind: "human", uid: "owner", name: "Owner" };
const ctx = (caller = human) => ({ caller, store, cfg: {}, env: {}, publish: async () => {} });
const cheap = { agent: "codex", model: "fast", effort: "low" };
const smart = { agent: "codex", model: "smart", effort: "high" };
const options = [smart, cheap];
await store.putOne("projects", "board", { owner_uid: "owner", name: "Board", runner: { use_machine_defaults: true } });
const body = { project_id: "board", title: "Task", brief: "Do the work" };
const created = await enqueueDuty(ctx(), { ...body, agent_options: options });
const id = created.duty_id;
assert.deepEqual((await getDuty(ctx(), { duty_id: id })).duty.agent_options, options);
await updateDuty(ctx(), { duty_id: id, title: "Keep policy" });
assert.deepEqual(table("duties").get(id).agent_options, options);
await updateDuty(ctx(), { duty_id: id, agent_options: null });
assert.equal(table("duties").get(id).agent_options, null);
await updateDuty(ctx(), { duty_id: id, agent_options: [cheap, smart] });
assert.deepEqual(table("duties").get(id).agent_options, [cheap, smart]);
for (const bad of [[], {}, [smart, smart], [{ ...smart, agent: "unknown" }], [{ ...smart, effort: "unknown" }]]) {
  assert.throws(() => dutyAgentOptions(bad));
  await assert.rejects(() => enqueueDuty(ctx(), { ...body, agent_options: bad }));
  await assert.rejects(() => updateDuty(ctx(), { duty_id: id, agent_options: bad }));
}
await assert.rejects(() => updateDuty(ctx({ kind: "human", uid: "stranger" }), { duty_id: id, agent_options: options }));
const legacy = await enqueueDuty(ctx(), body);
assert.equal((await getDuty(ctx(), { duty_id: legacy.duty_id })).duty.agent_options, null);

// Toggle persistence and daemon projection work even for pre-toggle runners.
await store.putOne("machines", "machine-key", { machine_id: "m1", name: "Machine", owner_uid: "owner", cli_version: "2.29.1", agent_options: [cheap, smart] });
await store.putOne("machine_links", "board:m1", { project_id: "board", machine_id: "m1", owner_uid: "owner", agent_prefix: "machine" });
const saved = await updateMachine(ctx(), { machine_id: "m1", agent_options: [cheap, { ...smart, disabled: true }] });
assert.deepEqual(saved.machine.agent_options, [cheap, { ...smart, disabled: true }]);
assert.deepEqual(availableOptions([saved.machine]).map(({ machines, ...o }) => o), [cheap]);
assert.equal(enabledAgentOptions(null), null);
assert.deepEqual(enabledAgentOptions([{ ...smart, disabled: true }]), []);
await assert.rejects(() => updateMachine(ctx(), { machine_id: "m1", agent_options: [smart, { ...smart, disabled: true }] }));
await assert.rejects(() => updateMachine(ctx(), { machine_id: "m1", agent_options: [{ ...smart, disabled: "yes" }] }));
const machine = (version) => ({ kind: "agent", projectId: "board", machineId: "m1", ownerUid: "owner", agentPrefix: "machine", defaultAgentId: "machine/1", machineRow: { ...table("machines").get("machine-key"), cli_version: version } });
assert.deepEqual((await machineMe(ctx(machine("2.29.1")))).machine.agent_options, [cheap]);
const oldPoll = await pollMachine(ctx(machine("2.29.1")), {});
assert.deepEqual(oldPoll.agent_options, [cheap]);
assert.ok(!oldPoll.boards[0].runnable.some((r) => r.duty_id === id));
assert.ok(oldPoll.boards[0].runnable.some((r) => r.duty_id === legacy.duty_id));
await assert.rejects(() => claimDuty(ctx(machine("2.29.1")), { duty_id: id, agent_id: "machine/1" }), /2.30.0/);
await updateMachine(ctx(), { machine_id: "m1", agent_options: [cheap, smart] });
assert.deepEqual((await machineMe(ctx(machine("2.30.0")))).machine.agent_options, [cheap, smart]);
const poll = await pollMachine(ctx(machine("2.30.0")), {});
assert.deepEqual(poll.boards[0].runnable.find((r) => r.duty_id === id).agent_options, [cheap, smart]);
const claimed = await claimDuty(ctx(machine("2.30.0")), { duty_id: id, agent_id: "machine/1" });
assert.deepEqual(claimed.duty.agent_options, [cheap, smart]);
const activePoll = await pollMachine(ctx(machine("2.30.0")), {});
assert.deepEqual(activePoll.boards[0].active.find((r) => r.duty_id === id).agent_options, [cheap, smart]);
assert.equal((await pollMachine(ctx(machine("2.29.1")), {})).boards[0].active.find((r) => r.duty_id === id).mine, false);

// Board-scoped quota retry includes model overrides, not just its default policy.
await store.putOne("projects", "board", { owner_uid: "owner", name: "Board", runner: { options: [cheap] } });
await retryMachine(ctx(), { machine_id: "m1", project_id: "board", reset_limits: true });
assert.deepEqual(table("machines").get("machine-key").quota_retries.board.options, [cheap, smart]);
assert.deepEqual(table("projects").get("board").runner.options, [cheap]);

// Every recurring occurrence snapshots its policy; later schedule changes do not rewrite it.
const schedule = (await createSchedule(ctx(), { ...body, cron: "0 9 * * *", tz: "UTC", agent_options: options })).schedule;
assert.deepEqual(schedule.agent_options, options);
assert.deepEqual(schedulePayload(scheduleDraft(schedule)).agent_options, options);
await updateSchedule(ctx(), { schedule_id: schedule.schedule_id, title: "Recurring task" });
assert.deepEqual(table("schedules").get(schedule.schedule_id).agent_options, options);
for (const bad of [[], [smart, smart]]) await assert.rejects(() => updateSchedule(ctx(), { schedule_id: schedule.schedule_id, agent_options: bad }));
const now = Date.now();
await updateSchedule(ctx(), { schedule_id: schedule.schedule_id, next_due_at: now });
assert.equal((await runDueSchedules(ctx(), { now: now + 1, projectKey: "board" })).filed, 1);
const occurrence = [...table("duties").values()].find((d) => d.schedule_id === schedule.schedule_id);
assert.deepEqual(occurrence.agent_options, options);
await updateSchedule(ctx(), { schedule_id: schedule.schedule_id, agent_options: null });
assert.deepEqual(table("duties").get(occurrence.key).agent_options, options);
await updateDuty(ctx(), { duty_id: occurrence.key, status: "done" });
await updateSchedule(ctx(), { schedule_id: schedule.schedule_id, next_due_at: now + 2 });
assert.equal((await runDueSchedules(ctx(), { now: now + 3, projectKey: "board" })).filed, 1);
const next = table("duties").get(table("schedules").get(schedule.schedule_id).last_duty_id);
assert.equal(next.agent_options, null);
console.log("Duty models: persistence, inheritance, validation, authorization, toggles, daemon polling/claims, version gates, quota retry and recurring snapshots passed.");

// A full first page for other models must not starve later duties this machine can run.
await updateMachine(ctx(), { machine_id: "m1", agent_options: [cheap, { ...smart, disabled: true }] });
for (let i = 0; i < 30; i++) {
  await store.putOne("duties", `other-model-${i}`, { project_id: "board", owner_uid: "owner", title: "Other model", brief: "Requires smart", status: "queued", kind: "work", prio_rank: 0, created_at: i, agent_options: [smart] });
}
const eligiblePoll = await pollMachine(ctx(machine("2.30.0")), { limit: 1 });
assert.equal(eligiblePoll.boards[0].runnable.length, 1);
assert.ok(!eligiblePoll.boards[0].runnable[0].duty_id.startsWith("other-model-"));
await assert.rejects(() => claimDuty(ctx(machine("2.30.0")), { duty_id: "other-model-0", agent_id: "machine/2" }), /no enabled combination/);
await updateMachine(ctx(), { machine_id: "m1", agent_options: [cheap, smart] });
assert.equal((await pollMachine(ctx(machine("2.30.0")), { limit: 1 })).boards[0].runnable[0].duty_id, "other-model-0");
console.log("Queue eligibility: disabled models cannot be claimed, unavailable pages do not starve eligible duties, and re-enabling restores eligibility.");
