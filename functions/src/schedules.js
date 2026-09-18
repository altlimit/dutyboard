// Recurring duties: a schedule files the same duty again on a clock.
//
// The shape of it:
//
//   a schedule row   holds what the duty will say (title, brief, priority), when it repeats (a
//                    five-field cron expression, read in the schedule's own timezone), and one
//                    number the tick actually queries on — `next_due_at`, in UTC milliseconds.
//   the tick         runs from the function's own cron (`x-ae-trigger: cron`), and from a
//                    machine's poll as a fallback, so a deployment whose cron was never set still
//                    files its duties. It takes the due rows, files one duty each, and moves
//                    `next_due_at` on.
//   the mutex        the duty a tick files carries `fire_key`, `<schedule>@<due>`, under a unique
//                    index on the DUTIES collection — on the duty rather than on the schedule
//                    because two racing ticks write the same schedule row, where an upsert
//                    collides with nothing, and two DIFFERENT duty rows, where the second is
//                    refused. The duty and the schedule's advance are one transaction, so the
//                    loser of a race writes neither.
//
// WHY THE TIMEZONE IS A NUMBER AND NOT A ZONE. The cron is written in local time — "9am every
// Monday" is what a person means — but this function cannot convert zones. The local emulator runs
// goja, which has no `Intl` at all, and a schedule that behaves differently on a developer's
// machine than on the hosted one is worse than no emulator. So the row carries `offset_min`, the
// zone's offset from UTC at the moment it was last worked out, and all the arithmetic here is
// plain UTC. Whoever has a real timezone database keeps that number honest: the daemon on each
// poll (Go carries tzdata) and the console while it is open (a browser has Intl). Both correct it
// through /schedules/sync. Until one of them does, a clock change makes a schedule an hour early
// or late, once — which is why the console shows when the offset was last confirmed.

import { badRequest, forbidden, notFound, str, oneOf, intIn, clip } from "./http.js";
import { scheduleId } from "./ids.js";
import { putOp } from "./store.js";
import { requireHuman, resolveProject } from "./identity.js";
import { PRIORITIES, RANK, UNFINISHED, MAX_OPEN_DUTIES, seedDuty, stripMeta } from "./duties.js";
import { notifyNeedsYou } from "./notify.js";

/**
 * Bounds, in the spirit of the ones in duties.js: they exist to protect the bill from software
 * that is running unattended, and they sit where a person has plainly lost track of the board.
 */
const MAX_SCHEDULES = 10;
/** Two runs closer together than this are a loop, not a schedule. Fifteen minutes is far below
 *  anything worth putting on a board (the shortest real one is hourly) and far above the tick. */
const MIN_INTERVAL_MS = 15 * 60 * 1000;
/** How many due schedules one tick files. A tick that finds more comes back a minute later. */
const MAX_PER_TICK = 25;
/** How far back a schedule catches up. A board that was down for a week files today's duty, not
 *  last Tuesday's — a missed occurrence is missed, not queued. */
const CATCH_UP_MS = 60 * 60 * 1000;
/**
 * Skipped runs in a row before the board asks about it.
 *
 * A schedule whose duty never gets finished skips for ever, quietly: the counter climbs and the
 * only sign is a note on a duty nobody is reading. Three is one that could be a busy week and two
 * that could not.
 */
const SKIPS_BEFORE_ASKING = 3;
/** Offsets outside this are not a timezone; UTC-12 to UTC+14 is the real range. */
const MIN_OFFSET = -12 * 60;
const MAX_OFFSET = 14 * 60;

// --- cron -----------------------------------------------------------------

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of the week", min: 0, max: 6 },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** One cron field as the set of numbers it allows. Ranges, steps, lists and `*`, plus the usual
 *  three-letter names for months and weekdays; `7` is Sunday, as everywhere else cron is written. */
