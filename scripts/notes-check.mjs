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
assert.equal(table("projects").get("board").notes_review_duty_id, review.duty_id);
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

// A board review combines sources, preserves history, and cannot pull in other notes.
const { listNotes, moveNote, deleteDuty } = await import('../functions/src/duties.js');
const multi = testStore();
const mc = caller => ({ ...ctx(caller), store: multi.store });
await multi.store.putOne('projects', 'board', { owner_uid: 'owner', name: 'Sticky board', profile: { description: 'Keep this profile' } });
await multi.store.putOne('memberships', 'board:member', { uid: 'member', project_id: 'board' });
const sourceIDs = [];
for (const title of ['Export controls', 'CSV format', 'Unrelated idea']) {
  sourceIDs.push((await createNote(mc(member), { project_id: 'board', title, brief: title })).duty_id);
}
await moveNote(mc(member), { note_id: sourceIDs[0], x: 404, y: 218 });
assert.deepEqual((await listNotes(mc(worker), {})).notes[0].note_position, { x: 404, y: 218 });
for (const caller of [worker, { kind:'human', uid:'stranger' }]) {
  await assert.rejects(() => moveNote(mc(caller), { note_id:sourceIDs[0], x:0, y:0 }));
}
for (const coords of [{x:-1,y:0},{x:10001,y:0},{x:1.5,y:0},{x:0,y:50001},{x:0}]) {
  await assert.rejects(() => moveNote(mc(human), { note_id:sourceIDs[0], ...coords }));
}
const mr = await processNote(mc(member), { project_id: 'board' });
assert.deepEqual(new Set(multi.table('duties').get(mr.duty_id).source_note_ids),new Set(sourceIDs));
assert.equal((await listNotes(mc(worker), {})).review.id,mr.duty_id);
assert.equal((await processNote(mc(human), { note_id: sourceIDs[1] })).duty_id,mr.duty_id);
await claimDuty(mc(worker), { duty_id:mr.duty_id });
const late = await createNote(mc(human), { project_id:'board', title:'Added later', brief:'Next review only' });
for (const ids of [undefined,[],[late.duty_id],['foreign-note']]) {
  await assert.rejects(() => suggestDuty(mc(worker), { title:'Invalid source', brief:'Do not file', ...(ids ? {source_note_ids:ids}: {}) }));
}
await assert.rejects(() => enqueueDuty(mc(worker), { title:'No sources', brief:'Cannot bypass with enqueue' }));
const proposal = {title:'Combined export',brief:'Use both format and controls.',external_ref:'combined',source_note_ids:sourceIDs.slice(0,2)};
const combined = await suggestDuty(mc(worker), proposal);
assert.equal((await suggestDuty(mc(worker),proposal)).duty_id,combined.duty_id);
assert.equal(multi.table('note_sources').size,1);
for (const id of sourceIDs.slice(0,2)) assert.equal((await getDuty(mc(worker),{duty_id:id})).suggestions[0].id,combined.duty_id);
assert.equal((await getDuty(mc(worker),{duty_id:sourceIDs[2]})).suggestions.length,0);
assert.deepEqual((await getDuty(mc(worker),{duty_id:combined.duty_id})).duty.source_note_ids,sourceIDs.slice(0,2));
await assert.rejects(() => claimDuty(mc(worker),{duty_id:combined.duty_id}));
// Both the old primary-source index and secondary-source links must paginate without loss.
await suggestDuty(mc(worker), {title:'Primary for second note',brief:'A separate idea',source_note_ids:[sourceIDs[1]]});
for (let i=0;i<29;i++) await suggestDuty(mc(worker), {...proposal,title:`Combined ${i}`,external_ref:`combined-${i}`});
const seen = new Set(); let cursor;
do {
  const page = await getDuty(mc(worker),{duty_id:sourceIDs[1],suggestions_cursor:cursor});
  for (const d of page.suggestions) { assert.ok(!seen.has(d.id)); seen.add(d.id); }
  cursor=page.suggestions_cursor;
} while(cursor);
assert.equal(seen.size,31);
await completeDuty(mc(worker),{duty_id:mr.duty_id,outcome_summary:'Reviewed all three notes together.'});
await resolveDuty(mc(member),{duty_id:combined.duty_id,approve:true,resolution_text:'Approved'});
await clearNoteSuggestions(mc(member),{project_id:'board'});
assert.equal(multi.table('projects').get('board').profile.description,'Keep this profile');
const again = await processNote(mc(member),{project_id:'board'});
assert.notEqual(again.duty_id,mr.duty_id);
assert.ok(multi.table('duties').get(again.duty_id).source_note_ids.includes(late.duty_id));
let approvedLinked = false; cursor = undefined;
do { const page = await getDuty(mc(worker),{duty_id:sourceIDs[1],suggestions_cursor:cursor}); approvedLinked ||= page.suggestions.some(d=>d.id===combined.duty_id && d.status==='queued'); cursor=page.suggestions_cursor; } while(cursor);
assert.ok(approvedLinked);
await deleteDuty(mc(human),{duty_id:combined.duty_id});
assert.ok(![...multi.table('note_sources').values()].some(r=>r.duty_id===combined.duty_id));
await deleteDuty(mc(human),{duty_id:sourceIDs[1]});
assert.equal(multi.table('note_sources').size,0);
// Capture every page when the notes board grows beyond 100 cards.
await cancelDuty(mc(human),{duty_id:again.duty_id,reason:'Start a large review'});
await clearNoteSuggestions(mc(human),{project_id:'board'});
for(let i=0;i<102;i++) await multi.store.putOne('duties',`note-large-${i}`,{project_id:'board',owner_uid:'owner',kind:'note',status:'note',title:`Note ${i}`,brief:'Context',created_at:1000+i});
const large = await processNote(mc(human),{project_id:'board'});
assert.equal(multi.table('duties').get(large.duty_id).source_note_ids.length,105);
console.log('Sticky notes passed: shared positions, human-only edits, all-note reviews across pages, multi-source links, provenance validation, pagination, approvals, retry history, and deletion cleanup.');

