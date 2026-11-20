// A board's team, as the console reads it: the words for a role's level and what it may do, which
// role a duty is with, the team's record summed from its events, and the picture the office draws.
//
// Pure functions over rows the pages already have, so the same logic is checked from a script
// (scripts/team-ui-check.mjs) without a browser.

export const LEVELS = [
  { key: "light", label: "Light", hint: "routing and simple work" },
  { key: "standard", label: "Standard", hint: "most building" },
  { key: "senior", label: "Senior", hint: "risky work and reviewing" },
  { key: "principal", label: "Principal", hint: "design and the hardest problems" },
];
export const levelLabel = (key) => (LEVELS.find((l) => l.key === key) || { label: key || "—" }).label;

/** What a role is allowed and expected to do, in the words a person reads on its card. */
export function roleTraits(role) {
  const out = [];
  if (role.intake) out.push({ key: "intake", label: "Reads new duties first", hint: "Every new duty goes here to be routed." });
  if (role.plans) out.push({ key: "plans", label: "Plans", hint: "Its handoff is a plan for another role to carry out." });
  if (role.reviewed) out.push({ key: "reviewed", label: "Work is reviewed", hint: "It cannot land or complete a duty itself: a reviewer does." });
  if (role.reviews) out.push({ key: "reviews", label: "Reviews and lands", hint: "Verifies other roles' work, lands it and completes the duty, or sends it back." });
  return out;
}

/** A role's name when all that is known is its id: `senior-engineer` → `Senior Engineer`. */
export const roleNameFromId = (id) =>
  String(id || "")
    .split("-")
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

/** `{ id → name }` for a roster's roles. */
export const roleNames = (roles) => Object.fromEntries((roles || []).map((r) => [r.id, r.name]));

/**
 * The role a duty is with, or "" when it has none. Only work has one, and only on a board with a
 * team; a duty filed before the team existed is with whoever reads new duties first, which is who
 * will take it.
 */
export function dutyRoleId(duty, pointer) {
  if (!pointer || !pointer.intake || (duty.kind || "work") !== "work") return "";
  return duty.role || pointer.intake;
}

// --- the team's record ---------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
export const RECORD_DAYS = 30;
const COUNTS = ["stints", "ms", "handoffs", "done", "failed", "passed", "first_pass", "sent_back", "reopened"];

/** One aggregate over `role_events`: everything each role did on each board in the last `days`. */
export function roleRecordRequest(now = Date.now(), days = RECORD_DAYS, projectId = "") {
  return {
    where: [
      ...(projectId ? [{ field: "project_id", op: "=", value: projectId }] : []),
      { field: "hour", op: ">=", value: Math.floor((now - days * 24 * HOUR_MS) / HOUR_MS) },
    ],
    group: ["project_id", "role", "role_name"],
    metrics: COUNTS.map((field) => ({ fn: "sum", field, as: field })),
    limit: 500,
  };
}

/** Fewer judged duties than this and a rate is noise, not a record. */
export const MIN_JUDGED = 3;

/**
 * One line per role per board, with the one number that says how good its work was.
 *
 * Which number depends on what the role is for. A builder is judged by review: of the duties of
 * its that got through, how many did so at the first attempt and were not reopened by a person
 * afterwards. A reviewer is judged by what it let through: of the duties it finished, how many
 * stayed finished. A role that only routes or plans has no such verdict, and is shown by how much
 * it handled — counting work would only reward small duties.
 */
export function roleRecord(groups) {
  const merged = new Map();
  for (const g of groups || []) {
    const { project_id: projectId, role, role_name: name } = g.group || {};
    if (!projectId || !role) continue;
    const key = `${projectId}:${role}`;
    const row = merged.get(key) || { project_id: projectId, role, name: name || roleNameFromId(role), ...Object.fromEntries(COUNTS.map((c) => [c, 0])) };
    for (const c of COUNTS) row[c] += Number(g.metrics && g.metrics[c]) || 0;
    if (name) row.name = name;
    merged.set(key, row);
  }
  return [...merged.values()].map((r) => {
    let judged = 0;
    let good = 0;
    let verdict = "";
    if (r.passed > 0) {
      judged = r.passed;
      good = Math.max(0, r.first_pass - r.reopened);
      verdict = "passed review first time and stayed done";
    } else if (r.done > 0) {
      judged = r.done;
      good = Math.max(0, r.done - r.reopened);
      verdict = "finished and stayed done";
    }
    return {
      ...r,
      judged,
      good,
      verdict,
      rate: judged ? good / judged : null,
      ranked: judged >= MIN_JUDGED,
      avg_ms: r.stints ? Math.round(r.ms / r.stints) : 0,
    };
  });
}