function parseField(text, spec, index) {
  const allowed = new Set();
  for (const part of String(text).split(",")) {
    const piece = part.trim().toLowerCase();
    if (!piece) throw badRequest(`the ${spec.name} field of the schedule is empty`);
    const [range, stepText = "1"] = piece.split("/");
    const step = Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw badRequest(`'${part}' is not a step the ${spec.name} field understands`);
    let from = spec.min;
    let to = spec.max;
    if (range !== "*") {
      const ends = range.split("-");
      if (ends.length > 2) throw badRequest(`'${part}' is not a range the ${spec.name} field understands`);
      from = named(ends[0], spec, index, part);
      to = ends.length === 2 ? named(ends[1], spec, index, part) : ends[0] === "*" ? spec.max : from;
      if (range.includes("-") === false && stepText !== "1") to = spec.max; // `5/15` means from 5 on
    }
    if (from > to) throw badRequest(`'${part}' counts backwards in the ${spec.name} field`);
    for (let n = from; n <= to; n += step) allowed.add(n === 7 && index === 4 ? 0 : n);
  }
  return allowed;
}

function named(text, spec, index, whole) {
  const word = String(text).trim().toLowerCase();
  let n = Number(word);
  if (!word) throw badRequest(`'${whole}' is not something the ${spec.name} field understands`);
  if (Number.isNaN(n)) {
    const table = index === 3 ? MONTHS : index === 4 ? DAYS : null;
    const found = table ? table.indexOf(word.slice(0, 3)) : -1;
    if (found < 0) throw badRequest(`'${whole}' is not something the ${spec.name} field understands`);
    n = index === 3 ? found + 1 : found;
  }
  if (n === 7 && index === 4) n = 0;
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
    throw badRequest(`'${whole}' is outside the ${spec.name} field's range (${spec.min}-${spec.max})`);
  }
  return n;
}

/** A cron expression as five sets, or a refusal a person can act on. */
export function parseCron(text) {
  const parts = String(text || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw badRequest(
      `a schedule is five fields — minute, hour, day of the month, month, day of the week — ` +
        `like '0 9 * * 1' for 9am every Monday. Got ${parts.length === 1 && !parts[0] ? "nothing" : `'${text}'`}.`,
    );
  }
  const sets = parts.map((p, i) => parseField(p, FIELDS[i], i));
  // Both day fields restricted means "either day matches", which is cron's oldest wart. It is
  // honoured (a schedule copied from a crontab must behave the same) and said plainly in the
  // console rather than silently.
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domRestricted: parts[2] !== "*", dowRestricted: parts[4] !== "*" };
}

/**
 * The first moment at or after `after` that the expression matches, in UTC ms.
 *
 * Local time is UTC shifted by `offsetMin`, so the walk is done in shifted milliseconds and
 * shifted back at the end — no zone arithmetic, and no calendar of its own: `Date`'s UTC getters
 * do the leap years and month lengths.
 */