// An already-running review from the old single-note flow still finishes normally.
const legacy = testStore();
const lc = caller => ({ ...ctx(caller), store: legacy.store });
await legacy.store.putOne('projects','board',{owner_uid:'owner',name:'Existing board'});
await legacy.store.putOne('duties','legacy-note',{project_id:'board',owner_uid:'owner',kind:'note',status:'note',title:'Old note',brief:'Context',review_duty_id:'legacy-review',created_at:1});
await legacy.store.putOne('duties','legacy-review',{project_id:'board',owner_uid:'owner',kind:'note_review',status:'queued',title:'Old review',brief:'Review the note',source_note_id:'legacy-note',created_at:2});
await assert.rejects(()=>processNote(lc(human),{project_id:'board'}));
await assert.rejects(()=>clearNoteSuggestions(lc(human),{note_id:'legacy-note'}));
assert.equal(legacy.table('projects').get('board').name,'Existing board');
await claimDuty(lc(worker),{duty_id:'legacy-review'});
const oldProposal=await suggestDuty(lc(worker),{title:'Old proposal',brief:'Still needs approval'});
assert.equal((await getDuty(lc(worker),{duty_id:'legacy-note'})).suggestions[0].id,oldProposal.duty_id);
await completeDuty(lc(worker),{duty_id:'legacy-review',outcome_summary:'Suggested work'});
const upgraded=await processNote(lc(human),{project_id:'board'});
assert.deepEqual((await getDuty(lc(worker),{duty_id:upgraded.duty_id})).duty.source_note_ids,['legacy-note']);
console.log('Legacy notes passed: in-flight single-note reviews remain usable and old provenance remains linked.');