/** The best first: ranked roles by rate then by how many duties that rate rests on, then the rest by volume. */
export function topRoles(record, limit = 6) {
  return [...record]
    .filter((r) => r.stints > 0 || r.judged > 0)
    .sort((a, b) => Number(b.ranked) - Number(a.ranked) || (b.rate ?? -1) - (a.rate ?? -1) || b.judged - a.judged || b.stints - a.stints)
    .slice(0, limit);
}

export const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);

/** "about 12m", "about 1h 5m", "under a minute" — how long a role usually has a duty. */
export function duration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `about ${minutes}m`;
  return `about ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// --- the office ----------------------------------------------------------------------------

/** Duties one cubicle's tooltip names from its tray before it says "and N more". */
export const TRAY_SHOWN = 3;
/** People drawn at one cubicle: a role can work several duties at once. */
export const SEATS = 2;

/** A small, stable number from a string: the same input always gives the same answer. */
export function hashOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * How long people stay in one corner of the breakroom before drifting to another. Long enough not to
 * fidget, short enough that the office lives.
 */
export const WANDER_MS = 4 * 60 * 1000;

const HANGOUTS = ["chat", "chat", "game", "coffee", "couch"];

/**
 * The breakroom's people in little groups, each doing something — chatting, playing at the arcade,
 * by the coffee, on the couch — so it reads as a room and not a queue. Stable for a stretch.
 */
export function hangoutGroups(people, stretch) {
  const groups = [];
  for (let i = 0; i < people.length; ) {
    const size = 1 + (hashOf(`${people[i].key}|size|${stretch}`) % 3);
    const members = people.slice(i, i + size);
    i += size;
    let activity = HANGOUTS[hashOf(`${members[0].key}|do|${stretch}`) % HANGOUTS.length];
    if (activity === "chat" && members.length < 2) activity = "coffee";
    groups.push({ key: members.map((p) => p.key).join("|"), people: members, activity, lift: hashOf(`${members[0].key}|y`) % 16 });
  }
  return groups;
}

const ROOM_COLORS = ["#4f7fd9", "#3fa37a", "#d0783a", "#9467cf", "#cf4f7f", "#3a9fb0", "#b39337", "#6a8f3a"];

/** A board's colour in the office — its room's trim, and the tag its people wear in the breakroom. */
export function boardColor(projectId) {
  let h = 2166136261;
  for (const ch of String(projectId || "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return ROOM_COLORS[h % ROOM_COLORS.length];
}

/** The one cubicle of a board with no team: whoever claims a duty works it start to finish. */
const SOLO = { id: "", name: "Agent", summary: "Whoever claims a duty works it start to finish.", level: "" };

/**
 * The office building, from rows the pages already have: a room per board with a cubicle per role,
 * and one breakroom every board shares.
 *
 * `boards` is `[{ project_id, name, roster }]`, where `roster` is `{ intake, roles }` or null for a
 * board with no team. `duties` are the unfinished duties of all of them. A role working a duty sits
 * at its cubicle; one with nothing in hand is in the breakroom, with whatever is waiting for it
 * stacked in its tray. A role that asked a person something stays at its desk with the question
 * (`asking`) — that is the one thing on the floor waiting for whoever is looking.
 *
 * `next` is each board's next scheduled duty, `{ project_id → { at, title } }`. A board with one
 * coming keeps whoever will pick it up — the role that reads new duties first — in their seat, on
 * call for it (`onCall`), rather than on a break.
 */
export function buildingFloor({ boards, duties, activity = {}, next = {} }) {
  const byBoard = new Map();
  for (const d of duties || []) {
    if (d.kind === "note" || d.status === "note") continue;
    if (!byBoard.has(d.project_id)) byBoard.set(d.project_id, []);
    byBoard.get(d.project_id).push(d);
  }
  const queueOrder = (a, b) => (a.prio_rank ?? 1) - (b.prio_rank ?? 1) || (a.created_at || 0) - (b.created_at || 0);

  const rooms = (boards || []).map((b) => {
    const pointer = b.roster && b.roster.intake ? b.roster : null;
    const teamed = !!(pointer && pointer.roles && pointer.roles.length);
    const roles = teamed ? pointer.roles : [SOLO];
    const desks = roles.map((role) => ({ key: `${b.project_id}:${role.id}`, role, working: [], asking: [], tray: [], onCall: null }));
    const deskOf = new Map(desks.map((d) => [d.role.id, d]));
    const front = (teamed && deskOf.get(pointer.intake)) || desks[0];
    const room = { board: b, color: boardColor(b.project_id), teamed, desks, needsYou: [], blocked: 0 };
    for (const duty of byBoard.get(b.project_id) || []) {
      // The board's own housekeeping (rules, setup, drafting the team) is done at the front desk.
      const desk = teamed && (duty.kind || "work") === "work" ? deskOf.get(dutyRoleId(duty, pointer)) || front : front;
      if (duty.status === "active") desk.working.push({ duty, activity: activity[duty.key] || null });
      else if (duty.status === "queued") desk.tray.push(duty);
      else if (duty.status === "needs_decision") {
        room.needsYou.push(duty);
        desk.asking.push(duty);
      }
      else if (duty.status === "blocked") room.blocked++;
    }
    for (const d of desks) d.tray.sort(queueOrder);
    room.needsYou.sort((a, c) => (a.updated_at || 0) - (c.updated_at || 0));
    for (const d of desks) d.asking.sort((a, c) => (a.updated_at || 0) - (c.updated_at || 0));
    const scheduled = next[b.project_id];
    if (scheduled && scheduled.at && !atDesk(front)) front.onCall = { at: scheduled.at, title: scheduled.title || "" };
    return room;
  });

  const breakroom = rooms.flatMap((room) =>
    room.desks.filter((d) => !atDesk(d) && !d.onCall).map((d) => ({ key: d.key, role: d.role, board: room.board, color: room.color, waiting: d.tray.length })),
  );
  return { rooms, breakroom, working: rooms.reduce((n, r) => n + r.desks.filter((d) => d.working.length).length, 0) };
}

/** Whether a role is at its desk: working a duty, or waiting there for a person's answer. */
export const atDesk = (desk) => desk.working.length > 0 || desk.asking.length > 0;

/**
 * What changed between two floors that is worth showing as movement:
 *
 *   walks     a role that got up from the breakroom to its desk, or went back;
 *   handoffs  a duty that moved from one role's desk to another's, and whether it was sent back;
 *   left      a duty that was on a desk and is no longer on the floor at all — finished, usually.
 */
export function floorMoves(before, after) {
  if (!before || !after) return { walks: [], handoffs: [], left: [] };
  const present = (floor) => new Set(floor.rooms.flatMap((r) => r.desks.filter((d) => atDesk(d) || d.onCall).map((d) => d.key)));
  const deskOfDuty = (floor) => {
    const out = new Map();
    for (const r of floor.rooms) {
      for (const d of r.desks) for (const x of [...d.working.map((w) => w.duty), ...d.asking, ...d.tray]) out.set(x.key, { desk: d.key, duty: x });
    }
    return out;
  };
  const [was, now] = [present(before), present(after)];
  const keys = new Set(after.rooms.flatMap((r) => r.desks.map((d) => d.key)));
  const walks = [...keys].filter((k) => was.has(k) !== now.has(k)).map((key) => ({ key, to: now.has(key) ? "desk" : "break" }));
  const [from, to] = [deskOfDuty(before), deskOfDuty(after)];
  const handoffs = [];
  const left = [];
  for (const [id, at] of to) {
    const old = from.get(id);
    if (old && old.desk !== at.desk) handoffs.push({ duty: id, title: at.duty.title, from: old.desk, to: at.desk, sent_back: !!(at.duty.handoff && at.duty.handoff.sent_back) });
  }
  for (const [id, old] of from) if (!to.has(id)) left.push({ duty: id, title: old.duty.title, desk: old.desk });
  return { walks, handoffs, left };
}

/**
 * What just happened, newest first, as lines a person can read: from the handoffs duties carry and
 * the handoffs seen live while the page is open.
 */
export function officeFeed(duties, names, limit = 8) {
  const name = (id) => (names && names[id]) || roleNameFromId(id) || "someone";
  return (duties || [])
    .filter((d) => d.handoff && d.handoff.at)
    .sort((a, b) => b.handoff.at - a.handoff.at)
    .slice(0, limit)
    .map((d) => ({
      key: `${d.key}:${d.handoff.at}`,
      duty_id: d.key,
      title: d.title,
      at: d.handoff.at,
      from: d.handoff.from,
      to: d.handoff.to,
      sent_back: !!d.handoff.sent_back,
      text: d.handoff.sent_back
        ? `${name(d.handoff.from)} sent it back to ${name(d.handoff.to)}`
        : `${d.handoff.from_name || name(d.handoff.from)} handed it to ${name(d.handoff.to)}`,
    }));
}

/**
 * A character's colours, from its role's id — so the same role looks the same on every visit and two
 * roles on a board rarely look alike. Mid-tones, so they hold on a light background and a dark one.
 */
const HAIR = ["#3b2a20", "#6b4226", "#c08a3e", "#1f2430", "#8a8f98", "#7a2e2e"];
const SKIN = ["#f1c9a5", "#e0ac84", "#c68a5e", "#8d5a3b", "#f6dcc4"];
const SHIRT = ["#3b6fd8", "#2f9e77", "#c0562b", "#8a55c7", "#c93f6b", "#3a97a8", "#a8872f"];

export function characterLook(seed) {
  let h = 2166136261;
  for (const ch of String(seed || "agent")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return { hair: HAIR[h % HAIR.length], skin: SKIN[(h >>> 4) % SKIN.length], shirt: SHIRT[(h >>> 9) % SHIRT.length] };
}
