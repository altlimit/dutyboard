#!/usr/bin/env node
// Exercise the agent-facing protocol, not just the underlying REST handlers.
import assert from "node:assert/strict";
import { handleMcp } from "../functions/src/mcp.js";
import { BOARD_OPERATIONS, setBoardAccess, removeBoardAccess } from "../functions/src/board-access.js";
import { createNote, processNote, clearNoteSuggestions, resolveDuty } from "../functions/src/duties.js";
import { testStore } from "./test-store.mjs";

const { store } = testStore();
const owner = { kind: "human", uid: "owner", name: "Owner" };
const agent = { kind: "agent", projectId: "a", tokenKey: "agent-a", scope: "agent", defaultAgentId: "reviewer" };
const ctx = caller => ({ caller: { ...caller }, defaultAgentId: caller.defaultAgentId, store, cfg: { blobInstance: "files" }, env: { blob: {} }, publish: async () => {} });
const rpc = async (method, params = {}, caller = agent) => (await handleMcp(ctx(caller), new Request("http://local/mcp", {
  method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
}), 8192)).json();
const call = async (name, args = {}) => {
  const reply = await rpc("tools/call", { name, arguments: args });
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
  return reply.result.structuredContent;
};
const refused = async (name, args = {}, caller = agent) => {
  const reply = await rpc("tools/call", { name, arguments: args }, caller);
  assert.ok(reply.error || reply.result?.isError, `unexpectedly allowed ${name}`);
};
const options = [{ agent: "codex", model: "from-cli", effort: "high" }, { agent: "claude-code", model: "backup-cli", effort: "low" }];
for (const id of ["a", "b"]) {
  await store.putOne("projects", id, { name: id, owner_uid: owner.uid, created_at: 1, runner: { options } });
  await store.putOne("rules", id, { project_id: id, body: `Rules on ${id}`, version: 1 });
}
const initialized = (await rpc("initialize")).result;
assert.equal(initialized.serverInfo.name, "dutyboard");
for (const term of ["duty_suggest", "suggestions_cursor", "board_links", "board_call", "runner.options", "Retry now", "person"]) assert.ok(initialized.instructions.includes(term), `missing instructions: ${term}`);
const tools = (await rpc("tools/list")).result.tools;
const names = tools.map(t => t.name);
for (const op of [...Object.keys(BOARD_OPERATIONS), "board_links", "board_call"]) assert.ok(names.includes(op), `missing schema: ${op}`);
assert.deepEqual(tools.find(t => t.name === "board_call").inputSchema.properties.operation.enum, Object.keys(BOARD_OPERATIONS));
for (const name of ["note_create", "note_process", "note_clear", "duty_resolve", "board_access_set", "board_access_remove", "machines_retry", "machines_update"]) {
  assert.ok(!names.includes(name));
  await refused(name);
}
assert.deepEqual((await call("board_profile")).runner.options, options);

// A real note review using only advertised MCP operations on the agent side.
const note = await createNote(ctx(owner), { project_id: "a", title: "Export idea", brief: "Export totals to CSV." });
assert.equal((await call("duty_list", { status: "note" })).duties[0].id, note.duty_id);
assert.equal((await call("note_list")).notes[0].id, note.duty_id);
assert.ok(tools.find(t => t.name === "duty_suggest").inputSchema.properties.source_note_ids);
await refused("duty_claim", { duty_id: note.duty_id });
await refused("duty_suggest", { title: "Too early", brief: "No held review" });
const review = await processNote(ctx(owner), { note_id: note.duty_id });
await call("duty_claim", { duty_id: review.duty_id });
assert.equal((await call("duty_get", { duty_id: review.duty_id })).duty.source_note_id, note.duty_id);
assert.deepEqual((await call("duty_attachments", { duty_id: note.duty_id })).attachments, []);
await call("duty_thread", { duty_id: note.duty_id });
const args = { title: "Export totals", brief: "CSV export; check headers and totals", question: "Include archived records?", external_ref: "export" };
const suggestion = await call("duty_suggest", args);
assert.equal((await call("duty_suggest", args)).duty_id, suggestion.duty_id);
const fromNote = await call("duty_get", { duty_id: note.duty_id });
assert.equal(fromNote.suggestions[0].id, suggestion.duty_id);
assert.equal(fromNote.suggestions[0].approval_required, true);
assert.equal(fromNote.suggestions_cursor, null);
assert.equal((await call("duty_list", { status: "needs_decision" })).duties[0].id, suggestion.duty_id);
await refused("duty_claim", { duty_id: suggestion.duty_id });
await refused("duty_complete", { duty_id: suggestion.duty_id, outcome_summary: "Skip approval" });

// Even a FULL link cannot turn a source review into unapproved remote work.
await setBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a", level: "full" });
assert.equal((await call("board_links")).boards[0].level, "full");
assert.equal((await call("board_call", { project_id: "b", operation: "board_rules" })).body, "Rules on b");
assert.deepEqual((await call("board_call", { project_id: "b", operation: "note_list" })).notes, []);
await refused("board_call", { project_id: "b", operation: "duty_enqueue", arguments: args });
await call("duty_complete", { duty_id: review.duty_id, outcome_summary: `Proposed ${suggestion.duty_id}` });
await resolveDuty(ctx(owner), { duty_id: suggestion.duty_id, approve: true, resolution_text: "Approved; exclude archived." });
await clearNoteSuggestions(ctx(owner), { note_id: note.duty_id });
const newReview = await processNote(ctx(owner), { note_id: note.duty_id });
assert.notEqual(newReview.duty_id, review.duty_id);
assert.equal((await call("duty_get", { duty_id: note.duty_id })).suggestions[0].status, "queued");
assert.equal((await call("duty_get", { duty_id: suggestion.duty_id })).duty.source_note_id, note.duty_id);

await removeBoardAccess(ctx(owner), { project_id: "b", source_project_id: "a" });
assert.deepEqual((await call("board_links")).boards, []);
await refused("board_call", { project_id: "b", operation: "board_rules" });
const submit = { ...agent, scope: "submit" };
const submitNames = (await rpc("tools/list", {}, submit)).result.tools.map(t => t.name);
for (const name of ["note_list", "duty_list", "duty_suggest", "board_links", "board_call", "board_profile", "duty_attachment_delete"]) {
  assert.ok(!submitNames.includes(name));
  await refused(name, {}, submit);
}
assert.ok(!(await rpc("initialize", {}, submit)).result.instructions.includes("duty_suggest"));
console.log("MCP features passed: discovery, configuration reads, note review and tracking, approval boundaries, linked-board access and revocation, and submit-token isolation.");
