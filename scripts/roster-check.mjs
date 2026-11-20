#!/usr/bin/env node
// A board's team, end to end against the real handlers and an in-memory datastore: who reads a new
// duty first, how it is handed on, that nothing a builder made is finished without a reviewer, what
// a machine's levels pick, what the team's memory accepts, and what the console may send a machine.
import assert from "node:assert/strict";
import { enqueueDuty, claimDuty, getDuty, completeDuty, failDuty, handoffDuty, reopenDuty, resolveDuty, pollDuties, checkpointDuty, reportUsage, addAgentNote, listNotes, MAX_NOTES_PER_DUTY, UNFINISHED } from "../functions/src/duties.js";
import { getRoster, setRoster, acceptRoster, submitRoster, draftRoster, retroRoster, rolesFrom, levelOf, levelFor, optionsForLevel, LEVELS, MAX_CHARTER_CHARS, ROSTER_MIN_RELEASE, RETRO_EVERY, SENT_BACKS_KEPT } from "../functions/src/roster.js";
import { submitRules } from "../functions/src/profile.js";
import { createSchedule, updateSchedule, runDueSchedules } from "../functions/src/schedules.js";
import { PRESETS, presetFor } from "../functions/src/charters.js";
import { getMemory, writeMemory, memoryHistory, MAX_MEMORY_CHARS, MEMORY_VERSIONS_KEPT } from "../functions/src/memory.js";
import { createProject, deleteProject, openBoard, listRosters, liveBoards } from "../functions/src/projects.js";
import { pollMachine, updateMachine, listMachines, reportReadiness, requestSetup, machineMe, reportRequest } from "../functions/src/machines.js";
import { handleMcp } from "../functions/src/mcp.js";
import { ROUTE_PATHS } from "../functions/src/index.js";
import { testStore } from "./test-store.mjs";

const { store, table } = testStore();
const events = [];
const owner = { kind: "human", uid: "owner", name: "Owner" };
const member = { kind: "human", uid: "member", name: "Member" };
const ctx = (caller = owner) => ({ caller, store, cfg: {}, env: {}, publish: async (project, duty, payload) => events.push(payload), defaultAgentId: caller.defaultAgentId || "" });
const token = (agent = "alpha") => ({ kind: "agent", projectId: "team", tokenKey: "tok", tokenName: "token", defaultAgentId: agent });
/** A refusal, and that it says why: the message is what an agent or a person has to act on. */
async function rejects(fn, re) {
  const at = new Error().stack.split("\n")[2].trim();
  let result;
  try {
    result = await fn();
  } catch (err) {
    if (!re.test(err.message)) assert.fail(`expected ${re}, got: ${err.message} (${at})`);
    return;
  }
  assert.fail(`expected a refusal matching ${re}, got ${JSON.stringify(result)} (${at})`);
}

// --- the shipped teams are themselves valid, and say what they promise ------------------------
for (const [id, preset] of Object.entries(PRESETS)) {
  const roles = rolesFrom(preset.roles);
  assert.equal(roles.filter((r) => r.intake).length, 1, `${id}: one role reads new duties first`);
  assert.equal(roles.find((r) => r.intake).level, "light", `${id}: routing runs on the cheapest level`);
  assert.ok(roles.some((r) => r.reviews) && roles.some((r) => r.reviewed), `${id}: a builder and a reviewer`);
  for (const r of roles) assert.ok(r.charter.length > 400 && r.charter.length <= MAX_CHARTER_CHARS, `${id}/${r.id}: a real charter that fits`);
}
const software = Object.fromEntries(PRESETS.software.roles.map((r) => [r.id, r]));
for (const must of [/security/i, /performance/i, /duplicate/i, /unit tests/i, /end-to-end/i, /idiomatic/i, /minified/i]) {
  assert.match(software.engineer.charter, must);
  assert.match(software["senior-engineer"].charter, must);
}
for (const must of [/security/i, /performance/i, /duplication/i, /end-to-end/i, /minified/i, /duty_integrate/, /duty_handoff/]) assert.match(software.qa.charter, must);
assert.equal(presetFor({ workspace: "service" }), "operations");
assert.equal(presetFor({ workspace: "files" }), "tasks");
assert.equal(presetFor({ type: "webapp" }), "software");

