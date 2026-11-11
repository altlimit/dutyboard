#!/usr/bin/env node
import assert from "node:assert/strict";
import { agentOptions, mergeRunner } from "../functions/src/profile.js";
import { reportReadiness, updateMachine, retryMachine } from "../functions/src/machines.js";
import { availableOptions, profileDraft, profilePayload } from "../app/src/lib/runners.js";

const first = { agent: "codex", model: "from-cli", effort: "high" };
const second = { agent: "claude-code", model: "other-cli", effort: "low" };
assert.deepEqual(mergeRunner(null, { options: [second, first] }).options, [second, first]);
assert.equal(mergeRunner({ agent: "codex", model: "legacy" }, {}).options, undefined);
assert.deepEqual(mergeRunner(null, { options: [] }).options, []);
for (const bad of [null, {}, [first, first], [{ agent: "invented" }], [{ ...first, effort: "invented" }], [{ agent: "cursor", model: "auto", effort: "high" }], Array.from({ length: 31 }, (_, i) => ({ ...first, model: `m${i}` }))]) {
  assert.throws(() => agentOptions(bad));
}
assert.equal(mergeRunner(null, {}).use_machine_defaults, true);
assert.equal(mergeRunner(null, { agent: "codex" }).use_machine_defaults, false);
assert.equal(mergeRunner(null, { options: [first] }).use_machine_defaults, false);
const inherited = mergeRunner({ options: [first] }, { use_machine_defaults: true });
assert.equal(inherited.use_machine_defaults, true);
assert.deepEqual(inherited.options, [first]);
assert.equal(mergeRunner(inherited, { parallel: 2 }).use_machine_defaults, true);
assert.equal(mergeRunner(inherited, { options: [second] }).use_machine_defaults, false);
assert.equal(mergeRunner(inherited, { agent: "codex" }).use_machine_defaults, false);
assert.equal(mergeRunner(inherited, { use_machine_defaults: false }).use_machine_defaults, false);
for (const bad of [null, "true", 1, {}]) assert.throws(() => mergeRunner(null, { use_machine_defaults: bad }));
assert.equal(profilePayload(profileDraft(null, null)).runner.use_machine_defaults, true);
assert.equal(profilePayload(profileDraft({}, { agent: "codex" })).runner.use_machine_defaults, false);
assert.equal(profilePayload(profileDraft({}, inherited)).runner.use_machine_defaults, true);
const draft = profileDraft({}, { options: [second, first], parallel: 2 });
assert.deepEqual(profilePayload(draft).runner.options, [second, first]);
assert.equal(profilePayload(profileDraft({}, { agent: "codex", model: "old" })).runner.options, undefined);
assert.deepEqual(availableOptions([{ name: "A", agent_options: [first] }, { name: "B", agent_options: [first, second] }]).map((o) => o.machines), [["A", "B"], ["B"]]);

let machine = { key: "machine-key", machine_id: "m1", owner_uid: "owner", cli_version: "2.27.0", name: "Build" };
let report;
const events = [];
const ctx = {
  caller: { kind: "human", uid: "owner" }, cfg: {}, env: {},
  publish: async (...args) => events.push(args),
  store: {
    query: async (collection) => ({ rows: collection === "machines" ? [machine] : [] }),
    get: async (collection) => collection === "machine_readiness" ? report : null,
    putOne: async (collection, key, value) => {
      if (collection === "machines") machine = { ...value, key };
      if (collection === "machine_readiness") report = value;
    },
  },
};
await reportReadiness({ ...ctx, caller: { machineId: "m1", ownerUid: "owner" } }, {
  items: [{ key: "codex", label: "Codex", state: "ok", models: [{ id: "from-cli", label: "From CLI", efforts: ["high", "minimal", "invented"] }] }],
});
assert.deepEqual(report.items[0].models[0].efforts, ["high", "minimal"]);
await assert.rejects(() => updateMachine(ctx, { machine_id: "m1", agent_options: [{ ...first, model: "not-from-cli" }] }));
await assert.rejects(() => updateMachine(ctx, { machine_id: "m1", agent_options: [{ ...first, effort: "low" }] }));
await updateMachine(ctx, { machine_id: "m1", agent_options: [first] });
assert.deepEqual(machine.agent_options, [first]);
await assert.rejects(() => updateMachine({ ...ctx, caller: { kind: "human", uid: "someone-else" } }, { machine_id: "m1", agent_options: [] }));
await assert.rejects(() => updateMachine({ ...ctx, caller: { kind: "agent" } }, { machine_id: "m1", agent_options: [] }));
report = { items: [] }; // transient CLI failure must not erase a saved combination
await updateMachine(ctx, { machine_id: "m1", agent_options: [first] });
await updateMachine(ctx, { machine_id: "m1", agent_options: [] });
assert.deepEqual(machine.agent_options, []);
machine.cli_version = "2.26.0";
await assert.rejects(() => updateMachine(ctx, { machine_id: "m1", agent_options: [] }));
console.log("Agent options: priority, legacy settings, CLI validation, owner authorization, saved availability, empty lists, and version gating passed.");

// Retry authorization and persistence: only an explicit quota retry writes a request.
machine.cli_version = "2.27.0";
const project = { key: "board-a", owner_uid: "board-owner", runner: { options: [first] } };
const read = ctx.store.get;
ctx.store.get = async (collection, key) => collection === "projects" && key === project.key ? project
  : collection === "machine_links" && key === "board-a:m1" ? { project_id: "board-a", machine_id: "m1" }
  : read(collection, key);
await retryMachine(ctx, { machine_id: "m1" });
assert.equal(machine.quota_retries, undefined);
await retryMachine(ctx, { machine_id: "m1", project_id: "board-a", reset_limits: true });
assert.deepEqual(machine.quota_retries["board-a"].options, [first]);
const previousRequest = machine.quota_retries["board-a"].id;
await retryMachine({ ...ctx, caller: { kind: "human", uid: "board-owner" } }, { machine_id: "m1", project_id: "board-a", reset_limits: true });
assert.notEqual(machine.quota_retries["board-a"].id, previousRequest);
await assert.rejects(() => retryMachine({ ...ctx, caller: { kind: "human", uid: "board-owner" } }, { machine_id: "m1", reset_limits: true }));
await assert.rejects(() => retryMachine({ ...ctx, caller: { kind: "human", uid: "stranger" } }, { machine_id: "m1", project_id: "board-a", reset_limits: true }));
await assert.rejects(() => retryMachine(ctx, { machine_id: "m1", project_id: "not-linked", reset_limits: true }));
await retryMachine(ctx, { machine_id: "m1", reset_limits: true });
assert.equal(machine.quota_retries["*"].options, null);
machine.agent_options = [second];
project.runner.use_machine_defaults = true;
await retryMachine({ ...ctx, caller: { kind: "human", uid: "board-owner" } }, { machine_id: "m1", project_id: "board-a", reset_limits: true });
assert.deepEqual(machine.quota_retries["board-a"].options, [second]);
machine.agent_options = null;
await retryMachine(ctx, { machine_id: "m1", project_id: "board-a", reset_limits: true });
assert.deepEqual(machine.quota_retries["board-a"].options, [], "unconfigured inheritance must not reset all model quotas");
machine.cli_version = "2.26.0";
await assert.rejects(() => retryMachine(ctx, { machine_id: "m1", reset_limits: true }));
console.log("Quota retry: explicit requests, durable state, board/model scope, owner permissions, and older-runner rejection passed.");
