#!/usr/bin/env node
// What the console says about a board's team, checked without a browser: which role a duty is with,
// how a role's record is judged and ranked, and what the office draws from a board's rows.
import assert from "node:assert/strict";
import {
  LEVELS, MIN_JUDGED, atDesk, boardColor, buildingFloor, characterLook, dutyRoleId, duration, floorMoves, levelLabel, officeFeed, percent, roleNameFromId, roleNames, roleRecord,
  roleRecordRequest, roleTraits, topRoles,
} from "../app/src/lib/team.js";
import { LEVELS as SERVER_LEVELS } from "../functions/src/roster.js";
import { PRESETS } from "../functions/src/charters.js";

// The console and the board must mean the same levels, in the same order.
assert.deepEqual(LEVELS.map((l) => l.key), SERVER_LEVELS);
assert.equal(levelLabel("principal"), "Principal");
assert.equal(levelLabel(""), "—");

// --- which role has a duty -----------------------------------------------------------------------
const pointer = { version: 1, intake: "duty-officer" };
assert.equal(dutyRoleId({ kind: "work", role: "qa" }, pointer), "qa");
assert.equal(dutyRoleId({ role: null }, pointer), "duty-officer", "filed before the team existed: with whoever reads duties first");
assert.equal(dutyRoleId({ kind: "rules", role: "qa" }, pointer), "", "the board's housekeeping has no role");
assert.equal(dutyRoleId({ kind: "work", role: "qa" }, null), "", "no team, no role");
assert.equal(dutyRoleId({ kind: "work", role: "qa" }, { version: 3, intake: null }), "", "a team that was turned off");
assert.equal(roleNameFromId("senior-engineer"), "Senior Engineer");
assert.equal(roleNameFromId("qa"), "QA");
assert.equal(roleNameFromId(""), "");
const software = PRESETS.software.roles;
assert.equal(roleNames(software).qa, "QA");
assert.deepEqual(roleTraits(software.find((r) => r.id === "duty-officer")).map((t) => t.key), ["intake"]);
assert.deepEqual(roleTraits(software.find((r) => r.id === "qa")).map((t) => t.key), ["reviews"]);
assert.deepEqual(roleTraits(software.find((r) => r.id === "engineer")).map((t) => t.key), ["reviewed"]);
assert.deepEqual(roleTraits(software.find((r) => r.id === "architect")).map((t) => t.key), ["plans"]);

// --- the record ----------------------------------------------------------------------------------
const request = roleRecordRequest(Date.UTC(2026, 10, 19), 30, "shop");
assert.deepEqual(request.group, ["project_id", "role", "role_name"]);
assert.equal(request.where[0].value, "shop");
assert.ok(request.metrics.some((m) => m.field === "first_pass" && m.fn === "sum"));
assert.equal(roleRecordRequest(Date.UTC(2026, 10, 19)).where.length, 1, "every board, when none is named");

const group = (project_id, role, role_name, metrics) => ({ group: { project_id, role, role_name }, metrics });
const record = roleRecord([
  group("shop", "engineer", "Engineer", { stints: 12, ms: 12 * 600000, handoffs: 12, passed: 10, first_pass: 8, sent_back: 3, reopened: 1 }),
  group("shop", "qa", "QA", { stints: 13, ms: 13 * 300000, done: 10, handoffs: 3, reopened: 1 }),
  group("shop", "duty-officer", "Duty Officer", { stints: 14, ms: 14 * 30000, handoffs: 12, done: 2 }),
  group("shop", "architect", "Architect", { stints: 2, ms: 2 * 900000, handoffs: 2 }),
  group("blog", "writer", "Writer", { stints: 2, ms: 120000, handoffs: 2, passed: 2, first_pass: 2 }),
  // The same role in two groups — its name changed part way through the month — is one line.
  group("blog", "editor", "Editor", { stints: 1, done: 1 }),
  group("blog", "editor", "Chief Editor", { stints: 1, done: 1 }),
  { group: {}, metrics: { stints: 9 } },
]);
const of = (project, role) => record.find((r) => r.project_id === project && r.role === role);
assert.equal(record.length, 6);
assert.deepEqual([of("shop", "engineer").judged, of("shop", "engineer").good, of("shop", "engineer").rate], [10, 7, 0.7], "a builder: first time through review, and not reopened");
assert.match(of("shop", "engineer").verdict, /passed review first time/);
assert.deepEqual([of("shop", "qa").judged, of("shop", "qa").good], [10, 9], "a reviewer: what it passed stayed done");
assert.equal(of("shop", "architect").rate, null, "a role that only plans has no verdict");
assert.equal(of("shop", "architect").ranked, false);
assert.equal(of("blog", "writer").ranked, false, `fewer than ${MIN_JUDGED} duties is not a record`);
assert.equal(of("blog", "editor").name, "Chief Editor");
assert.equal(of("blog", "editor").done, 2);
assert.equal(of("shop", "engineer").avg_ms, 600000);
const top = topRoles(record, 10);
assert.deepEqual(top.slice(0, 3).map((r) => r.role), ["qa", "engineer", "duty-officer"], "roles with enough duties to judge come first, best rate first; the rest follow");
assert.ok(top.findIndex((r) => r.role === "writer") > top.findIndex((r) => r.role === "engineer"), "a perfect rate on two duties ranks below a good one on ten");
assert.equal(topRoles(record, 2).length, 2);
assert.deepEqual(roleRecord(null), []);
assert.equal(percent(0.7), "70%");
assert.equal(percent(null), "—");
assert.equal(duration(20000), "under a minute");
assert.equal(duration(12 * 60000), "about 12m");
assert.equal(duration(65 * 60000), "about 1h 5m");