export function nextRun(cron, afterMs, offsetMin = 0) {
  const shift = offsetMin * 60000;
  // Start on the next whole minute of local time: a schedule never fires twice in one minute.
  let t = Math.floor((afterMs + shift) / 60000) * 60000 + 60000;
  // Four years covers the worst honest expression (29 February on a Monday is rarer, and is the
  // one case a schedule can be written that never comes round; the caller refuses it as unmatched).
  const limit = t + 4 * 366 * 24 * 60 * 60000;
  while (t < limit) {
    const d = new Date(t);
    if (!cron.month.has(d.getUTCMonth() + 1)) {
      // Jump to the first minute of the next month rather than trying 44,640 of them.
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    if (!dayMatches(cron, d)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!cron.hour.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!cron.minute.has(d.getUTCMinutes())) {
      t += 60000;
      continue;
    }
    return t - shift;
  }
  return null;
}

/** Cron's day rule: with both day fields restricted, EITHER may match; otherwise both must. */
function dayMatches(cron, d) {
  const dom = cron.dom.has(d.getUTCDate());
  const dow = cron.dow.has(d.getUTCDay());
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

/** The next few runs, for a console that shows what it will do before it does it. */
export function nextRuns(cron, fromMs, offsetMin, count = 3) {
  const out = [];
  let at = fromMs;
  for (let i = 0; i < count; i++) {
    const next = nextRun(cron, at, offsetMin);
    if (next == null) break;
    out.push(next);
    at = next;
  }
  return out;
}

/** Refuses an expression that would file duties faster than anyone can work them, by looking at
 *  what it actually does rather than at how it is written. */
function checkInterval(cron, nowMs, offsetMin) {
  const runs = nextRuns(cron, nowMs, offsetMin, 4);
  if (!runs.length) {
    throw badRequest("that schedule never comes round — check the day of the month and the month fields");
  }
  for (let i = 1; i < runs.length; i++) {
    if (runs[i] - runs[i - 1] < MIN_INTERVAL_MS) {
      throw badRequest(
        `that schedule repeats every ${Math.round((runs[i] - runs[i - 1]) / 60000)} minutes, and the ` +
          `closest a recurring duty may repeat is ${MIN_INTERVAL_MS / 60000}. A board is worked by ` +
          `agents that take minutes to hours per duty; anything faster fills the board instead of ` +
          `getting work done.`,
      );
    }
  }
  return runs;
}

// --- rows -----------------------------------------------------------------

const offsetOf = (v, fallback = 0) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_OFFSET || n > MAX_OFFSET) {
    throw badRequest(`'${v}' is not a timezone offset in minutes (${MIN_OFFSET} to ${MAX_OFFSET})`);
  }
  return n;
};

