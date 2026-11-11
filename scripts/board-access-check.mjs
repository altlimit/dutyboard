#!/usr/bin/env node
import assert from "node:assert/strict";
import { testStore } from "./test-store.mjs";
import { setBoardAccess, removeBoardAccess, listBoardAccess, linkedBoards, sweepBoardAccess, BOARD_OPERATIONS } from "../functions/src/board-access.js";
import { callLinkedBoard, handleMcp } from "../functions/src/mcp.js";
import { enqueueDuty, getDuty, resolveDuty, claimDuty } from "../functions/src/duties.js";
const { store, table } = testStore();
const owner = { kind: "human", uid: "owner", name: "Owner" };
const otherOwner = { kind: "human", uid: "other", name: "Other" };
const worker = { kind: "agent", projectId: "a", tokenKey: "token-a", defaultAgentId: "alpha", scope: "agent" };
const ctx = caller => ({ caller: { ...caller, _memberships: undefined }, defaultAgentId: caller.defaultAgentId, store, env: {}, cfg: {}, publish: async () => {} });
for (const [id, uid] of [["a", "other"], ["b", "owner"], ["c", "owner"]]) {
  await store.putOne("projects", id, { owner_uid: uid, name: id.toUpperCase(), created_at: 1 });
  await store.putOne("rules", id, { project_id: id, owner_uid: uid, body: `Rules for ${id}`, version: 1 });
}
await store.putOne("memberships", "a:owner", { uid: "owner", project_id: "a" });
await store.putOne("memberships", "b:other", { uid: "other", project_id: "b" });
const bDuty = await enqueueDuty(ctx(owner), { project_id: "b", title: "B duty", brief: "Only B" });
const cDuty = await enqueueDuty(ctx(owner), { project_id: "c", title: "C duty", brief: "Only C" });
const request = (operation, args = {}, extras = {}) => ({ project_id: "b", operation, arguments: args, ...extras });
const call = (op, args, extras) => callLinkedBoard(ctx(worker), request(op, args, extras));
const denied = async fn => assert.rejects(fn, e => [400, 403, 404, 409].includes(e.status), "expected authorization or state rejection");
await denied(() => call("duty_get", { duty_id: bDuty.duty_id }));
await denied(() => setBoardAccess(ctx(otherOwner), { project_id: "b", source_project_id: "a", level: "full" }));
await denied(() => setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "b", level: "read" }));
await denied(() => setBoardAccess(ctx(worker), { project_id: "b", source_project_id: "a", level: "read" }));
await setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a", level: "read" });
assert.deepEqual((await linkedBoards(ctx(worker))).boards.map(b => [b.project_id, b.level]), [["b", "read"]]);
assert.equal((await call("duty_list")).duties[0].id, bDuty.duty_id);
assert.equal((await call("duty_get", { duty_id: bDuty.duty_id })).duty.title, "B duty");
assert.equal((await call("board_rules")).body, "Rules for b");
assert.equal(table("agents").size, 0, "READ does not touch agent state");
await store.putOne("attachments", "abandoned", { project_id: "b", duty_id: bDuty.duty_id, blob_id: "gone", created_at: 1 });
await callLinkedBoard({ ...ctx(worker), cfg: { blobInstance: "files" }, env: { blob: { get: async () => null } } }, request("duty_attachments", { duty_id: bDuty.duty_id }));
assert.ok(table("attachments").has("abandoned"), "READ does not perform attachment cleanup");
for (const op of Object.keys(BOARD_OPERATIONS).filter(op => BOARD_OPERATIONS[op] !== "read")) await denied(() => call(op, { duty_id: bDuty.duty_id, title: "no", brief: "no" }));
for (const operation of ["board_call", "board_links", "duty_resolve", "projects_delete", "board_rules_set", "tokens_mint", "constructor"]) await denied(() => call(operation));
await denied(() => getDuty(ctx(worker), { duty_id: bDuty.duty_id }));
await denied(() => call("duty_get", { duty_id: cDuty.duty_id }));
await denied(() => call("board_rules", { project_id: "c" }));
const bAgent = { ...worker, projectId: "b", tokenKey: "b-token" };
await denied(() => callLinkedBoard(ctx(bAgent), { project_id: "a", operation: "board_rules" }));
await setBoardAccess(ctx(owner), { project_id: "c", source_project_id: "b", level: "full" });
await denied(() => call("board_rules", {}, { project_id: "c" }));
await denied(() => callLinkedBoard(ctx({ ...worker, scope: "submit" }), request("duty_list")));
await denied(() => callLinkedBoard(ctx(owner), request("duty_list")));

await setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a", level: "write" });
const filed = await call("duty_enqueue", { title: "A asks B", brief: "Do this", external_ref: "same" });
assert.equal(table("duties").get(filed.duty_id).origin_board_id, "a");
assert.equal((await call("duty_enqueue", { title: "Retry", brief: "same", external_ref: "same" })).duty_id, filed.duty_id);
assert.equal((await call("duty_enqueue", { title: "Retry on another lane", brief: "same", external_ref: "same" }, { agent_id: "another-lane" })).duty_id, filed.duty_id);
await denied(() => call("duty_checkpoint", { duty_id: bDuty.duty_id, message: "no" }));
await denied(() => call("duty_attach", { duty_id: bDuty.duty_id, name: "no.txt", size: 1 }));
await denied(() => call("duty_enqueue", { title: "no", brief: "no", kind: "setup" }));
await denied(() => call("duty_enqueue", { title: "no", brief: "no", parent_id: bDuty.duty_id }));

await setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a", level: "full" });
const claimed = await call("duty_claim", { duty_id: filed.duty_id, agent_id: "impersonate-local-agent" });
assert.ok(claimed.duty.assigned_agent_id.startsWith("link/a/"));
assert.notEqual(claimed.duty.assigned_agent_id, "impersonate-local-agent");
await call("duty_checkpoint", { duty_id: filed.duty_id, message: "Working across the link", kind: "note" });
await call("duty_complete", { duty_id: filed.duty_id, outcome_summary: "Done from A" });
assert.equal((await call("duty_get", { duty_id: filed.duty_id })).duty.status, "done");
await denied(() => call("duty_enqueue", { title: "no", brief: "no", parent_id: cDuty.duty_id }));
// FULL cannot bypass a human approval gate or promote an agent into a human.
await store.putOne("duties", "proposal", { project_id: "b", owner_uid: "owner", title: "Proposed", brief: "Wait", status: "needs_decision", approval_required: true });
await denied(() => call("duty_claim", { duty_id: "proposal" }));
await denied(() => call("duty_checkpoint", { duty_id: "proposal", set_status: "active", message: "no" }));
await denied(() => call("duty_complete", { duty_id: "proposal", outcome_summary: "no" }));
await denied(() => call("duty_resolve", { duty_id: "proposal", resolution_text: "no", approve: true }));
// Revocation and loss of the granting person's source access take effect immediately.
await store.delete("memberships", ["a:owner"]);
assert.equal((await linkedBoards(ctx(worker))).boards.length, 0);
assert.equal((await listBoardAccess(ctx(owner), { project_id: "b" })).incoming[0].active, false);
await denied(() => call("board_rules"));
await denied(() => setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a", level: "full" }));
await removeBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a" });
await store.putOne("memberships", "a:owner", { uid: "owner", project_id: "a" });
await denied(() => call("board_rules"));
await setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a", level: "full" });
// A source note review cannot use a link to queue unapproved work elsewhere.
await store.putOne("duties", "source-review", { project_id: "a", owner_uid: "other", kind: "note_review", status: "active", assigned_agent_id: "alpha" });
await store.putOne("agents", "a:alpha", { active_duty_id: "source-review" });
assert.equal((await call("board_rules")).body, "Rules for b");
await denied(() => call("duty_enqueue", { title: "no", brief: "no" }));
await store.delete("agents", ["a:alpha"]);
// Source duty provenance and credential identity are checked for machine sessions too.
await store.putOne("duties", "source-work", { project_id: "a", owner_uid: "other", kind: "work", status: "active", assigned_agent_id: "machine/1" });
const machine = { ...worker, machineId: "m1", agentPrefix: "machine", tokenKey: undefined, defaultAgentId: "machine/1" };
const traced = await callLinkedBoard(ctx(machine), request("duty_enqueue", { title: "Machine asks B", brief: "Do it" }, { source_duty_id: "source-work" }));
assert.equal(table("duties").get(traced.duty_id).origin_duty_id, "source-work");
await denied(() => callLinkedBoard(ctx(machine), request("duty_enqueue", { title: "no", brief: "no" }, { agent_id: "other/1" })));
await denied(() => callLinkedBoard(ctx(machine), request("duty_enqueue", { title: "no", brief: "no" }, { source_duty_id: "source-review" })));
// The MCP gateway shares the same authorization and advertises the dedicated tools.
const rpc = async (method, params) => (await handleMcp(ctx(worker), new Request("http://local/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), 4096)).json();
assert.ok((await rpc("tools/list", {})).result.tools.some(t => t.name === "board_call"));
assert.equal((await rpc("tools/call", { name: "board_call", arguments: request("board_rules") })).result.structuredContent.body, "Rules for b");
await removeBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a" });
assert.equal((await rpc("tools/call", { name: "board_call", arguments: request("board_rules") })).result.isError, true);
await setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a", level: "read" });
await store.putOne("projects", "a", { owner_uid: "other", name: "Recreated A", created_at: 2 });
await denied(() => call("board_rules"));
assert.equal(await sweepBoardAccess(ctx(owner), "b"), 2);
assert.equal(table("board_access").size, 0);
console.log("Board access passed: directional READ/WRITE/FULL, live membership checks, revocation, no chaining or human escalation, scoped references, isolated identities, source provenance, note approvals, MCP and deletion cleanup.");
