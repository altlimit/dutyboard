#!/usr/bin/env node
import assert from "node:assert/strict";
import { createNote, processNote, clearNoteSuggestions, suggestDuty, enqueueDuty, claimDuty, checkpointDuty, completeDuty, resolveDuty, updateDuty, cancelDuty, getDuty, pollDuties } from "../functions/src/duties.js";
import { testStore } from "./test-store.mjs";
const { store, table } = testStore();
const human = { kind: "human", uid: "owner", name: "Owner" };
const member = { kind: "human", uid: "member", name: "Member" };
const worker = { kind: "agent", projectId: "board", defaultAgentId: "reviewer" };
const events = [];
const ctx = caller => ({ caller, defaultAgentId: caller.defaultAgentId, store, cfg: {}, env: {}, publish: async (...e) => events.push(e) });
await store.putOne("projects", "board", { owner_uid: "owner", name: "Notes" });
await store.putOne("memberships", "board:member", { uid: "member", project_id: "board" });
const note = await createNote(ctx(member), { project_id: "board", title: "Inbox", brief: "Make an export button." });
assert.equal(note.status, "note");
assert.equal((await pollDuties(ctx(worker), {})).runnable_duties.length, 0);
await assert.rejects(() => claimDuty(ctx(worker), { duty_id: note.duty_id }));
await assert.rejects(() => createNote(ctx(worker), { title: "no", brief: "no" }));
await assert.rejects(() => processNote(ctx({ kind: "human", uid: "stranger" }), { note_id: note.duty_id }));
await assert.rejects(() => processNote(ctx({ kind: "agent", projectId: "other" }), { note_id: note.duty_id }));
await assert.rejects(() => resolveDuty(ctx(human), { duty_id: note.duty_id, resolution_text: "go" }));
await assert.rejects(() => updateDuty(ctx(human), { duty_id: note.duty_id, status: "queued" }));
await assert.rejects(() => checkpointDuty(ctx(worker), { duty_id: note.duty_id, set_status: "active", message: "go" }));
const review = await processNote(ctx(member), { note_id: note.duty_id });
const repeated = await processNote(ctx(human), { note_id: note.duty_id });
assert.equal(repeated.duty_id, review.duty_id);
assert.equal(table("duties").get(note.duty_id).review_duty_id, review.duty_id);
await assert.rejects(() => clearNoteSuggestions(ctx(human), { note_id: note.duty_id }));
await claimDuty(ctx(worker), { duty_id: review.duty_id });
const suggestion = await suggestDuty(ctx(worker), { title: "Export records", brief: "Add CSV export. Verify quoting.", priority: "backlog", question: "Include archived records?", external_ref: "export" });
const row = table("duties").get(suggestion.duty_id);
assert.equal(row.status, "needs_decision");
assert.equal(row.source_note_id, note.duty_id);
assert.equal(row.spawned_by, review.duty_id);
assert.equal(row.approval_required, true);
assert.equal(row.last_question, "Include archived records?");
assert.equal((await suggestDuty(ctx(worker), { title: "Retry", brief: "same", external_ref: "export" })).duty_id, row.key);
const ordinary = await enqueueDuty(ctx(worker), { title: "Another idea", brief: "A second proposed change", priority: "immediate_blocker" });
assert.equal(ordinary.status, "needs_decision");
assert.equal(table("duties").get(review.duty_id).status, "active");
assert.equal((await getDuty(ctx(worker), { duty_id: note.duty_id })).suggestions.length, 2);
for (const operation of [
  () => claimDuty(ctx(worker), { duty_id: row.key }),
  () => checkpointDuty(ctx(worker), { duty_id: row.key, set_status: "active", message: "go" }),
  () => completeDuty(ctx(worker), { duty_id: row.key, outcome_summary: "done" }),
  () => resolveDuty(ctx(worker), { duty_id: row.key, resolution_text: "Approved", approve: true }),
  () => resolveDuty(ctx(human), { duty_id: row.key, resolution_text: "Not approval" }),
  () => updateDuty(ctx(human), { duty_id: row.key, status: "queued" }),
]) await assert.rejects(operation);
assert.equal((await pollDuties(ctx(worker), {})).runnable_duties.length, 0);
await completeDuty(ctx(worker), { duty_id: review.duty_id, outcome_summary: "Proposed two duties." });
await assert.rejects(() => enqueueDuty(ctx(worker), { title: "Late idea", brief: "Do not queue this", spawned_by: review.duty_id }));
await resolveDuty(ctx(member), { duty_id: row.key, resolution_text: "Approved, exclude archived records.", approve: true });
const approved = table("duties").get(row.key);
assert.equal(approved.status, "queued");
assert.equal(approved.approved_by, member.uid);
assert.equal(approved.approval_required, false);
assert.equal(approved.priority, "backlog");
assert.equal((await pollDuties(ctx(worker), {})).runnable_duties[0].id, row.key);
await cancelDuty(ctx(human), { duty_id: ordinary.duty_id, reason: "Reject suggestion" });
assert.equal(table("duties").get(ordinary.duty_id).status, "failed");
await clearNoteSuggestions(ctx(member), { note_id: note.duty_id });
const next = await processNote(ctx(member), { note_id: note.duty_id });
assert.notEqual(next.duty_id, review.duty_id);
const linked = (await getDuty(ctx(worker), { duty_id: note.duty_id })).suggestions;
assert.equal(linked.length, 2);
assert.equal(linked.find(d => d.id === row.key).status, "queued");
assert.equal(linked.find(d => d.id === ordinary.duty_id).status, "failed");
await assert.rejects(() => clearNoteSuggestions(ctx(worker), { note_id: note.duty_id }));
console.log("Notes passed: hidden from queue, board permissions, idempotent reviews and suggestions, two-way links, enforced human approval, rejection, and retry with preserved history.");