/** A schedule as the console and an agent see it, with its next runs worked out. */
export function scheduleView(row, now = Date.now()) {
  let upcoming = [];
  try {
    upcoming = row.enabled ? nextRuns(parseCron(row.cron), now, row.offset_min || 0) : [];
  } catch {
    // A row whose expression no longer parses (hand-edited, or written by an older version) is
    // still shown — with no upcoming runs, which is exactly what it will do.
  }
  return {
    schedule_id: row.key,
    project_id: row.project_id,
    title: row.title,
    brief: row.brief,
    priority: row.priority,
    reserved_for: row.reserved_for || null,
    cron: row.cron,
    tz: row.tz,
    offset_min: row.offset_min || 0,
    offset_checked_at: row.offset_checked_at || null,
    enabled: !!row.enabled,
    // Why it is off, when the board turned it off itself rather than a person pausing it.
    disabled_reason: row.disabled_reason || null,
    skips_in_a_row: row.skips_in_a_row || 0,
    next_due_at: row.enabled ? row.next_due_at : null,
    upcoming,
    moved_at: row.moved_at || null,
    last_fired_at: row.last_fired_at || null,
    last_duty_id: row.last_duty_id || null,
    skipped: row.skipped || 0,
    runs: row.runs || 0,
    origin: row.origin,
    created_by_name: row.created_by_name || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * `POST /schedules/create` — a recurring duty.
 *
 * A person on the board may write one. So may an agent, but only while holding an active duty
 * here: a schedule is then something that came out of work actually being done, and the board
 * shows which agent asked for it.
 */
export async function createSchedule(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  if (ctx.caller.kind === "agent") await mustHoldSomething(ctx, project);

  const count = await ctx.store.countAtMost("schedules", [{ field: "project_id", op: "=", value: project.key }], MAX_SCHEDULES);
  if (count >= MAX_SCHEDULES) {
    throw badRequest(
      `this board already has ${MAX_SCHEDULES} recurring duties, which is the limit. Delete one ` +
        `you no longer want with /schedules/delete before adding another.`,
    );
  }

  const now = Date.now();
  const fields = scheduleFields(ctx, body, now);
  const id = scheduleId();
  const row = {
    project_id: project.key,
    owner_uid: project.owner_uid,
    ...fields.data,
    enabled: body.enabled === undefined ? true : !!body.enabled,
    next_due_at: fields.runs[0],
    last_occurrence: null,
    last_fired_at: null,
    last_duty_id: null,
    skipped: 0,
    runs: 0,
    origin: ctx.caller.kind === "agent" ? "agent" : "human",
    created_by: ctx.caller.kind === "human" ? ctx.caller.uid : null,
    created_by_name: ctx.caller.kind === "human" ? ctx.caller.name : ctx.defaultAgentId || null,
    created_at: now,
    updated_at: now,
  };
  await ctx.store.putOne("schedules", id, row);
  await ctx.publish(project.key, null, { t: "board", what: "schedules" });
  return { ok: true, schedule: scheduleView({ ...row, key: id }, now) };
}

/** `POST /schedules/update` — change one, or turn it off. */
export async function updateSchedule(ctx, body) {
  const { row, project } = await loadSchedule(ctx, body.schedule_id);
  if (ctx.caller.kind === "agent") await mustHoldSomething(ctx, project);

  const now = Date.now();
  const next = { ...strip(row) };
  const wanted = {
    title: has(body, "title") ? body.title : row.title,
    brief: has(body, "brief") ? body.brief : row.brief,
    priority: has(body, "priority") ? body.priority : row.priority,
    reserved_for: has(body, "reserved_for") ? body.reserved_for : row.reserved_for,
    cron: has(body, "cron") ? body.cron : row.cron,
    tz: has(body, "tz") ? body.tz : row.tz,
    offset_min: has(body, "offset_min") ? body.offset_min : row.offset_min,
  };
  const fields = scheduleFields(ctx, wanted, now);
  Object.assign(next, fields.data, { updated_at: now });
  if (has(body, "enabled")) next.enabled = !!body.enabled;
  // Moving the next run by hand: "not this Monday, tomorrow", or — with a time already gone —
  // "file it now", which the next tick does. A person's to set; an agent follows the clock.
  if (has(body, "next_due_at")) {
    requireHuman(ctx.caller);
    const when = Number(body.next_due_at);
    if (!Number.isFinite(when) || Math.abs(when - now) > 366 * 24 * 60 * 60000) {
      throw badRequest("next_due_at is a time in milliseconds, within a year of now");
    }
    next.next_due_at = Math.round(when);
    next.moved_at = now;
  }
  // Anything that moves the clock re-aims the schedule: a person who fixes a wrong hour means
  // the next run, not the one the old expression had already lined up.
  if (fields.data.cron !== row.cron || fields.data.offset_min !== (row.offset_min || 0) || (next.enabled && !row.enabled)) {
    next.next_due_at = fields.runs[0];
  }
  await ctx.store.putOne("schedules", row.key, next);
  await ctx.publish(project.key, null, { t: "board", what: "schedules" });
  return { ok: true, schedule: scheduleView({ ...next, key: row.key }, now) };
}

/** `POST /schedules/delete` — stop it for good. Duties it already filed stay where they are. */
export async function deleteSchedule(ctx, body) {
  const { row, project } = await loadSchedule(ctx, body.schedule_id);
  if (ctx.caller.kind === "agent") await mustHoldSomething(ctx, project);
  await ctx.store.delete("schedules", [row.key]);
  await ctx.publish(project.key, null, { t: "board", what: "schedules" });
  return { ok: true, schedule_id: row.key };
}

/** `POST /schedules/list` — every recurring duty on a board, soonest first. */
export async function listSchedules(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const { rows } = await ctx.store.query("schedules", {
    where: [{ field: "project_id", op: "=", value: project.key }],
    limit: MAX_SCHEDULES,
  });
  const now = Date.now();
  const views = rows.map((r) => scheduleView(r, now));
  views.sort((a, b) => (a.next_due_at || Infinity) - (b.next_due_at || Infinity));
  return { project_id: project.key, schedules: views, limit: MAX_SCHEDULES };
}

/**
 * `POST /schedules/history` — the duties one schedule has filed, newest first.
 *
 * A recurring duty is only worth trusting if you can see what it has actually been doing, and
 * `last_duty_id` alone answers that for one run out of however many.
 */
export async function scheduleHistory(ctx, body) {
  const { row } = await loadSchedule(ctx, body.schedule_id);
  // A page at a time, always. A schedule that has run every weekday for two years has five hundred
  // duties behind it, and "read them all" is not a request this answers however it is asked.
  const limit = intIn(body.limit, "limit", 1, 50, 10);
  const { rows, cursor } = await ctx.store.query("duties", {
    where: [{ field: "schedule_id", op: "=", value: row.key }],
    order: [{ field: "created_at", dir: "desc" }],
    limit,
    ...(body.cursor ? { cursor: str(body.cursor, "cursor", { max: 2000 }) } : {}),
  });
  return {
    schedule_id: row.key,
    duties: rows.map((d) => ({
      duty_id: d.key,
      title: d.title,
      status: d.status,
      created_at: d.created_at,
      outcome_summary: d.outcome_summary ? clip(d.outcome_summary, 400) : null,
    })),
    // Present only when there is another page; a caller that ignores it has read a bounded amount.
    next_cursor: rows.length === limit ? cursor || null : null,
  };
}

/**
 * `POST /schedules/sync` — a caller that HAS a timezone database tells this one what the offsets
 * really are, and gets back what still needs answering.
 *
 * This is the whole of the timezone story: the daemon (Go, with tzdata) and the console (a
 * browser, with Intl) each know what `America/Chicago` is worth right now; this function never
 * does. A caller sends `{ offsets: { "America/Chicago": -300 } }`, every schedule in that zone is
 * re-aimed, and the answer names the zones the caller did not cover so it can send those too.
 */
export async function syncScheduleZones(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const offsets = body && typeof body.offsets === "object" && body.offsets ? body.offsets : {};
  const { rows } = await ctx.store.query("schedules", {
    where: [{ field: "project_id", op: "=", value: project.key }],
    limit: MAX_SCHEDULES,
  });
  const now = Date.now();
  const ops = [];
  // What the board believes each zone is worth, so a caller with a real timezone database can
  // send corrections only when it disagrees — and can ask, by sending no offsets at all.
  const zones = new Map();
  for (const row of rows) {
    const zone = row.tz || "UTC";
    const believed = zones.get(zone);
    if (!believed || (row.offset_checked_at || 0) > (believed.checked_at || 0)) {
      zones.set(zone, { tz: zone, offset_min: row.offset_min || 0, checked_at: row.offset_checked_at || null });
    }
    if (!has(offsets, zone)) continue;
    const offset = offsetOf(offsets[zone]);
    const changed = offset !== (row.offset_min || 0);
    const next = { ...strip(row), offset_min: offset, offset_checked_at: now };
    if (changed && row.enabled) {
      // The clocks moved under it. Re-aim from now, so "9am" is 9am again on the next run and
      // the occurrence it was already lined up for is not fired twice.
      try {
        next.next_due_at = nextRun(parseCron(row.cron), now, offset);
      } catch {
        next.enabled = false;
      }
    }
    if (changed || !row.offset_checked_at) ops.push(putOp("schedules", row.key, next));
    zones.set(zone, { tz: zone, offset_min: offset, checked_at: now });
  }
  if (ops.length) await ctx.store.transaction(ops);
  return { ok: true, project_id: project.key, updated: ops.length, zones: [...zones.values()] };
}

/** The fields a create and an update both work out, so the two cannot drift apart. */
function scheduleFields(ctx, body, now) {
  const priority = oneOf(body.priority, "priority", PRIORITIES, "next");
  const offset = offsetOf(body.offset_min, 0);
  const cronText = str(body.cron, "cron", { required: true, max: 120 });
  const cron = parseCron(cronText);
  const runs = checkInterval(cron, now, offset);
  return {
    runs,
    data: {
      title: str(body.title, "title", { required: true, max: 200 }),
      brief: str(body.brief, "brief", { required: true, max: 4000 }),
      priority,
      prio_rank: RANK[priority],
      reserved_for: reservationFor(ctx, body),
      cron: cronText,
      tz: str(body.tz, "tz", { max: 64, fallback: "UTC" }) || "UTC",
      offset_min: offset,
      offset_checked_at: has(body, "offset_min") ? now : null,
    },
  };
}

/** Same rule as a duty's: a machine may reserve only for itself, a person for anyone. */
function reservationFor(ctx, body) {
  const wanted = str(body.reserved_for, "reserved_for", { max: 64, fallback: "" });
  if (!wanted) return null;
  if (ctx.caller.kind === "human") return wanted;
  if (ctx.caller.machineId) {
    if (wanted !== ctx.caller.agentPrefix) throw forbidden(`this machine can reserve work only for itself ('${ctx.caller.agentPrefix}')`);
    return wanted;
  }
  throw forbidden("a project token cannot reserve work — only a machine or a person can");
}

async function loadSchedule(ctx, id) {
  const key = str(id, "schedule_id", { required: true, max: 64 });
  const row = await ctx.store.get("schedules", key);
  if (!row) throw notFound(`schedule '${key}' not found`);
  const project = await resolveProject(ctx.caller, row.project_id, ctx.store);
  return { row, project };
}

/** An agent writes schedules only while it is working: no held duty, no schedule. */
async function mustHoldSomething(ctx, project) {
  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "project_id", op: "=", value: project.key },
      { field: "status", op: "=", value: "active" },
    ],
    limit: 25,
  });
  const prefix = ctx.caller.agentPrefix || "";
  const mine = rows.some((d) => {
    const holder = d.assigned_agent_id || "";
    if (prefix) return holder === prefix || holder.startsWith(prefix + "/");
    return !ctx.defaultAgentId || holder === ctx.defaultAgentId;
  });
  if (!mine) {
    throw forbidden(
      "an agent can set up a recurring duty only while it is working one: claim a duty first, so " +
        "the board shows what the schedule came out of.",
    );
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const strip = (row) => {
  const { key, _created, _updated, ...rest } = row;
  return rest;
};

// --- the tick -------------------------------------------------------------

/**
 * File the duties that are due, and move their schedules on.
 *
 * Called from the function's own cron and from a machine's poll. Both are safe to run at once and
 * safe to run often: a schedule is only fired by the transaction that also advances it, and that
 * transaction carries `fire_key` under a unique index, so the loser of a race writes nothing.
 *
 * Answers a small summary rather than throwing: a tick that cannot file one board's duty must
 * still file the rest, and nobody is waiting on the answer.
 */
export async function runDueSchedules(ctx, { now = Date.now(), projectKey = null, limit = MAX_PER_TICK } = {}) {
  // The mutex, asked for once per isolate: an install that predates recurring duties gains the
  // constraint on the first tick rather than on a step in a runbook nobody runs.
  await ctx.store.ensureUniqueIndex("duties", ["fire_key"]);
  const where = [
    { field: "enabled", op: "=", value: true },
    { field: "next_due_at", op: "<=", value: now },
  ];
  if (projectKey) where.unshift({ field: "project_id", op: "=", value: projectKey });
  let rows = [];
  try {
    ({ rows } = await ctx.store.query("schedules", { where, order: [{ field: "next_due_at", dir: "asc" }], limit }));
  } catch (err) {
    console.log("schedules: could not read what is due:", err && err.message);
    return { filed: 0, skipped: 0, checked: 0 };
  }
  let filed = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const outcome = await fireSchedule(ctx, row, now);
      if (outcome === "filed") filed++;
      if (outcome === "skipped") skipped++;
    } catch (err) {
      // One bad row — a board deleted under it, a cron nobody can parse — must not stop the rest.
      console.log(`schedules: ${row.key} did not fire:`, err && err.message);
    }
  }
  return { filed, skipped, checked: rows.length };
}