// --- the office ----------------------------------------------------------------------------------
const duties = [
  { key: "d1", title: "Routing", kind: "work", status: "queued", role: null, prio_rank: 1, created_at: 2 },
  { key: "d2", title: "Urgent", kind: "work", status: "queued", role: "duty-officer", prio_rank: 0, created_at: 5 },
  { key: "d3", title: "Building", kind: "work", status: "active", role: "engineer" },
  { key: "d4", title: "Sent back", kind: "work", status: "queued", role: "engineer", prio_rank: 0.5, created_at: 1, handoff: { from: "qa", to: "engineer", sent_back: true, at: 300 } },
  { key: "d5", title: "A question", kind: "work", status: "needs_decision", role: "architect", updated_at: 9 },
  { key: "d6", title: "Older question", kind: "work", status: "needs_decision", role: "qa", updated_at: 3 },
  { key: "d7", title: "Stuck", kind: "work", status: "blocked", role: "engineer" },
  { key: "d8", title: "Gone role", kind: "work", status: "queued", role: "astronaut", prio_rank: 1, created_at: 9 },
  { key: "d9", title: "Rules", kind: "rules", status: "active" },
  { key: "n1", title: "A note", kind: "note", status: "note" },
];
const done = [
  { key: "f1", title: "Earlier", status: "done", finished_at: 100, handoff: { from: "engineer", from_name: "Engineer", to: "qa", at: 90 } },
  { key: "f2", title: "Later", status: "done", finished_at: 200, handoff: { from: "engineer", from_name: "Engineer", to: "qa", at: 190 } },
];
const shop = { project_id: "shop", name: "Shop", roster: { intake: "duty-officer", roles: software } };
const blog = { project_id: "blog", name: "Blog", roster: null };
const inShop = duties.map((d) => ({ ...d, project_id: "shop" }));
const inBlog = [
  { key: "b1", project_id: "blog", title: "Post", kind: "work", status: "active" },
  { key: "b2", project_id: "blog", title: "Draft", kind: "work", status: "queued" },
];
const building = buildingFloor({ boards: [shop, blog], duties: [...inShop, ...inBlog], activity: { d3: { machine: "laptop", state: "working", detail: "running tests" } } });
const [shopRoom, blogRoom] = building.rooms;
const desk = (id) => shopRoom.desks.find((d) => d.role.id === id);
assert.equal(shopRoom.teamed, true);
assert.deepEqual(shopRoom.desks.map((d) => d.role.id), software.map((r) => r.id), "a cubicle per role, in the team's order");
assert.equal(desk("engineer").key, "shop:engineer");
assert.deepEqual(desk("duty-officer").tray.map((d) => d.key), ["d2", "d1", "d8"], "the tray in the order it will be taken; a duty with no role, or one the team no longer has, goes to the front desk");
assert.deepEqual(desk("engineer").working.map((w) => [w.duty.key, w.activity.detail]), [["d3", "running tests"]]);
assert.deepEqual(desk("engineer").tray.map((d) => d.key), ["d4"]);
assert.ok(desk("duty-officer").working.some((w) => w.duty.key === "d9"), "the board's own housekeeping is done at the front desk");
assert.deepEqual(shopRoom.needsYou.map((d) => d.key), ["d6", "d5"], "longest waiting first");
assert.equal(shopRoom.blocked, 1);
assert.ok(!shopRoom.desks.some((d) => [...d.tray, ...d.working.map((w) => w.duty)].some((x) => x.key === "n1")), "notes are not work");
assert.equal(blogRoom.teamed, false, "a board with no team");
assert.deepEqual(blogRoom.desks.map((d) => [d.key, d.role.name, d.working.length, d.tray.length]), [["blog:", "Agent", 1, 1]], "one agent's cubicle");
assert.equal(shopRoom.color, boardColor("shop"));
assert.match(boardColor("anything"), /^#[0-9a-f]{6}$/);
assert.deepEqual(desk("architect").asking.map((d) => d.key), ["d5"], "a role that asked you something stays at its desk with it");
assert.deepEqual(desk("qa").asking.map((d) => d.key), ["d6"]);
assert.ok(atDesk(desk("qa")) && atDesk(desk("engineer")) && !atDesk(desk("senior-engineer")));
assert.deepEqual(
  building.breakroom.map((p) => p.key),
  ["shop:senior-engineer"],
  "whoever has nothing in hand and nobody to wait on is in the one breakroom, whatever board they are from",
);
assert.equal(building.breakroom[0].board.name, "Shop");
assert.equal(building.working, 3);
const offTeam = buildingFloor({ boards: [{ ...shop, roster: { intake: null, roles: software } }], duties: [] });
assert.equal(offTeam.rooms[0].teamed, false, "a team that was turned off draws as none");
assert.deepEqual(buildingFloor({ boards: [], duties: inShop }), { rooms: [], breakroom: [], working: 0 });

// A board with a scheduled duty coming keeps whoever picks it up in their seat, on call.
const due = { at: Date.UTC(2026, 10, 20, 9), title: "Weekly sales report" };
const calm = buildingFloor({ boards: [shop, blog], duties: [], next: { shop: due, blog: due } });
assert.deepEqual(calm.rooms[0].desks.find((d) => d.role.id === "duty-officer").onCall, due, "the role that reads new duties first, which is who a scheduled duty goes to");
assert.equal(calm.rooms[0].desks.filter((d) => d.onCall).length, 1, "and nobody else");
assert.deepEqual(calm.rooms[1].desks[0].onCall, due, "on a board with no team, its one agent");
assert.ok(!calm.breakroom.some((p) => p.key === "shop:duty-officer" || p.key === "blog:"), "so they are not on a break");
assert.equal(calm.breakroom.length, 4);
const busyFront = buildingFloor({ boards: [shop], duties: [{ key: "x", project_id: "shop", kind: "work", status: "active", role: null }], next: { shop: due } });
assert.equal(busyFront.rooms[0].desks[0].onCall, null, "a desk already working is working, not on call");
assert.deepEqual(floorMoves(buildingFloor({ boards: [shop], duties: [] }), calm).walks.find((w) => w.key === "shop:duty-officer"), { key: "shop:duty-officer", to: "desk" }, "and walks back to it when a schedule appears");

// What moves between two readings of the floor.
const later = buildingFloor({
  boards: [shop, blog],
  duties: [
    ...inShop.filter((d) => d.key !== "d3").map((d) => (d.key === "d4" ? { ...d, status: "active" } : d)),
    { ...inShop.find((d) => d.key === "d3"), status: "queued", role: "qa" },
    ...inBlog,
  ],
});
const moves = floorMoves(building, later);
assert.deepEqual(moves.handoffs, [{ duty: "d3", title: "Building", from: "shop:engineer", to: "shop:qa", sent_back: false }], "the Engineer's duty crossed to QA");
assert.deepEqual(moves.left, [], "nothing left the floor");
assert.deepEqual(moves.walks, [], "the Engineer is still at its desk, now on the sent-back duty; nobody got up");
const quiet = buildingFloor({ boards: [shop, blog], duties: inShop.filter((d) => d.key !== "d3").concat(inBlog) });
assert.deepEqual(floorMoves(building, quiet).walks, [{ key: "shop:engineer", to: "break" }], "with nothing in hand it goes on a break");
assert.deepEqual(floorMoves(quiet, building).walks, [{ key: "shop:engineer", to: "desk" }], "and back to its desk when work arrives");
assert.deepEqual(floorMoves(building, quiet).left, [{ duty: "d3", title: "Building", desk: "shop:engineer" }], "a duty that left the floor, and whose desk it left");
const backAgain = floorMoves(later, buildingFloor({ boards: [shop, blog], duties: later.rooms[0].desks.flatMap((d) => [...d.working.map((w) => w.duty), ...d.asking, ...d.tray]).map((d) => (d.key === "d3" ? { ...d, role: "engineer", handoff: { from: "qa", to: "engineer", sent_back: true } } : d)) }));
assert.deepEqual(backAgain.handoffs.map((h) => [h.duty, h.from, h.to, h.sent_back]), [["d3", "shop:qa", "shop:engineer", true]], "and one QA sent back");
assert.deepEqual(floorMoves(null, building), { walks: [], handoffs: [], left: [] }, "nothing moves on the first reading");

const feed = officeFeed([...duties, ...done], roleNames(software), 2);
assert.deepEqual(feed.map((e) => e.duty_id), ["d4", "f2"], "newest first, and only as many as asked for");
assert.equal(feed[0].text, "QA sent it back to Engineer");
assert.equal(feed[0].sent_back, true);
assert.equal(feed[1].text, "Engineer handed it to QA");
assert.equal(officeFeed([{ key: "x", title: "T", handoff: { from: "desk", to: "lead", at: 1 } }], {})[0].text, "Desk handed it to Lead", "roles named from their ids when the team is not loaded");
assert.deepEqual(officeFeed(null, {}), []);

// --- characters ----------------------------------------------------------------------------------
assert.deepEqual(characterLook("qa:0"), characterLook("qa:0"), "the same role always looks the same");
assert.ok(new Set(software.map((r) => JSON.stringify(characterLook(`${r.id}:0`)))).size >= 4, "and the shipped team's members mostly look different");
for (const colour of Object.values(characterLook(""))) assert.match(colour, /^#[0-9a-f]{6}$/);

console.log("Team console: roles of duties, traits, the record and its ranking, the office floor and feed, and characters passed.");