// --- validation --------------------------------------------------------------------------------
const role = (over) => ({ id: "a", name: "A", summary: "Does a.", level: "standard", charter: "Work carefully.", ...over });
assert.throws(() => rolesFrom([role({ intake: true })]), /at least two/);
assert.throws(() => rolesFrom([role(), role({ id: "b" })]), /exactly one role must have 'intake/);
assert.throws(() => rolesFrom([role({ intake: true }), role({ id: "b", intake: true })]), /exactly one/);
assert.throws(() => rolesFrom([role({ intake: true }), role({ id: "b", reviewed: true })]), /no role has 'reviews/);
assert.throws(() => rolesFrom([role({ intake: true }), role({ id: "b", reviewed: true, reviews: true })]), /cannot both/);
assert.throws(() => rolesFrom([role({ intake: true, reviewed: true }), role({ id: "b", reviews: true })]), /cannot also need review/);
assert.throws(() => rolesFrom([role({ intake: true }), role({ id: "a" })]), /share an id/);
assert.throws(() => rolesFrom([role({ intake: true }), role({ id: "B!" })]), /lowercase/);
assert.throws(() => rolesFrom([role({ intake: true }), role({ id: "b", level: "genius" })]), /level/);
assert.throws(() => rolesFrom([role({ intake: true }), role({ id: "b", charter: "x".repeat(MAX_CHARTER_CHARS + 1) })]), /charter/);

// --- levels ------------------------------------------------------------------------------------
assert.equal(levelOf({ agent: "claude-code", model: "claude-opus-5-5", effort: "high" }), "standard");
assert.equal(levelOf({ agent: "claude-code", model: "claude-opus-5-5", effort: "xhigh" }), "senior");
assert.equal(levelOf({ agent: "claude-code", model: "claude-fable-5-2", effort: "high" }), "principal");
assert.equal(levelOf({ agent: "claude-code", model: "claude-haiku-5-5", effort: "" }), "light");
assert.equal(levelOf({ agent: "codex", model: "gpt-x", effort: "low" }), "light");
assert.equal(levelOf({ agent: "codex", model: "", effort: "" }), "standard");
assert.equal(levelOf({ agent: "cursor", model: "big-model-xhigh", effort: "" }), "senior");
assert.equal(levelOf({ agent: "codex", model: "gpt-x", effort: "low", level: "principal" }), "principal", "the owner's choice wins");
const haiku = { agent: "claude-code", model: "claude-haiku-5-5", effort: "" };
const opus = { agent: "claude-code", model: "claude-opus-5-5", effort: "high" };
const opusX = { agent: "claude-code", model: "claude-opus-5-5", effort: "xhigh" };
const fable = { agent: "claude-code", model: "claude-fable-5-2", effort: "high" };
const all = [opus, haiku, fable, opusX];
assert.deepEqual(optionsForLevel(all, "light"), [haiku, opus, opusX, fable]);
assert.deepEqual(optionsForLevel(all, "standard"), [opus, opusX, fable, haiku]);
assert.deepEqual(optionsForLevel(all, "senior"), [opusX, fable, opus, haiku]);
assert.deepEqual(optionsForLevel(all, "principal"), [fable, opusX, opus, haiku]);
assert.deepEqual(optionsForLevel([haiku], "principal"), [haiku], "a machine with nothing at a level still works the duty");
assert.deepEqual(optionsForLevel([{ ...fable, disabled: true }, opus], "principal"), [opus]);
assert.equal(optionsForLevel(null, "senior"), null, "a machine that never chose its combinations runs the board's own setting");
assert.deepEqual(LEVELS, ["light", "standard", "senior", "principal"]);

// --- a board without a team is exactly as before ------------------------------------------------
await createProject(ctx(), { name: "Plain", project_id: "plain", profile: { type: "webapp" } });
assert.equal(table("projects").get("plain").roster, undefined, "a caller that asks for no team gets none");
const plainCtx = () => ctx({ ...token("solo"), projectId: "plain" });
const plain = await enqueueDuty(ctx(), { project_id: "plain", title: "Solo", brief: "Do it" });
assert.equal(table("duties").get(plain.duty_id).role, null);
const rulesDutyId = [...table("duties").values()].find((d) => d.project_id === "plain" && d.kind === "rules").key;
await store.delete("duties", [rulesDutyId]);
const plainClaim = await claimDuty(plainCtx(), { duty_id: plain.duty_id, agent_id: "solo" });
assert.equal(plainClaim.roster, undefined);
assert.equal(plainClaim.memory.body, "");
await rejects(() => handoffDuty(plainCtx(), { duty_id: plain.duty_id, to_role: "qa", note: "x" }), /no team/);
await rejects(() => enqueueDuty(plainCtx(), { title: "Piece", brief: "b", role: "engineer" }), /no team/);
assert.equal((await completeDuty(plainCtx(), { duty_id: plain.duty_id, outcome_summary: "done" })).status, "done");
assert.equal(table("role_events").size, 0, "no team, no team record");
assert.equal((await getRoster(plainCtx(), {})).in_force, false);

// --- a new board that asks for a team starts with the one that fits ------------------------------
const made = await createProject(ctx(), { name: "Team", project_id: "team", profile: { type: "webapp", repo_url: "https://example.com/r.git" }, roster: "auto" });
assert.equal(made.roster, "software");
assert.deepEqual(table("projects").get("team").roster, { version: 1, intake: "duty-officer" });
assert.equal((await openBoard(ctx(), { project_id: "team" })).project.roster.intake, "duty-officer");
await store.delete("duties", [...table("duties").values()].filter((d) => d.project_id === "team" && d.kind === "rules").map((d) => d.key));
await rejects(() => createProject(ctx(), { name: "X", project_id: "x", profile: { type: "webapp" }, roster: "astronauts" }), /roster/);
await store.putOne("memberships", "team:member", { project_id: "team", uid: "member" });

const seen = await getRoster(ctx(), { project_id: "team" });
assert.equal(seen.in_force, true);
assert.equal(seen.roles.length, 5);
assert.ok(seen.roles[0].charter, "people read the charters");
assert.ok(seen.presets.some((p) => p.id === "content"));
const asAgent = await getRoster(ctx(token()), {});
assert.equal(asAgent.roles[0].charter, undefined, "an agent sees cards");
assert.match((await getRoster(ctx(token()), { role: "qa" })).role.charter, /Nothing lands/);
await rejects(() => getRoster(ctx(token()), { role: "nobody" }), /no role 'nobody'/);
await rejects(() => setRoster(ctx(member), { project_id: "team", off: true }), /owner/);
await rejects(() => setRoster(ctx(token()), { project_id: "team", off: true }), /signed-in people/);

// --- filing: nobody chooses the role -----------------------------------------------------------
const filed = await enqueueDuty(ctx(), { project_id: "team", title: "Add export", brief: "CSV export of orders" });
assert.equal(table("duties").get(filed.duty_id).role, "duty-officer");
await rejects(() => enqueueDuty(ctx(), { project_id: "team", title: "T", brief: "b", role: "engineer" }), /reads new duties first decides/);
await rejects(() => enqueueDuty(ctx(token()), { title: "T", brief: "b", role: "engineer" }), /splitting out of the duty you hold/);

// --- the officer takes it, sees who it is and who it can hand to ---------------------------------
const officer = await claimDuty(ctx(token("a1")), { duty_id: filed.duty_id, agent_id: "a1" });
assert.equal(officer.roster.role.id, "duty-officer");
assert.match(officer.roster.role.charter, /first to read every new duty/);
assert.deepEqual(officer.roster.team.map((r) => r.id), ["architect", "engineer", "senior-engineer", "qa"]);
assert.equal(officer.roster.team[0].charter, undefined);
assert.equal(officer.roster.handoff, null);
assert.equal(officer.duty.role, "duty-officer");
assert.equal(officer.memory.max_chars, MAX_MEMORY_CHARS);
assert.equal((await getDuty(ctx(token("a1")), { duty_id: filed.duty_id })).roster.role.id, "duty-officer", "a restarted runner is told its role again");
assert.equal((await getDuty(ctx(), { duty_id: filed.duty_id })).roster, undefined, "the console reads the row");
assert.equal((await pollDuties(ctx(token("a1")), {})).active_duty.role, "duty-officer");

await rejects(() => handoffDuty(ctx(token("a1")), { duty_id: filed.duty_id, to_role: "duty-officer", note: "x" }), /already/);
await rejects(() => handoffDuty(ctx(token("a1")), { duty_id: filed.duty_id, to_role: "cfo", note: "x" }), /no role 'cfo'.*'engineer'/);
await rejects(() => handoffDuty(ctx(token("a1")), { duty_id: filed.duty_id, to_role: "engineer" }), /note/);
await rejects(() => handoffDuty(ctx(token("zz")), { duty_id: filed.duty_id, to_role: "engineer", note: "x" }), /not one you are holding/);
await rejects(() => handoffDuty(ctx(), { duty_id: filed.duty_id, to_role: "engineer", note: "x" }), /agent project tokens/);

events.length = 0;
const routed = await handoffDuty(ctx(token("a1")), { duty_id: filed.duty_id, to_role: "engineer", note: "Goal: CSV export. Done when: download button on /orders." });
assert.equal(routed.status, "queued");
assert.match(routed.message, /Handed to Engineer.*stop/);
let row = table("duties").get(filed.duty_id);
assert.equal(row.role, "engineer");
assert.equal(row.status, "queued");
assert.equal(row.holder, null);
assert.equal(row.handoffs, 1);
assert.equal(row.bounces, 0);
assert.equal(row.priority, "next", "what a person set stays what they see");
assert.equal(row.prio_rank, 0.5, "in flight goes ahead of fresh work at its priority, behind blockers");
assert.equal(table("agents").get("team:a1").active_duty_id, null, "handing on frees the agent");
assert.deepEqual(events.find((e) => e.handoff).handoff, { from: "duty-officer", to: "engineer", sent_back: false });
const trail = [...table("threads").values()].find((t) => t.metadata && t.metadata.handoff);
assert.equal(trail.metadata.handoff.to_name, "Engineer");
const queued = (await pollDuties(ctx(token("b1")), {})).runnable_duties[0];
assert.equal(queued.id, filed.duty_id, "ahead of anything filed later");
assert.deepEqual(queued.handoff, { from: "duty-officer", to: "engineer", sent_back: false }, "the queue says it was handed on, without the note");

// --- the builder cannot finish its own work ------------------------------------------------------
const builder = await claimDuty(ctx(token("b1")), { duty_id: filed.duty_id, agent_id: "b1" });
assert.equal(builder.roster.role.id, "engineer");
assert.equal(builder.roster.role.reviewed, true);
assert.match(builder.roster.handoff.note, /CSV export/);
assert.equal(builder.duty.handoff.from, "duty-officer");
await rejects(() => completeDuty(ctx(token("b1")), { duty_id: filed.duty_id, outcome_summary: "shipped" }), /do not finish this duty yourself.*'qa' \(QA\)/);
assert.equal(table("duties").get(filed.duty_id).status, "active");
// A person writing on the duty while it is being built is seen before it is handed on.
await new Promise((done) => setTimeout(done, 3)); // a note is unread when it is newer than the claim, to the millisecond
await checkpointDuty(ctx(), { duty_id: filed.duty_id, kind: "note", message: "Also include the customer email." });
await rejects(() => handoffDuty(ctx(token("b1")), { duty_id: filed.duty_id, to_role: "qa", note: "Built it." }), /not handed on yet.*customer email/s);
await handoffDuty(ctx(token("b1")), { duty_id: filed.duty_id, to_role: "qa", note: "Built it; `npm test` passes." });

// --- the reviewer sends it back, then passes it -------------------------------------------------
await claimDuty(ctx(token("q1")), { duty_id: filed.duty_id, agent_id: "q1" });
const back = await handoffDuty(ctx(token("q1")), { duty_id: filed.duty_id, to_role: "engineer", note: "1. orders.js:40 — no ownership check." });
assert.equal(back.bounces, 1);
row = table("duties").get(filed.duty_id);
assert.equal(row.handoff.sent_back, true);
assert.deepEqual(row.role_trail, ["duty-officer", "engineer", "qa"]);
await claimDuty(ctx(token("b1")), { duty_id: filed.duty_id, agent_id: "b1" });
await handoffDuty(ctx(token("b1")), { duty_id: filed.duty_id, to_role: "qa", note: "Fixed, with a test." });
await claimDuty(ctx(token("q1")), { duty_id: filed.duty_id, agent_id: "q1" });
assert.equal((await completeDuty(ctx(token("q1")), { duty_id: filed.duty_id, outcome_summary: "Export landed in abc123; verified in the browser." })).status, "done");

const sum = (roleId, field) => [...table("role_events").values()].filter((e) => e.role === roleId && e.project_id === "team").reduce((n, e) => n + e[field], 0);
assert.equal(sum("duty-officer", "stints"), 1);
assert.equal(sum("engineer", "stints"), 2);
assert.equal(sum("engineer", "sent_back"), 1);
assert.equal(sum("engineer", "passed"), 1);
assert.equal(sum("engineer", "first_pass"), 0, "sent back once, so not at the first attempt");
assert.equal(sum("qa", "done"), 1);
assert.equal(sum("qa", "stints"), 2);
assert.ok([...table("role_events").values()].every((e) => e.owner_uid === "owner" && e.role_name && Number.isInteger(e.hour)));

// --- a person sends finished work back: it starts again with whoever reads duties first ---------
await reopenDuty(ctx(), { duty_id: filed.duty_id, note: "The CSV has no header row." });
row = table("duties").get(filed.duty_id);
assert.equal(row.role, "duty-officer");
assert.equal(row.handoff, null);
assert.equal(sum("engineer", "reopened"), 1);
assert.equal(sum("qa", "reopened"), 1);
assert.equal(sum("duty-officer", "reopened"), 0, "routing it was not the mistake");
await failDuty(ctx(), { duty_id: filed.duty_id, reason: "Not needed after all." });

// --- a first-time pass, and the officer doing a trivial one itself -------------------------------
const quick = await enqueueDuty(ctx(), { project_id: "team", title: "Fix typo", brief: "'recieve' on /about" });
await claimDuty(ctx(token("a1")), { duty_id: quick.duty_id, agent_id: "a1" });
assert.equal((await completeDuty(ctx(token("a1")), { duty_id: quick.duty_id, outcome_summary: "Fixed the typo." })).status, "done", "the role that reads duties first may finish the trivial ones");
const clean = await enqueueDuty(ctx(), { project_id: "team", title: "Clean", brief: "b" });
await claimDuty(ctx(token("a1")), { duty_id: clean.duty_id, agent_id: "a1" });
await handoffDuty(ctx(token("a1")), { duty_id: clean.duty_id, to_role: "senior-engineer", note: "Touches sign-in." });
await claimDuty(ctx(token("b1")), { duty_id: clean.duty_id, agent_id: "b1" });
await handoffDuty(ctx(token("b1")), { duty_id: clean.duty_id, to_role: "qa", note: "Done." });
await claimDuty(ctx(token("q1")), { duty_id: clean.duty_id, agent_id: "q1" });
await completeDuty(ctx(token("q1")), { duty_id: clean.duty_id, outcome_summary: "Verified." });
assert.equal(sum("senior-engineer", "first_pass"), 1);

// --- two roles that cannot agree go to a person --------------------------------------------------
await setRoster(ctx(), { project_id: "team", settings: { max_bounces: 2 } });
const loop = await enqueueDuty(ctx(), { project_id: "team", title: "Loop", brief: "b" });
await claimDuty(ctx(token("a1")), { duty_id: loop.duty_id, agent_id: "a1" });
await handoffDuty(ctx(token("a1")), { duty_id: loop.duty_id, to_role: "engineer", note: "go" });
for (const expected of ["queued", "needs_decision"]) {
  await claimDuty(ctx(token("b1")), { duty_id: loop.duty_id, agent_id: "b1" });
  await handoffDuty(ctx(token("b1")), { duty_id: loop.duty_id, to_role: "qa", note: "built" });
  await claimDuty(ctx(token("q1")), { duty_id: loop.duty_id, agent_id: "q1" });
  const sent = await handoffDuty(ctx(token("q1")), { duty_id: loop.duty_id, to_role: "engineer", note: "still wrong" });
  assert.equal(sent.status, expected);
}
row = table("duties").get(loop.duty_id);
assert.match(row.last_question, /sent this back to Engineer 2 times/);
assert.equal(row.role, "engineer");
await rejects(() => claimDuty(ctx(token("b1")), { duty_id: loop.duty_id, agent_id: "b1" }), /needs_decision/);
await resolveDuty(ctx(), { duty_id: loop.duty_id, resolution_text: "Drop the cache; keep it simple." });
const afterAnswer = await claimDuty(ctx(token("b1")), { duty_id: loop.duty_id, agent_id: "b1" });
assert.equal(afterAnswer.roster.role.id, "engineer");
assert.match(afterAnswer.duty.unblocked_context.human_resolution, /Drop the cache/);
await failDuty(ctx(), { duty_id: loop.duty_id, reason: "test over" });

// --- a plan waits for a person only when the board asks ------------------------------------------
const plan = await enqueueDuty(ctx(), { project_id: "team", title: "Billing", brief: "Design billing" });
await claimDuty(ctx(token("a1")), { duty_id: plan.duty_id, agent_id: "a1" });
await handoffDuty(ctx(token("a1")), { duty_id: plan.duty_id, to_role: "architect", note: "Needs a design." });
await claimDuty(ctx(token("p1")), { duty_id: plan.duty_id, agent_id: "p1" });
// The architect splits the big part out, naming who builds it.
const piece = await enqueueDuty(ctx(token("p1")), { title: "Invoices table", brief: "Schema and migration", role: "senior-engineer", spawned_by: plan.duty_id });
assert.equal(table("duties").get(piece.duty_id).role, "senior-engineer");
await rejects(() => enqueueDuty(ctx(token("p1")), { title: "X", brief: "b", role: "pilot" }), /no role 'pilot'/);
await setRoster(ctx(), { project_id: "team", settings: { plan_approval: true } });
const proposed = await handoffDuty(ctx(token("p1")), { duty_id: plan.duty_id, to_role: "engineer", note: "1. Add table. 2. Add endpoint." });
assert.equal(proposed.status, "needs_decision");
assert.match(proposed.message, /approve the plan/);
assert.match(table("duties").get(plan.duty_id).last_question, /proposes this plan for Engineer.*Add table/s);
await resolveDuty(ctx(), { duty_id: plan.duty_id, resolution_text: "Approved." });
assert.equal((await claimDuty(ctx(token("b1")), { duty_id: plan.duty_id, agent_id: "b1" })).roster.role.id, "engineer");
await failDuty(ctx(), { duty_id: plan.duty_id, reason: "test over" });
await failDuty(ctx(), { duty_id: piece.duty_id, reason: "test over" });
await setRoster(ctx(), { project_id: "team", settings: { plan_approval: false, max_bounces: 3 } });

// --- a team an agent drafts changes nothing until its owner accepts ------------------------------
const drafting = await draftRoster(ctx(), { project_id: "team", note: "We also do support." });
assert.equal((await draftRoster(ctx(), { project_id: "team" })).existing, true, "one drafting at a time");
const draftDuty = table("duties").get(drafting.duty_id);
assert.equal(draftDuty.kind, "roster");
assert.match(draftDuty.brief, /end-to-end tests.*We also do support/s);
const drafter = await claimDuty(ctx(token("d1")), { duty_id: drafting.duty_id, agent_id: "d1" });
assert.equal(drafter.roster, undefined, "drafting the team is not work a role does");
const custom = [role({ id: "desk", name: "Desk", intake: true, level: "light" }), role({ id: "agent", name: "Support Agent", reviewed: true }), role({ id: "lead", name: "Lead", reviews: true, level: "senior" })];
await rejects(() => submitRoster(ctx(token("d1")), { duty_id: drafting.duty_id, roles: custom.slice(0, 2) }), /no role has 'reviews/);
await rejects(() => submitRoster(ctx(token("a1")), { duty_id: drafting.duty_id, roles: custom }), /held by 'd1'/);
await submitRoster(ctx(token("d1")), { duty_id: drafting.duty_id, roles: custom, note: "Support-shaped." });
assert.equal((await getRoster(ctx(), { project_id: "team" })).roles.length, 5, "still the team in force");
assert.equal((await getRoster(ctx(), { project_id: "team" })).draft.roles.length, 3);
assert.equal((await getRoster(ctx(token()), {})).has_draft, true);
assert.equal((await completeDuty(ctx(token("d1")), { duty_id: drafting.duty_id, outcome_summary: "Drafted." })).status, "done");
await rejects(() => acceptRoster(ctx(member), { project_id: "team" }), /owner/);
const accepted = await acceptRoster(ctx(), { project_id: "team" });
assert.equal(accepted.roles.length, 3);
assert.equal(table("projects").get("team").roster.intake, "desk");
await rejects(() => acceptRoster(ctx(), { project_id: "team" }), /no drafted team/);
// A duty still naming a role the team no longer has goes back to whoever reads duties first.
const orphan = await enqueueDuty(ctx(), { project_id: "team", title: "Orphan", brief: "b" });
await store.putOne("duties", orphan.duty_id, { ...table("duties").get(orphan.duty_id), role: "architect" });
assert.equal((await claimDuty(ctx(token("a1")), { duty_id: orphan.duty_id, agent_id: "a1" })).roster.role.id, "desk");
await failDuty(ctx(), { duty_id: orphan.duty_id, reason: "test over" });
// Presets, an edited team, and turning it off.
assert.equal((await setRoster(ctx(), { project_id: "team", preset: "content" })).roles[1].id, "strategist");
await rejects(() => setRoster(ctx(), { project_id: "team", preset: "nope" }), /preset/);
await rejects(() => setRoster(ctx(), { project_id: "team" }), /send 'preset'/);
assert.equal((await setRoster(ctx(), { project_id: "team", off: true })).in_force, false);
assert.equal(table("projects").get("team").roster.intake, null);
const loose = await enqueueDuty(ctx(), { project_id: "team", title: "Loose", brief: "b" });
assert.equal(table("duties").get(loose.duty_id).role, null);
assert.equal((await claimDuty(ctx(token("a1")), { duty_id: loose.duty_id, agent_id: "a1" })).roster, undefined);
assert.equal((await completeDuty(ctx(token("a1")), { duty_id: loose.duty_id, outcome_summary: "done alone" })).status, "done");
await setRoster(ctx(), { project_id: "team", preset: "software" });

// --- the team's memory --------------------------------------------------------------------------
assert.deepEqual({ ...(await getMemory(ctx(token()), {})), project_id: undefined }, { project_id: undefined, body: "", version: 0, chars: 0, max_chars: MAX_MEMORY_CHARS, updated_at: null, updated_by: null });
await rejects(() => writeMemory(ctx(token("a1")), { body: "x", based_on: 0 }), /hold an active duty/);
const noted = await enqueueDuty(ctx(), { project_id: "team", title: "Remember", brief: "b" });
await claimDuty(ctx(token("a1")), { duty_id: noted.duty_id, agent_id: "a1" });
await rejects(() => writeMemory(ctx(token("a1")), { body: "x" }), /based_on/);
await rejects(() => writeMemory(ctx(token("a1")), { body: "x".repeat(MAX_MEMORY_CHARS + 1), based_on: 0 }), /at most 6000/);
await rejects(() => writeMemory(ctx(token("a1")), { body: 12, based_on: 0 }), /whole memory as text/);
const first = await writeMemory(ctx(token("a1")), { body: "## Decisions\n- Orders export streams; never buffer it.\n", based_on: 0 });
assert.equal(first.version, 1);
assert.equal(first.updated_by.role, "duty-officer");
assert.equal(first.updated_by.duty_id, noted.duty_id);
// A second session that read version 0 does not erase what the first wrote.
await assert.rejects(() => writeMemory(ctx(token("a1")), { body: "mine only", based_on: 0 }), (err) => /changed since you read it/.test(err.message) && /never buffer/.test(err.details.body));
assert.equal((await writeMemory(ctx(token("a1")), { body: "## Decisions\n- Orders export streams.\n- Tests: `npm test`.", based_on: 1 })).version, 2);
await completeDuty(ctx(token("a1")), { duty_id: noted.duty_id, outcome_summary: "Wrote it down." });
const next = await enqueueDuty(ctx(), { project_id: "team", title: "Next", brief: "b" });
assert.match((await claimDuty(ctx(token("b1")), { duty_id: next.duty_id, agent_id: "b1" })).memory.body, /npm test/, "the next session starts from it");
await failDuty(ctx(), { duty_id: next.duty_id, reason: "test over" });
await rejects(() => writeMemory(ctx(member), { project_id: "team", body: "" }), /owner/);
assert.equal((await writeMemory(ctx(), { project_id: "team", body: "" })).chars, 0, "the owner can clear it");
assert.equal((await getMemory(ctx(member), { project_id: "team" })).version, 3, "a member reads it");
await rejects(() => getMemory(ctx({ kind: "human", uid: "stranger" }), { project_id: "team" }), /do not own/);
await rejects(() => getRoster(ctx({ kind: "human", uid: "stranger" }), { project_id: "team" }), /do not own/);
// A review of notes reads the board and writes nothing.
await store.putOne("duties", "review1", { project_id: "team", owner_uid: "owner", kind: "note_review", status: "active", assigned_agent_id: "r1", title: "Review", brief: "b" });
await store.putOne("agents", "team:r1", { project_id: "team", agent_id: "r1", active_duty_id: "review1" });
await rejects(() => writeMemory(ctx(token("r1")), { body: "x", based_on: 3 }), /note review/);

// --- a machine: its levels pick the model, and an old one is kept off the board -----------------
await store.putOne("machines", "mk", { machine_id: "m1", name: "Laptop", owner_uid: "owner", agent_prefix: "laptop", cli_version: ROSTER_MIN_RELEASE, agent_options: all });
await store.putOne("machine_links", "team:m1", { project_id: "team", machine_id: "m1", owner_uid: "owner", agent_prefix: "laptop" });
const machine = (version = ROSTER_MIN_RELEASE, rowOver = {}) => ({ kind: "agent", projectId: "team", machineId: "m1", machineKey: "mk", ownerUid: "owner", agentPrefix: "laptop", defaultAgentId: "laptop", machineRow: { ...table("machines").get("mk"), cli_version: version, ...rowOver } });
for (const d of [...table("duties").values()].filter((d) => d.project_id === "team" && ["queued", "active"].includes(d.status))) await store.delete("duties", [d.key]);
for (const a of [...table("agents").values()]) await store.putOne("agents", a.key, { ...a, active_duty_id: null });
const leveled = await enqueueDuty(ctx(), { project_id: "team", title: "Leveled", brief: "b" });
let poll = await pollMachine(ctx(machine()), {});
let offered = poll.boards[0].runnable.find((r) => r.duty_id === leveled.duty_id);
assert.equal(offered.role, "duty-officer");
assert.deepEqual(offered.agent_options, [haiku, opus, opusX, fable], "routing runs on the lightest combination");
assert.equal((await pollMachine(ctx(machine("2.35.0")), {})).boards.length, 0, "an older runner is not offered a board with a team");
await rejects(() => claimDuty(ctx(machine("2.35.0")), { duty_id: leveled.duty_id, agent_id: "laptop/1" }), new RegExp(ROSTER_MIN_RELEASE.replaceAll(".", "\\.")));
const mClaim = await claimDuty(ctx(machine()), { duty_id: leveled.duty_id, agent_id: "laptop/1" });
assert.deepEqual(mClaim.duty.agent_options, [haiku, opus, opusX, fable]);
poll = await pollMachine(ctx(machine()), {});
assert.deepEqual(poll.boards[0].active[0].agent_options, [haiku, opus, opusX, fable]);
assert.equal(poll.boards[0].active[0].role, "duty-officer");
await handoffDuty(ctx(machine()), { duty_id: leveled.duty_id, agent_id: "laptop/1", to_role: "architect", note: "Design it." });
row = table("duties").get(leveled.duty_id);
assert.equal(row.affinity.machine_id, "m1", "kept for the machine whose worktree has the work");
poll = await pollMachine(ctx(machine()), {});
offered = poll.boards[0].runnable.find((r) => r.duty_id === leveled.duty_id);
assert.deepEqual(offered.agent_options, [fable, opusX, opus, haiku], "design runs on the most capable");
assert.equal(offered.resumes, true);
assert.deepEqual((await getDuty(ctx(machine()), { duty_id: leveled.duty_id })).duty.agent_options, [fable, opusX, opus, haiku]);
// A duty a person pinned to a model keeps it, whatever its role.
await store.putOne("duties", leveled.duty_id, { ...table("duties").get(leveled.duty_id), agent_options: [opus] });
assert.deepEqual((await pollMachine(ctx(machine()), {})).boards[0].runnable.find((r) => r.duty_id === leveled.duty_id).agent_options, [opus]);
await store.putOne("duties", leveled.duty_id, { ...table("duties").get(leveled.duty_id), agent_options: null });
// The owner says what level a combination works at, and that wins over the reading of its name.
await rejects(() => updateMachine(ctx(), { machine_id: "m1", agent_options: [{ ...haiku, level: "genius" }] }), /level/);
const tagged = await updateMachine(ctx(), { machine_id: "m1", agent_options: [{ ...haiku, level: "principal" }, opus] });
assert.deepEqual(tagged.machine.agent_options, [{ ...haiku, level: "principal" }, opus]);
assert.deepEqual(tagged.machine.auto_levels, ["light", "standard"]);
assert.deepEqual((await pollMachine(ctx(machine()), {})).boards[0].runnable.find((r) => r.duty_id === leveled.duty_id).agent_options, [haiku, opus]);
assert.deepEqual((await machineMe(ctx(machine()))).machine.agent_options, [haiku, opus], "the daemon is sent combinations, not levels");
// Nothing enabled: the duty is not offered, rather than claimed and stranded.
await updateMachine(ctx(), { machine_id: "m1", agent_options: [{ ...opus, disabled: true }] });
assert.ok(!(await pollMachine(ctx(machine()), {})).boards[0].runnable.some((r) => r.duty_id === leveled.duty_id));
await store.putOne("machines", "mk", { ...table("machines").get("mk"), agent_options: all });

// --- secrets typed in the console reach the machine sealed ---------------------------------------
const sealKey = "B" + "A".repeat(86);
await reportReadiness(ctx(machine()), {
  items: [{ key: "mcp_secrets", label: "MCP server secrets", state: "todo", secrets: [{ board: "team", server: "shop", name: "Authorization", header: true, note: "The shop's API" }] }],
  seal_key: sealKey,
});
assert.equal(table("machines").get("mk").seal_key, sealKey);
const listed = (await listMachines(ctx(), {})).machines[0];
assert.equal(listed.seal_key, sealKey);
assert.deepEqual(listed.readiness.items[0].secrets, [{ board: "team", server: "shop", name: "Authorization", header: true, note: "The shop's API" }]);
await rejects(() => reportReadiness(ctx(machine()), { items: [], seal_key: "short" }), /P-256/);
await rejects(() => reportReadiness(ctx(machine()), { items: [{ key: "mcp_secrets", state: "todo", secrets: [{ board: "team", server: "Bad Name", name: "X" }] }] }), /does not name/);
const send = (over = {}) => requestSetup(ctx(), { machine_id: "m1", kind: "mcp_secrets", sealed: "v1.abc-DEF_123", seal_key: sealKey, ...over });
await rejects(() => send({ sealed: "Bearer sk-live plain text!" }), /encrypted envelope/);
await rejects(() => send({ sealed: "" }), /sealed/);
await rejects(() => send({ seal_key: "B" + "C".repeat(86) }), /key changed/);
await rejects(() => requestSetup(ctx(member), { machine_id: "m1", kind: "mcp_secrets", sealed: "v1.abc", seal_key: sealKey }), /not found/);
const sent = await send();
assert.equal(sent.request.kind, "mcp_secrets");
assert.equal(sent.request.input, undefined, "the envelope is not shown back to the console");
await rejects(() => send(), /already storing/);
assert.equal((await machineMe(ctx(machine()))).requests.find((r) => r.request_id === sent.request.request_id).input, "v1.abc-DEF_123", "only the machine reads it");
await reportRequest(ctx(machine()), { request_id: sent.request.request_id, status: "done", result: "stored 1 secret" });
assert.equal(table("machine_requests").get(sent.request.request_id).input, "", "and it is gone once the machine has it");
await store.putOne("machines", "mk", { ...table("machines").get("mk"), cli_version: "2.35.0" });
await rejects(() => send(), /has not published a key/);
await store.putOne("machines", "mk", { ...table("machines").get("mk"), cli_version: ROSTER_MIN_RELEASE });

// --- the tools say what a role needs to know ----------------------------------------------------
const mcp = async (method, params, caller = token()) => (await (await handleMcp(ctx(caller), new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), 1 << 20)).json()).result;
const init = await mcp("initialize", {});
for (const must of [/THE TEAM\n/, /THE TEAM'S MEMORY/, /duty_handoff/, /'reviewed' never lands or completes/, /board_memory_write/]) assert.match(init.instructions, must);
const tools = Object.fromEntries((await mcp("tools/list", {})).tools.map((t) => [t.name, t]));
for (const name of ["duty_handoff", "board_roster", "board_roster_submit", "board_memory", "board_memory_write"]) assert.ok(tools[name], name);
assert.ok(tools.duty_enqueue.inputSchema.properties.role);
assert.deepEqual(tools.duty_handoff.inputSchema.required, ["duty_id", "to_role", "note"]);
assert.deepEqual(tools.board_roster_submit.inputSchema.properties.roles.items.properties.level.enum, LEVELS);
const submitTools = (await mcp("tools/list", {}, { ...token(), scope: "submit" })).tools.map((t) => t.name);
for (const name of ["duty_handoff", "board_roster", "board_memory", "board_memory_write"]) assert.ok(!submitTools.includes(name), `${name} is not a submit token's`);
const viaTool = await mcp("tools/call", { name: "board_roster", arguments: { role: "qa" } });
assert.match(viaTool.structuredContent.role.charter, /Nothing lands/);
assert.equal((await mcp("tools/call", { name: "board_memory", arguments: {} })).structuredContent.max_chars, MAX_MEMORY_CHARS);
const refused = await mcp("tools/call", { name: "duty_handoff", arguments: { duty_id: leveled.duty_id, to_role: "qa", note: "x" } });
assert.equal(refused.isError, true);

// --- nobody from outside the board gets an answer from any of it --------------------------------
const outsiders = [
  ["a stranger", { kind: "human", uid: "stranger", name: "Stranger" }],
  ["another board's agent", { kind: "agent", projectId: "plain", tokenKey: "other", tokenName: "other", defaultAgentId: "x" }],
  ["a submit token on this board", { ...token(), scope: "submit", tokenKey: "sub" }],
];
const held = leveled.duty_id;
const guarded = [
  ["/duty/handoff", (c) => handoffDuty(ctx(c), { duty_id: held, agent_id: "x", to_role: "qa", note: "no" })],
  ["/board/roster/set", (c) => setRoster(ctx(c), { project_id: "team", off: true })],
  ["/board/roster/accept", (c) => acceptRoster(ctx(c), { project_id: "team" })],
  ["/board/roster/draft", (c) => draftRoster(ctx(c), { project_id: "team" })],
  ["/board/roster/submit", (c) => submitRoster(ctx(c), { duty_id: held, roles: custom })],
  ["/board/memory/write", (c) => writeMemory(ctx(c), { project_id: "team", body: "no", based_on: 0 })],
  ["/board/memory/history", (c) => memoryHistory(ctx(c), { project_id: "team" })],
  ["/board/roster/retro", (c) => retroRoster(ctx(c), { project_id: "team" })],
  ["/duty/usage", (c) => reportUsage(ctx(c), { duty_id: held, ms: 1000 })],
];
for (const [who, caller] of outsiders) {
  for (const [path, attempt] of guarded) await assert.rejects(() => attempt(caller), undefined, `${path} answered ${who}`);
}
for (const [who, caller] of outsiders.slice(0, 2)) {
  await assert.rejects(() => getRoster(ctx(caller), { project_id: "team" }), undefined, `/board/roster answered ${who}`);
  await assert.rejects(() => getMemory(ctx(caller), { project_id: "team" }), undefined, `/board/memory answered ${who}`);
}
assert.equal(table("projects").get("team").roster.intake, "duty-officer", "and none of them changed anything");

// --- every board's team at once, for the boards page's office ------------------------------------
const rosters = (await listRosters(ctx(), { project_ids: ["team", "plain"] })).rosters;
assert.equal(rosters.plain, null, "a board with no team");
assert.equal(rosters.team.intake, "duty-officer");
assert.equal(rosters.team.roles.length, 5);
assert.equal(rosters.team.roles[0].charter, undefined, "cards, not charters");
await rejects(() => listRosters(ctx({ kind: "human", uid: "stranger" }), { project_ids: ["team"] }), /do not own/);
await rejects(() => listRosters(ctx(), { project_ids: ["team", "nope"] }), /not found/);
assert.deepEqual((await listRosters(ctx(member), { project_ids: ["team"] })).rosters.team.intake, "duty-officer", "a member sees it too");
const minted = [];
const liveCtx = (caller) => ({ ...ctx(caller), cfg: { channelInstance: "live" }, env: { channel: { token: async (_i, opts) => (minted.push(opts), { token: "t" }) } } });
assert.deepEqual((await liveBoards(liveCtx(owner), { project_ids: ["team", "plain"] })).channels, ["board.team", "board.plain"]);
assert.equal(minted[0].presenceId, "owner");
await rejects(() => liveBoards(liveCtx({ kind: "human", uid: "stranger" }), { project_ids: ["team"] }), /do not own/);
await rejects(() => liveBoards(liveCtx(owner), { project_ids: [] }), /at least one/);
await rejects(() => liveBoards(liveCtx(owner), { project_ids: Array.from({ length: 41 }, (_, i) => `b${i}`) }), /at most 40/);
await rejects(() => liveBoards(ctx(owner), { project_ids: ["team"] }), /not configured/);

// =================================================================================================
// What keeps a team honest and cheap: bounds on circling and on time, review that follows risk,
// recurring work that remembers its route, split work checked as a whole, and learning from send-backs.
// =================================================================================================
const clearTeam = async () => {
  for (const d of [...table("duties").values()].filter((d) => d.project_id === "team" && UNFINISHED.includes(d.status))) await store.delete("duties", [d.key]);
  for (const a of [...table("agents").values()]) await store.putOne("agents", a.key, { ...a, active_duty_id: null });
};
await clearTeam();
/** One role's turn: take the duty, pass it on. */
const turn = async (id, agent, to, extra = {}, caller = token(agent)) => {
  await claimDuty(ctx(caller), { duty_id: id, agent_id: agent });
  return handoffDuty(ctx(caller), { duty_id: id, agent_id: agent, to_role: to, note: `Over to ${to}.`, ...extra });
};
const file = (title, brief = "b") => enqueueDuty(ctx(), { project_id: "team", title, brief });

// --- settings ----------------------------------------------------------------------------------
assert.deepEqual((await getRoster(ctx(), { project_id: "team" })).settings, { plan_approval: false, max_bounces: 3, max_handoffs: 12, independent_review: true, sensitive_paths: [] });
await rejects(() => setRoster(ctx(), { project_id: "team", settings: { max_handoffs: "lots" } }), /max_handoffs/);
await setRoster(ctx(), { project_id: "team", settings: { max_handoffs: 1 } });
assert.equal((await getRoster(ctx(), { project_id: "team" })).settings.max_handoffs, 4, "held to a floor: a team needs room to route, build, review and send back");
await rejects(() => setRoster(ctx(), { project_id: "team", settings: { sensitive_paths: ["/etc/passwd"] } }), /inside the project/);
await rejects(() => setRoster(ctx(), { project_id: "team", settings: { sensitive_paths: Array.from({ length: 21 }, (_, i) => `p${i}/**`) } }), /at most 20/);
await rejects(() => setRoster(ctx(), { project_id: "team", settings: { independent_review: "yes" } }), /boolean/);

// --- a duty passed round and round goes to a person, whichever roles are doing it ----------------
await setRoster(ctx(), { project_id: "team", settings: { max_handoffs: 4, sensitive_paths: ["auth/**"] } });
const circle = await file("Circle");
for (const [agent, to] of [["a1", "architect"], ["p1", "duty-officer"], ["a1", "architect"]]) assert.equal((await turn(circle.duty_id, agent, to)).status, "queued");
const fourth = await turn(circle.duty_id, "p1", "duty-officer");
assert.equal(fourth.status, "needs_decision");
assert.match(fourth.message, /what should happen to it/);
assert.match(table("duties").get(circle.duty_id).last_question, /handed from role to role 4 times/);
assert.equal(table("duties").get(circle.duty_id).bounces, 0, "nobody sent work back: this is the other kind of circle");
await failDuty(ctx(), { duty_id: circle.duty_id, reason: "test over" });
await setRoster(ctx(), { project_id: "team", settings: { max_handoffs: 12 } });

// --- how careful the review is follows the duty's risk -------------------------------------------
assert.equal(levelFor({ level: "senior", reviews: true }, { risk: "low" }), "standard");
assert.equal(levelFor({ level: "senior", reviews: true }, { risk: "high" }), "principal");
assert.equal(levelFor({ level: "senior", reviews: true }, {}), "senior");
assert.equal(levelFor({ level: "principal", reviews: true }, { risk: "high" }), "principal", "there is nothing above the top");
assert.equal(levelFor({ level: "standard", reviewed: true }, { risk: "high" }), "standard", "risk moves the reviewer, not the builder");
const codexX = { agent: "codex", model: "gpt-x", effort: "xhigh" };
assert.deepEqual(optionsForLevel([...all, codexX], "senior"), [opusX, codexX, fable, opus, haiku]);
assert.deepEqual(optionsForLevel([...all, codexX], "senior", { agent: "claude-code", model: "claude-opus-5-5" }), [codexX, opusX, fable, opus, haiku], "a reviewer on another model than the builder, where the level has one");
await store.putOne("machines", "mk", { ...table("machines").get("mk"), agent_options: [...all, codexX] });

const risky = await file("Risky");
await claimDuty(ctx(token("a1")), { duty_id: risky.duty_id, agent_id: "a1" });
await rejects(() => handoffDuty(ctx(token("a1")), { duty_id: risky.duty_id, to_role: "engineer", note: "x", risk: "dire" }), /risk/);
assert.equal((await handoffDuty(ctx(token("a1")), { duty_id: risky.duty_id, to_role: "engineer", note: "Wording only.", risk: "low" })).risk, "low", "the role that reads it first says");
const lowBuild = await claimDuty(ctx(token("b1")), { duty_id: risky.duty_id, agent_id: "b1" });
assert.equal(lowBuild.roster.risk, "low");
assert.equal(lowBuild.duty.risk, "low");
// A builder raises it. And what only a machine can know is not taken from anything else.
const raised = await handoffDuty(ctx(token("b1")), {
  duty_id: risky.duty_id, to_role: "qa", note: "Built.", risk: "normal",
  sensitive: true, worked_with: { agent: "claude-code", model: "claude-opus-5-5" }, checks: { passed: true, command: "npm test", commit: "abc" },
});
assert.equal(raised.risk, "normal");
row = table("duties").get(risky.duty_id);
assert.equal(row.handoff.worked_with, undefined, "a token does not say which model worked");
assert.equal(row.handoff.checks, undefined, "nor that the checks passed");
// A reviewer cannot make its own review lighter.
await claimDuty(ctx(token("q1")), { duty_id: risky.duty_id, agent_id: "q1" });
assert.equal((await handoffDuty(ctx(token("q1")), { duty_id: risky.duty_id, to_role: "engineer", note: "1. Wrong word.", risk: "low" })).risk, "normal");
// The machine that ran the builder: it saw a sensitive path change, ran the checks, and knows the model.
await claimDuty(ctx(machine()), { duty_id: risky.duty_id, agent_id: "laptop/1" });
const attested = await handoffDuty(ctx(machine()), {
  duty_id: risky.duty_id, agent_id: "laptop/1", to_role: "qa", note: "Fixed.",
  sensitive: true, worked_with: { agent: "claude-code", model: "claude-opus-5-5" }, checks: { passed: true, command: "npm test", commit: "abc123" },
});
assert.equal(attested.risk, "high", "a change to a sensitive path is high-risk whatever anyone said");
row = table("duties").get(risky.duty_id);
assert.deepEqual(row.handoff.worked_with, { agent: "claude-code", model: "claude-opus-5-5" });
assert.equal(row.handoff.checks.command, "npm test");
assert.equal(row.handoff.checks.commit, "abc123");
assert.ok(row.handoff.checks.at);
offered = (await pollMachine(ctx(machine()), {})).boards[0].runnable.find((r) => r.duty_id === risky.duty_id);
assert.deepEqual(offered.agent_options, [fable, codexX, opusX, opus, haiku], "high risk: the most capable reviewer, then one that did not build it");
assert.equal(offered.risk, "high");
const review = await claimDuty(ctx(machine()), { duty_id: risky.duty_id, agent_id: "laptop/1" });
assert.equal(review.roster.risk, "high");
assert.equal(review.roster.handoff.checks.commit, "abc123", "the reviewer is told the suite already passed, and on what");
await setRoster(ctx(), { project_id: "team", settings: { independent_review: false } });
assert.deepEqual((await getDuty(ctx(machine()), { duty_id: risky.duty_id })).duty.agent_options, [fable, opusX, codexX, opus, haiku], "off: the machine's own order");
await setRoster(ctx(), { project_id: "team", settings: { independent_review: true } });
await completeDuty(ctx(machine()), { duty_id: risky.duty_id, agent_id: "laptop/1", outcome_summary: "Verified." });
await store.putOne("machines", "mk", { ...table("machines").get("mk"), agent_options: all });

// --- a duty that has used its allowance of agent time asks before using more ---------------------
const boardRow = () => table("projects").get("team");
const setMinutes = (duty_minutes) => store.putOne("projects", "team", { ...boardRow(), runner: { ...(boardRow().runner || {}), duty_minutes } });
await setMinutes(1);
const long = await file("Long");
await claimDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1" });
await rejects(() => reportUsage(ctx(token("a1")), { duty_id: long.duty_id, ms: 5 }), /only the machine/);
await rejects(() => reportUsage(ctx(), { duty_id: long.duty_id, ms: 5 }), /only the machine/);
assert.equal((await reportUsage(ctx(machine()), { duty_id: long.duty_id, ms: 40000 })).ms, 40000);
const used = await reportUsage(ctx(machine()), { duty_id: long.duty_id, ms: 21000 });
assert.deepEqual([used.ms, used.sessions], [61000, 2]);
assert.equal(table("duties").get(long.duty_id).status, "active", "reporting time never touches the duty's own row");
await handoffDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1", to_role: "engineer", note: "Go." });
await rejects(() => claimDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1" }), /over its board's limit of agent time/);
row = table("duties").get(long.duty_id);
assert.equal(row.status, "needs_decision");
assert.match(row.last_question, /session time on this duty/);
assert.equal(row.role, "engineer", "it stays with the role it was going to");
assert.deepEqual((await getDuty(ctx(), { duty_id: long.duty_id })).duty.usage, { ms: 61000, sessions: 2 });
await resolveDuty(ctx(), { duty_id: long.duty_id, resolution_text: "Go on." });
assert.equal(table("duties").get(long.duty_id).budget_extra_ms, 60000, "the answer grants the same allowance again");
assert.equal((await claimDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1" })).roster.role.id, "engineer");
await reportUsage(ctx(machine()), { duty_id: long.duty_id, ms: 120000 });
await handoffDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1", to_role: "qa", note: "Built." });
await setMinutes(0);
assert.equal((await claimDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1" })).roster.role.id, "qa", "0 is no limit");
await completeDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1", outcome_summary: "Verified." });
// Sent back by a person, its allowance counts from here.
await setMinutes(1);
await reopenDuty(ctx(), { duty_id: long.duty_id, note: "Still wrong." });
assert.equal(table("duties").get(long.duty_id).budget_extra_ms, 181000);
await claimDuty(ctx(machine()), { duty_id: long.duty_id, agent_id: "laptop/1" });
await failDuty(ctx(), { duty_id: long.duty_id, reason: "test over" });
const { duty_minutes: _unset, ...runnerBefore } = boardRow().runner;
await store.putOne("projects", "team", { ...boardRow(), runner: runnerBefore });

// --- the memory's earlier versions, and putting one back -----------------------------------------
await rejects(() => memoryHistory(ctx(token()), {}), /people on the board/);
const before = (await getMemory(ctx(), { project_id: "team" })).version;
for (const body of ["one", "two", "three"]) await writeMemory(ctx(), { project_id: "team", body });
let history = await memoryHistory(ctx(member), { project_id: "team" });
assert.equal(history.version, before + 3);
assert.deepEqual(history.versions.slice(0, 2).map((v) => [v.version, v.body]), [[before + 2, "two"], [before + 1, "one"]], "newest first, without the one in force");
assert.ok(history.versions.some((v) => /npm test/.test(v.body) && v.updated_by.role === "duty-officer"), "and who wrote each");
const restored = await writeMemory(ctx(), { project_id: "team", body: history.versions[1].body, based_on: history.version });
assert.equal(restored.body, "one");
for (let i = 0; i < MEMORY_VERSIONS_KEPT + 4; i++) await writeMemory(ctx(), { project_id: "team", body: `write ${i}` });
history = await memoryHistory(ctx(), { project_id: "team" });
assert.equal(history.versions.length, MEMORY_VERSIONS_KEPT);
assert.equal([...table("memory_history").values()].filter((h) => h.project_id === "team").length, MEMORY_VERSIONS_KEPT, "older ones are dropped, not kept for ever");

// --- a recurring duty goes straight to where its last run was routed -----------------------------
const weekly = (await createSchedule(ctx(), { project_id: "team", title: "Weekly report", brief: "Summarise the week's orders.", cron: "0 9 * * 1", tz: "UTC" })).schedule;
assert.equal(weekly.route, null);
const runNow = async () => {
  await updateSchedule(ctx(), { schedule_id: weekly.schedule_id, next_due_at: Date.now() - 1000 });
  await runDueSchedules(ctx(), { projectKey: "team" });
  return table("schedules").get(weekly.schedule_id).last_duty_id;
};
const run1 = await runNow();
assert.equal((await claimDuty(ctx(token("a1")), { duty_id: run1, agent_id: "a1" })).roster.role.id, "duty-officer", "the first run is read and routed like any duty");
await handoffDuty(ctx(token("a1")), { duty_id: run1, to_role: "engineer", note: "A report: no design needed.", risk: "low" });
assert.deepEqual({ ...table("schedules").get(weekly.schedule_id).route, at: 0 }, { role: "engineer", risk: "low", at: 0 });
await failDuty(ctx(), { duty_id: run1, reason: "test over" });
const run2 = await runNow();
row = table("duties").get(run2);
assert.deepEqual([row.role, row.risk, row.routed], ["engineer", "low", true]);
const routedClaim = await claimDuty(ctx(token("b1")), { duty_id: run2, agent_id: "b1" });
assert.equal(routedClaim.roster.role.id, "engineer", "no second routing session");
assert.equal(routedClaim.roster.handoff, null);
// The builder passing it on is not routing, and changes nothing about where runs start.
await handoffDuty(ctx(token("b1")), { duty_id: run2, to_role: "qa", note: "Written." });
assert.equal(table("schedules").get(weekly.schedule_id).route.role, "engineer");
await failDuty(ctx(), { duty_id: run2, reason: "test over" });
// A different ask is routed afresh.
assert.equal((await updateSchedule(ctx(), { schedule_id: weekly.schedule_id, enabled: true })).schedule.route.role, "engineer");
assert.equal((await updateSchedule(ctx(), { schedule_id: weekly.schedule_id, brief: "Redesign the weekly report." })).schedule.route, null);
// And a route to a role the team no longer has falls back to whoever reads duties first.
await store.putOne("schedules", weekly.schedule_id, { ...table("schedules").get(weekly.schedule_id), route: { role: "retired", risk: "normal" } });
const run3 = await runNow();
assert.equal((await claimDuty(ctx(token("a1")), { duty_id: run3, agent_id: "a1" })).roster.role.id, "duty-officer");
await failDuty(ctx(), { duty_id: run3, reason: "test over" });
await updateSchedule(ctx(), { schedule_id: weekly.schedule_id, enabled: false });

// --- split work is checked once more, as a whole -------------------------------------------------
const wholeOf = (parent) => [...table("duties").values()].filter((d) => d.acceptance_of === parent);
const build = async (id) => {
  await turn(id, "b1", "qa");
  await claimDuty(ctx(token("q1")), { duty_id: id, agent_id: "q1" });
  return completeDuty(ctx(token("q1")), { duty_id: id, outcome_summary: `Verified ${id}.` });
};
const big = await file("Billing v2", "Invoices, and a page to see them.");
await turn(big.duty_id, "a1", "architect");
await claimDuty(ctx(token("p1")), { duty_id: big.duty_id, agent_id: "p1" });
const pieceA = await enqueueDuty(ctx(token("p1")), { title: "Invoices table", brief: "Schema and migration.", role: "engineer", spawned_by: big.duty_id });
const pieceB = await enqueueDuty(ctx(token("p1")), { title: "Invoices page", brief: "List and detail.", role: "engineer", spawned_by: big.duty_id });
assert.equal(table("duties").get(pieceA.duty_id).split_from, big.duty_id);
assert.equal(table("duties").get((await file("Unrelated")).duty_id).split_from, null, "a duty a person files is nobody's piece");
await completeDuty(ctx(token("p1")), { duty_id: big.duty_id, outcome_summary: "Split into two pieces." });
await build(pieceA.duty_id);
assert.equal(wholeOf(big.duty_id).length, 0, "not while a piece is unfinished");
events.length = 0;
await build(pieceB.duty_id);
const [whole] = wholeOf(big.duty_id);
assert.ok(whole, "the last piece files the check");
assert.equal(whole.title, "Check the whole: Billing v2");
assert.equal(whole.role, "qa", "a reviewer's");
assert.equal(whole.risk, "high");
for (const must of [/Invoices, and a page to see them\./, /Invoices table/, /Invoices page/, /do not review each piece again/]) assert.match(whole.brief, must);
assert.equal(table("duties").get(big.duty_id).acceptance_duty_id, whole.key);
assert.ok(events.some((e) => e.id === whole.key && e.status === "queued"), "and the board hears about it");
assert.equal((await getDuty(ctx(), { duty_id: whole.key })).duty.acceptance_of, big.duty_id);
// A piece sent back and finished again does not file a second check; nor does the check itself.
await reopenDuty(ctx(), { duty_id: pieceB.duty_id, note: "Detail page 404s." });
await claimDuty(ctx(token("a1")), { duty_id: pieceB.duty_id, agent_id: "a1" });
await completeDuty(ctx(token("a1")), { duty_id: pieceB.duty_id, outcome_summary: "Fixed the route." });
assert.equal(wholeOf(big.duty_id).length, 1);
assert.equal((await claimDuty(ctx(token("q1")), { duty_id: whole.key, agent_id: "q1" })).roster.role.id, "qa");
const followUp = await enqueueDuty(ctx(token("q1")), { title: "Link the page from the nav", brief: "Nothing links to /invoices.", role: "engineer" });
await completeDuty(ctx(token("q1")), { duty_id: whole.key, outcome_summary: "Works together; filed the missing nav link." });
await build(followUp.duty_id);
assert.equal(wholeOf(whole.key).length, 0, "a check of the whole is not itself checked as a whole");
// Nothing delivered, nothing to check.
const dud = await file("Dud");
await turn(dud.duty_id, "a1", "architect");
await claimDuty(ctx(token("p1")), { duty_id: dud.duty_id, agent_id: "p1" });
const dudPiece = await enqueueDuty(ctx(token("p1")), { title: "Dud piece", brief: "b", role: "engineer" });
await completeDuty(ctx(token("p1")), { duty_id: dud.duty_id, outcome_summary: "Split." });
await failDuty(ctx(), { duty_id: dudPiece.duty_id, reason: "Not wanted." });
assert.equal(wholeOf(dud.duty_id).length, 0);
await clearTeam();

// --- what reviewers keep sending back becomes a proposal to change the charters and the rules ----
const rosterRow = () => table("rosters").get("team");
assert.ok(rosterRow().sent_backs.length >= 1 && rosterRow().sent_backs.every((b) => b.title && b.note && b.from === "QA"), "the board has been keeping them");
const retros = () => [...table("duties").values()].filter((d) => d.project_id === "team" && d.kind === "retro");
assert.equal(retros().length, 0);
for (let i = 0; rosterRow().sent_back_since_retro !== 0 || i === 0; i++) {
  assert.ok(i < RETRO_EVERY + 1, "a retro is filed every RETRO_EVERY send-backs");
  const d = await file(`Sent back ${i}`);
  await turn(d.duty_id, "a1", "engineer");
  await turn(d.duty_id, "b1", "qa");
  await turn(d.duty_id, "q1", "engineer", { note: `${i}. No ownership check on the read.` });
  await failDuty(ctx(), { duty_id: d.duty_id, reason: "test over" });
}
const [retro] = retros();
assert.ok(retro && retro.status === "queued", "filed by the board itself");
assert.match(retro.brief, /QA sent it back to Engineer — \d+\. No ownership check/);
assert.match(retro.brief, /board_roster_submit.*board_rules_submit/s);
assert.ok(rosterRow().sent_backs.length <= SENT_BACKS_KEPT);
assert.equal((await retroRoster(ctx(), { project_id: "team" })).existing, true, "one at a time");
await rejects(() => retroRoster(ctx(member), { project_id: "team" }), /owner/);
const retroClaim = await claimDuty(ctx(token("r9")), { duty_id: retro.key, agent_id: "r9" });
assert.equal(retroClaim.roster, undefined, "housekeeping, not a role's work");
const whole5 = (await getRoster(ctx(token("r9")), { charters: true })).roles;
assert.ok(whole5.every((r) => r.charter), "it reads every charter whole");
const edited = whole5.map((r) => (r.id === "engineer" ? { ...r, charter: `${r.charter}\n- Every read checks that the caller owns the row.` } : r));
await rejects(() => submitRoster(ctx(token("b1")), { duty_id: retro.key, roles: edited }), /held by 'r9'/);
const proposedTeam = await submitRoster(ctx(token("r9")), { duty_id: retro.key, roles: edited, note: "QA found a missing ownership check ten times." });
assert.equal(proposedTeam.roles, 5);
assert.match(rosterRow().draft.roles.find((r) => r.id === "engineer").charter, /owns the row/);
assert.ok(!/owns the row/.test(rosterRow().roles.find((r) => r.id === "engineer").charter), "a draft: nothing in force changed");
await submitRules(ctx(token("r9")), { duty_id: retro.key, body: "# Rules\n- Every read checks ownership." });
assert.equal(table("rules").get("team").draft.duty_id, retro.key);
await completeDuty(ctx(token("r9")), { duty_id: retro.key, outcome_summary: "Proposed one charter line and one rule." });
const ordinary = await file("Ordinary");
await claimDuty(ctx(token("a1")), { duty_id: ordinary.duty_id, agent_id: "a1" });
await rejects(() => submitRules(ctx(token("a1")), { duty_id: ordinary.duty_id, body: "# Mine" }), /not an active rules or retro duty/);
await rejects(() => submitRoster(ctx(token("a1")), { duty_id: ordinary.duty_id, roles: edited }), /not an active roster or retro duty/);
const kept = rosterRow().sent_backs.length;
await setRoster(ctx(), { project_id: "team", discard_draft: true });
assert.equal(rosterRow().sent_backs.length, kept, "changing the team does not forget what was sent back");
const asked = await retroRoster(ctx(), { project_id: "team" });
assert.equal(asked.existing, false, "and the owner can ask for one at any time");
assert.equal(table("duties").get(asked.duty_id).kind, "retro");
const seenByOwner = await getRoster(ctx(), { project_id: "team" });
assert.equal(seenByOwner.sent_backs.length, kept);
assert.equal(seenByOwner.retro_every, RETRO_EVERY);
await clearTeam();

// --- what an agent notices and need not happen now goes on the Notes, not the queue ---------------
await rejects(() => addAgentNote(ctx(token("a1")), { title: "x", brief: "y" }), /hold an active duty/);
await rejects(() => addAgentNote(ctx(), { project_id: "team", title: "x", brief: "y" }), /agent/);
await rejects(() => addAgentNote(ctx({ ...token("a1"), scope: "submit" }), { title: "x", brief: "y" }), /working on this board/);
const noticing = await file("Fix the order total");
await turn(noticing.duty_id, "a1", "engineer");
await claimDuty(ctx(token("b1")), { duty_id: noticing.duty_id, agent_id: "b1" });
await rejects(() => addAgentNote(ctx(token("b1")), { title: "No brief" }), /brief/);
const queuedBefore = (await pollDuties(ctx(token("zz")), {})).runnable_duties.length;
const left = await addAgentNote(ctx(token("b1")), { title: "invoices.js has no tests", brief: "`src/invoices.js` has no tests at all; found while fixing the order total." });
assert.equal(left.status, "note");
const noteRow = table("duties").get(left.duty_id);
assert.deepEqual([noteRow.kind, noteRow.status, noteRow.origin, noteRow.from_duty_id, noteRow.from_role, noteRow.created_by_name, noteRow.role], ["note", "note", "agent", noticing.duty_id, "engineer", "Engineer", null]);
assert.equal((await pollDuties(ctx(token("zz")), {})).runnable_duties.length, queuedBefore, "a note runs nothing: nobody reads it first, nobody is woken");
const leftNote = (await listNotes(ctx(), { project_id: "team" })).notes.find((n) => n.id === left.duty_id);
assert.deepEqual(leftNote.from, { duty_id: noticing.duty_id, role: "engineer", name: "Engineer" }, "the Notes board says who left it, and from what");
assert.equal((await getDuty(ctx(), { duty_id: left.duty_id })).duty.from.duty_id, noticing.duty_id);
assert.equal((await addAgentNote(ctx(token("b1")), { title: "invoices.js has no tests", brief: "again" })).existing, true, "the same note twice is one note");
for (let i = 2; i <= MAX_NOTES_PER_DUTY; i++) await addAgentNote(ctx(token("b1")), { title: `Thing ${i}`, brief: "b" });
await rejects(() => addAgentNote(ctx(token("b1")), { title: "One too many", brief: "b" }), /already left 5 notes/);
await handoffDuty(ctx(token("b1")), { duty_id: noticing.duty_id, to_role: "qa", note: "Fixed; left notes on what else I saw." });
await claimDuty(ctx(token("q1")), { duty_id: noticing.duty_id, agent_id: "q1" });
await rejects(() => addAgentNote(ctx(token("q1")), { title: "Another", brief: "b" }), /already left 5 notes/, "the limit is the duty's, whichever role is working it");
await completeDuty(ctx(token("q1")), { duty_id: noticing.duty_id, outcome_summary: "Fixed." });
await store.putOne("duties", "review2", { project_id: "team", owner_uid: "owner", kind: "note_review", status: "active", assigned_agent_id: "r2", title: "Review", brief: "b" });
await store.putOne("agents", "team:r2", { project_id: "team", agent_id: "r2", active_duty_id: "review2" });
await rejects(() => addAgentNote(ctx(token("r2")), { title: "From a review", brief: "b" }), /does not add notes/);
await store.delete("duties", ["review2"]);
const noteTools = Object.fromEntries((await mcp("tools/list", {})).tools.map((t) => [t.name, t]));
assert.ok(noteTools.note_add && /costs nothing until a person/.test(noteTools.note_add.description));
assert.ok(!(await mcp("tools/list", {}, { ...token(), scope: "submit" })).tools.some((t) => t.name === "note_add"), "not a submit token's");
assert.match((await mcp("initialize", {})).instructions, /does not block it .*note_add/s);
for (const r of rolesFrom(PRESETS.software.roles).filter((r) => r.reviews)) assert.match(r.charter, /note_add/, "a reviewer leaves what need not block the work as a note");
await clearTeam();

// --- every new route is in the table the cross-tenant suite is derived from ----------------------
for (const path of ["/projects/rosters", "/live/boards", "/duty/handoff", "/board/roster", "/board/roster/set", "/board/roster/accept", "/board/roster/submit", "/board/roster/draft", "/board/memory", "/board/memory/write", "/board/memory/history", "/board/roster/retro", "/duty/usage", "/note/add"]) {
  assert.ok(ROUTE_PATHS.includes(path), path);
}

// --- deleting the board takes the team and its memory with it -----------------------------------
await writeMemory(ctx(), { project_id: "team", body: "kept until the board goes" });
const gone = await deleteProject({ ...ctx(), env: {} }, { project_id: "team", confirm: "team" }).catch((err) => err);
if (!(gone instanceof Error)) {
  assert.equal(table("rosters").has("team"), false);
  assert.equal(table("memories").has("team"), false);
  for (const kept of ["memory_history", "duty_usage"]) assert.equal([...table(kept).values()].filter((e) => e.project_id === "team").length, 0, kept);
  assert.equal([...table("role_events").values()].filter((e) => e.project_id === "team").length, 0);
}

console.log("Team: presets, validation, levels, intake, handoff, the review gate, send-backs, plan approval, drafting and accepting, memory and its history, machine levels, sealed secrets, the tools, the handoff and time limits, risk, schedule routes, the whole-split check and retros all passed.");