async function fireSchedule(ctx, row, now) {
  const due = Number(row.next_due_at) || 0;
  const project = await ctx.store.get("projects", row.project_id);
  if (!project) {
    // The board is gone; the schedule is litter.
    await ctx.store.delete("schedules", [row.key]);
    return "gone";
  }
  project.key = project.key || row.project_id;

  let cron;
  try {
    cron = parseCron(row.cron);
  } catch (err) {
    // Off, and on the record. A schedule that stops with no reason on screen is the same problem
    // as one that never stops: nobody can tell what happened by looking.
    await ctx.store.putOne("schedules", row.key, {
      ...strip(row),
      enabled: false,
      disabled_reason: `its repeat could not be read: ${clip(String((err && err.message) || "unreadable"), 300)}`,
      disabled_at: now,
      updated_at: now,
    });
    console.log(`schedules: ${row.key} turned off, its repeat is unreadable:`, err && err.message);
    return "off";
  }

  // Where this schedule goes next, worked out before anything is written so the advance lands in
  // the same transaction as the duty. A run missed by more than the catch-up window is skipped
  // outright: a board that was off for a week files today's duty, not last Tuesday's.
  const from = now - due > CATCH_UP_MS ? now : due;
  const nextDue = nextRun(cron, from, row.offset_min || 0);

  const open = await openDutyOf(ctx, row);
  if (open) {
    // The last one it filed is still going. Nothing new — and a note on the open duty, so the
    // person looking at it knows a run went by rather than wondering why it never came.
    const inARow = (row.skips_in_a_row || 0) + 1;
    // After a few in a row, the board stops taking it quietly. A schedule skipping for ever is
    // indistinguishable, from the outside, from one that never fired at all.
    const ask = inARow >= SKIPS_BEFORE_ASKING && (open.status === "queued" || open.status === "blocked");
    const question =
      `"${clip(row.title, 120)}" has skipped ${inARow} runs in a row, because this duty — the one it ` +
      `filed last — is still open. Finish it, delete it, or pause the schedule; until one of those, ` +
      `nothing new is filed.`;
    const ops = [
      putOp("schedules", row.key, {
        ...strip(row),
        next_due_at: nextDue,
        last_occurrence: fireKey(row.key, due),
        skipped: (row.skipped || 0) + 1,
        skips_in_a_row: inARow,
        updated_at: now,
      }),
      // A deterministic key, so two ticks racing over one skipped occurrence leave one note
      // rather than two — the same reasoning as the unique key on a filed duty.
      putOp("threads", `th_skip_${row.key}_${due}`, {
        duty_id: open.key,
        project_id: row.project_id,
        owner_uid: row.owner_uid,
        author_type: "agent",
        author_id: "DutyBoard",
        kind: ask ? "question" : "note",
        message: ask
          ? question
          : `A scheduled run of "${clip(row.title, 120)}" came round while this duty was still ` +
            `${open.status === "queued" ? "waiting" : open.status.replace("_", " ")}, so no new duty was filed. ` +
            `The next run is ${nextDue ? new Date(nextDue).toISOString() : "not scheduled"}.`,
        metadata: { schedule_id: row.key, skipped_at: due, skips_in_a_row: inARow },
        created_at: now,
      }),
    ];
    if (ask) {
      // Only a duty nobody is working is parked: interrupting a session that is mid-duty to say
      // "this duty is taking a while" would be the board making the problem it is reporting.
      ops.push(
        putOp("duties", open.key, {
          ...stripMeta(open),
          status: "needs_decision",
          last_question: question,
          last_resolution: null,
          holder: null,
          lane: null,
          updated_at: now,
        }),
      );
    }
    await ctx.store.transaction(ops);
    if (ask) {
      const project = { key: row.project_id, owner_uid: row.owner_uid };
      await ctx.publish(row.project_id, open.key, { t: "duty", id: open.key, status: "needs_decision" });
      await notifyNeedsYou(ctx, project, { ...open, status: "needs_decision" }, question);
    }
    return "skipped";
  }

  // The board's own ceiling applies to schedules too, unlike the setup and rules duties the
  // server files: those are bounded by what triggers them, and this one comes round forever.
  const openCount = await ctx.store.countAtMost(
    "duties",
    [
      { field: "project_id", op: "=", value: row.project_id },
      { field: "status", op: "in", value: UNFINISHED },
    ],
    MAX_OPEN_DUTIES,
  );
  if (openCount >= MAX_OPEN_DUTIES) {
    await ctx.store.putOne("schedules", row.key, {
      ...strip(row),
      next_due_at: nextDue,
      last_occurrence: fireKey(row.key, due),
      skipped: (row.skipped || 0) + 1,
      updated_at: now,
    });
    console.log(`schedules: ${row.key} skipped, board ${row.project_id} is at its unfinished-duty limit`);
    return "skipped";
  }

  const runs = (row.runs || 0) + 1;
  const { id, op } = seedDuty(
    { key: row.project_id, owner_uid: row.owner_uid },
    {
      title: row.title,
      brief: recurringBrief(row, due, runs),
      kind: "work",
      priority: row.priority || "next",
      reservedFor: row.reserved_for || null,
      now,
      // The mutex: one occurrence, one duty, whichever tick gets there first.
      fields: { fire_key: fireKey(row.key, due), schedule_id: row.key },
    },
  );
  await ctx.store.transaction([
    op,
    putOp("schedules", row.key, {
      ...strip(row),
      next_due_at: nextDue,
      last_occurrence: fireKey(row.key, due),
      last_fired_at: now,
      skips_in_a_row: 0,
      last_duty_id: id,
      runs,
      updated_at: now,
    }),
  ]);
  await ctx.publish(row.project_id, id, { t: "duty", id, status: "queued" });
  return "filed";
}

/** `<schedule>@<due>`, carried by the duty it files under a unique index: an occurrence can only
 *  ever be written once, so a tick that loses a race writes nothing at all. */
const fireKey = (id, due) => `${id}@${due}`;

/** The duty this schedule filed last, if it has not finished. */
async function openDutyOf(ctx, row) {
  if (!row.last_duty_id) return null;
  const duty = await ctx.store.get("duties", row.last_duty_id);
  if (!duty) return null;
  return UNFINISHED.includes(duty.status) ? duty : null;
}

/**
 * The brief a scheduled duty carries: what was asked for, plus the fact that it recurs and how
 * the last one went. A weekly writing duty that cannot see what it wrote last week writes the
 * same thing again.
 */
function recurringBrief(row, due, runs) {
  const when = new Date(due).toISOString().replace(".000Z", "Z");
  let tail =
    `\n\n---\nThis is a recurring duty (run ${runs}), filed by the schedule "${clip(row.title, 120)}" ` +
    `for ${when}${row.tz && row.tz !== "UTC" ? ` (${row.tz})` : ""}.`;
  if (row.last_outcome) {
    tail += ` The last one finished with:\n\n> ${clip(String(row.last_outcome).replace(/\s+/g, " "), 600)}`;
    tail += `\n\nDo not repeat it — carry on from there.`;
  }
  return clip(row.brief + tail, 4000);
}

/**
 * What a finished duty leaves behind for the next run of its schedule.
 *
 * Called when a duty completes; a no-op unless a schedule filed it. Kept here rather than in
 * duties.js so everything a schedule knows about itself is written in one file.
 */
export async function noteScheduleOutcome(ctx, duty, outcome) {
  if (!duty || !outcome) return;
  try {
    const { rows } = await ctx.store.query("schedules", {
      where: [{ field: "last_duty_id", op: "=", value: duty.key }],
      limit: 1,
    });
    const row = rows[0];
    if (!row) return;
    await ctx.store.putOne("schedules", row.key, { ...strip(row), last_outcome: clip(String(outcome), 1200), updated_at: Date.now() });
  } catch (err) {
    // The schedule not learning what happened costs the next run some context. It is not worth
    // failing a completed duty over.
    console.log("schedules: could not record an outcome:", err && err.message);
  }
}

/** Every board's due schedules, for the function's own cron. */
export async function tickAllSchedules(ctx, now = Date.now()) {
  return runDueSchedules(ctx, { now });
}

export const SCHEDULE_LIMITS = { MAX_SCHEDULES, MIN_INTERVAL_MS, MAX_PER_TICK };
