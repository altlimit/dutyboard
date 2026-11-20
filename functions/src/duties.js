// The duty state machine. Every transition in the spec lives here and nowhere else —
// the browser has read-only access to the datastore, so this is the only code that can
// move a duty between states.
//
//                  ┌───────────┐
//                  │  queued   │◄──────────────┐
//                  └─────┬─────┘               │ resolve  (a human answers)
//              claim     │                     │
//                        ▼                     │
//                  ┌───────────┐          ┌────┴─────────────┐
//        ┌─────────┤  active   ├─────────►│  needs_decision  │
//        │         └─────┬─────┘ checkpoint└──────────────────┘
//        │ enqueue       │ complete / fail
//        │ (immediate)   ▼
//        │         ┌────────────┐  reopen   back to `queued`, carrying the note that says
//        ▼         │ done/failed├─────────► why — the one way out of a terminal state, and
//   ┌─────────┐    └─────┬──────┘           only a human may take it
//   │ blocked │◄─────────┘  the child finishing puts its blocked parent back in the queue
//   └─────────┘
//
// Two invariants hold everything together:
//
//   1. An agent holds at most one `active` duty. The claim is guarded by the agent row
//      and confirmed by a read-back, so two agents racing for the same duty end with one
//      of them getting a 409 rather than both believing they own it.
//   2. A duty that stops being the agent's problem — parked for a decision, blocked
//      behind a child, finished — frees the agent in the SAME transaction. Otherwise an
//      agent that asked a question would sit idle waiting for an answer, which is the
//      exact failure this whole design exists to avoid.
//
// And, for boards run by `dutyboard` daemons, a third:
//
//   3. A board with `runner.parallel` set has that many LANES, and an active duty occupies
//      one. A lane is `<board>#<n>` under a unique index, written in the claim's own
//      transaction — the same trick as `holder` — so two claims racing for the last free lane
//      cannot both win. A `setup` or `rules` duty needs the board to itself: it is claimed only
//      when nothing else is active, and nothing else is claimed while it is. A `setup` duty holds
//      the board from the moment it is filed: what it records (the toolchain, the test command, how
//      a worktree is prepared) is what every other duty lands against, so duties in progress when a
//      machine is linked are blocked behind it, nothing else is claimed until it finishes, and then
//      they go back to the front of the queue.

import { dutyAgentOptions } from "./profile.js";
import { olderRelease } from "./version.js";
import { notifyNeedsYou } from "./notify.js";
import { badRequest, conflict, forbidden, notFound, str, oneOf, intIn, clip } from "./http.js";
import { dutyId, threadId, ulid } from "./ids.js";
import { rosterInForce, hasRoster, roleFor, roleContext, dutyOptions, intakeOf, settingsFrom, ROSTER_MIN_RELEASE, RISKS, RETRO_EVERY, SENT_BACKS_KEPT } from "./roster.js";
import { memoryOf } from "./memory.js";
import { putOp } from "./store.js";
import { resolveProject, projectOfDuty, requireHuman, requireAgent, authorOf, checkAgentId } from "./identity.js";
import { sweepAttachments, MAX_ATTACHMENTS } from "./attachments.js";
import { indexFinished, unindexDuties } from "./searching.js";
import { machinesPresent } from "./live.js";
import { noteScheduleOutcome, noteQuietRun, rememberRoute } from "./schedules.js";
import { runnerPrefixes } from "./tokens.js";

export const STATUSES = ["note", "queued", "active", "needs_decision", "blocked", "done", "failed"];
export const PRIORITIES = ["immediate_blocker", "next", "backlog"];
export const THREAD_KINDS = ["question", "resolution", "checkpoint", "note"];

/**
 * What a duty is for. `work` is everything a person files. `setup` and `rules` are how a daemon sets
 * a project up, and they change what every other duty on the board runs against — the toolchain,
 * the rules — which is why they are exclusive (invariant 3). `roster` drafts the board's team, and
 * `retro` reads what reviewers keep sending back and drafts changes to the team's charters and the
 * rules; what either hands in changes nothing until a person accepts it, so both run alongside
 * everything else.
 */
export const KINDS = ["work", "setup", "rules", "roster", "retro"];

/**
 * Agent session time one duty may use before a person is asked whether to go on, in minutes, when its
 * board does not say (`runner.duty_minutes`; 0 there means no limit). Time an agent's process actually
 * ran, as machines report it — not time waiting in a queue or on a usage limit.
 */
export const DEFAULT_DUTY_MINUTES = 600;

/**
 * How long a finished duty stays on the board, in days — for work nobody needs the record of once it
 * is done, like the fifth hundred run of a daily check. 0 keeps it. The clock starts when the duty is
 * done; a duty that comes back out of done keeps its setting and loses its clock. Failed duties are
 * never removed this way: a failure is something a person should see.
 */
export const MAX_EXPIRE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
export const expireDays = (v, field = "expire_after_days") => intIn(v, field, 0, MAX_EXPIRE_DAYS, 0);
/** When a duty in `status` is removed from the board, or null if it is not. */
export const expiresAt = (duty, status, now) => (status === "done" && duty.expire_after_days > 0 ? now + duty.expire_after_days * DAY_MS : null);
const EXCLUSIVE_KINDS = new Set(["setup", "rules"]);

/**
 * How long a parked duty waits for the machine that holds its worktree, when presence cannot say
 * whether that machine is online. Long enough for a laptop lid to close and open; short enough
 * that a machine that is gone does not strand the work.
 */
const AFFINITY_GRACE_MS = 30 * 60 * 1000;

/** Reserved and parked duties are filtered after the query, so it reads a little further than
 *  asked. Both are rare — one setup duty per linked machine, a handful of parked ones. */
const RUNNABLE_OVERFETCH = 20;

/** Active duties a claim reads to find a free lane. Far above any `parallel` a board may set. */
const MAX_ACTIVE_READ = 50;

/** Priority is an enum to people and a sort key to the scheduler. Alphabetical order of
 *  the names is wrong (`backlog` < `immediate_blocker`), so the rank is stored alongside. */
export const RANK = { immediate_blocker: 0, next: 1, backlog: 2 };

/**
 * The three fields the console's agent strip shows, carried on the event that changed them.
 *
 * Only the four transitions that actually write an agent row send it. This is the whole
 * reason a live event costs one query instead of two: without it every open tab re-reads
 * the agents collection just to learn that one badge moved from "working" to "idle".
 */
const agentEvent = (id, activeDutyId, at) => ({ id, active: activeDutyId || null, seen: at });

/**
 * Bounds that exist to protect the account's bill, not to express a product opinion.
 *
 * Everything on this board is written by software running unattended, and our own operating
 * protocol tells an agent to enqueue whatever it finds rather than absorb it. That is right
 * up until something loops, and then the only thing between a bad afternoon and a bad
 * invoice is a number like these. They sit where a person has plainly already lost the
 * board — nobody triages 500 open duties — so hitting one is a signal, not a limit anyone
 * should be managing around.
 *
 * Each refusal names the number and what to do about it, because the caller is usually an
 * agent and "quota exceeded" is not something it can act on.
 */
export const MAX_OPEN_DUTIES = 500;
const MAX_THREAD_ENTRIES = 200;

/** Roles a duty remembers having passed through — far above any team's size, and a bound on the row. */
const MAX_ROLE_TRAIL = 12;

/** Statuses that still need someone. A finished board may hold any number of duties; it is
 *  the UNFINISHED pile that means work is being created faster than it is being done. */
export const UNFINISHED = ["queued", "active", "needs_decision", "blocked"];

/**
 * Who is holding this duty, as a value the datastore can refuse a duplicate of.
 *
 * A unique index on `duties.holder` is what stops ONE agent holding TWO duties — the
 * mirror of the constraint on agents.active_duty_id, and it needs its own because the two
 * failures are different writes. The board id is in the value because agent ids are only
 * unique within a board: `alpha` on two boards is two agents, and a bare id would have
 * them locking each other out.
 *
 * Null while the duty is not active, and null does not collide — so any number of duties
 * may be unheld. `assigned_agent_id` is left alone by all of this: it outlives the claim,
 * because "last worked by alpha" is worth showing on a finished duty.
 */
const holderKey = (projectKey, agentId) => `${projectKey}:${agentId}`;

/** Terminal and near-terminal states an agent is no longer holding. */
const FREES_AGENT = new Set(["needs_decision", "blocked", "done", "failed", "queued"]);

const BRIEF_IN_POLL = 220; // characters — poll answers straight into an agent's context

const agentKey = (projectId, agentId) => `${projectId}:${agentId}`;
const laneKey = (projectKey, n) => `${projectKey}#${n}`;

/** Is `agentId` one of the agents a reservation names? A reservation is a machine's agent prefix,
 *  and every session on that machine is `<prefix>/<n>`. */
const reservedTo = (reserved, agentId) => !!agentId && (agentId === reserved || agentId.startsWith(reserved + "/"));

// --- reading --------------------------------------------------------------

/**
 * `POST /duty/poll` — the agent's whole view of the world in one call.
 *
 * Answers what it is holding (if anything) and the top of the runnable queue, with any
 * human resolution already folded in so the agent never has to fetch a thread to find
 * out what it was told.
 */
export async function pollDuties(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const agentId = agentIdFrom(ctx, body, { required: false });
  const limit = intIn(body.limit, "limit", 1, 10, 3);

  let active = null;
  if (agentId) {
    const agent = await ctx.store.get("agents", agentKey(project.key, agentId));
    if (agent && agent.active_duty_id) {
      const duty = await ctx.store.get("duties", agent.active_duty_id);
      // The agent row can lag: a human may have re-prioritised or cancelled the duty out
      // from under it. The duty row is the truth, so heal the agent row rather than
      // reporting an active duty that is not active.
      if (duty && duty.status === "active" && duty.assigned_agent_id === agentId) {
        active = briefOf(duty, { full: true });
      } else {
        await ctx.store.putOne("agents", agentKey(project.key, agentId), {
          ...stripMeta(agent),
          active_duty_id: null,
          last_seen_at: Date.now(),
        });
      }
    }
    await touchAgent(ctx, project, agentId);
  }

  const rows = await runnableDuties(ctx, project.key, agentId, limit, project);
  return {
    project_id: project.key,
    active_duty: active,
    runnable_duties: rows.map((d) => briefOf(d)),
  };
}

/**
 * The top of a board's queue, as `agentId` may take it.
 *
 * Everything queued, highest priority then oldest — minus what this agent could not claim if it
 * tried: a duty reserved for another machine, and a parked duty whose worktree is on another
 * machine that is still around to resume it. Poll and claim apply the same rules through
 * `claimBlocker`, so nothing is offered that the claim would then refuse.
 */
export async function runnableDuties(ctx, projectKey, agentId, limit, project = null) {
  const teamed = hasRoster(project || (await ctx.store.get("projects", projectKey)));
  const settingUp = await hasUnfinished(ctx, projectKey, [{ field: "kind", op: "=", value: "setup" }]);
  const eligible = [];
  let cursor = null;
  let scanned = 0;
  do {
    const page = await ctx.store.query("duties", {
      where: [
        { field: "project_id", op: "=", value: projectKey },
        { field: "status", op: "=", value: "queued" },
      ],
      order: [
        { field: "prio_rank", dir: "asc" },
        { field: "created_at", dir: "asc" },
      ],
      limit: limit + RUNNABLE_OVERFETCH,
      ...(cursor ? { cursor } : {}),
    });
    const present = await presenceFor(ctx, page.rows);
    const now = Date.now();
    eligible.push(...page.rows.filter((d) => !claimBlocker(ctx, d, agentId, present, now, teamed) && (!settingUp || d.kind === "setup")));
    cursor = page.cursor;
    scanned += page.rows.length;
    // Model-specific duties for other machines must not hide later runnable work.
  } while (cursor && eligible.length < limit && scanned < MAX_OPEN_DUTIES);
  return firstThingsFirst(eligible).slice(0, limit);
}

async function hasUnfinished(ctx, projectKey, where) {
  const n = await ctx.store.countAtMost(
    "duties",
    [{ field: "project_id", op: "=", value: projectKey }, ...where, { field: "status", op: "in", value: UNFINISHED }],
    1,
  );
  return n > 0;
}

/**
 * Block every duty in progress on a board behind a setup duty being filed, as ops for the caller's
 * transaction, with the events to publish after it.
 *
 * Each keeps the machine that was working it (its worktree and conversation are there), and gets a
 * note saying why it stopped. The daemon holding it sees the status change and ends its session.
 */
export async function blockBehindSetup(ctx, project, setup, machineName, now = Date.now()) {
  const active = (await activeDuties(ctx, project.key)).filter((d) => d.kind !== "setup");
  if (!active.length) return { ops: [], events: [] };
  const { rows: links } = await ctx.store.query("machine_links", {
    where: [{ field: "project_id", op: "=", value: project.key }],
    limit: 50,
  });
  const machineOf = (agentId) => links.find((l) => agentId && (agentId === l.agent_prefix || agentId.startsWith(l.agent_prefix + "/")));
  const ops = [];
  const events = [];
  for (const duty of active) {
    const holder = machineOf(duty.assigned_agent_id);
    ops.push(
      putOp("duties", duty.key, {
        ...stripMeta(duty),
        status: "blocked",
        blocked_by: setup.id,
        holder: null,
        lane: null,
        affinity: holder ? { machine_id: holder.machine_id, machine_name: holder.machine_name || "", at: now } : duty.affinity || null,
        updated_at: now,
      }),
      putOp("threads", threadId(), {
        duty_id: duty.key,
        project_id: project.key,
        owner_uid: project.owner_uid,
        author_type: "agent",
        author_id: "DutyBoard",
        kind: "note",
        message: `Paused: ${machineName} was put on this board, and its setup can change the toolchain, test command and worktree preparation this duty lands against. It picks up where it stopped${holder ? ` on ${holder.machine_name}` : ""} once "${setup.title}" is done.`,
        metadata: null,
        created_at: now,
      }),
    );
    if (duty.assigned_agent_id) {
      const aKey = agentKey(project.key, duty.assigned_agent_id);
      const agent = await ctx.store.get("agents", aKey);
      if (agent && agent.active_duty_id === duty.key) ops.push(putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: null, last_seen_at: now }));
    }
    events.push({
      id: duty.key,
      payload: { t: "duty", id: duty.key, status: "blocked", ...(duty.assigned_agent_id ? { ag: agentEvent(duty.assigned_agent_id, null, now) } : {}) },
    });
  }
  return { ops, events };
}

/** Everything blocked behind `duty`, put back at the front of the queue, as ops. Answers their ids. */
async function unblockWaiting(ctx, duty, now, ops) {
  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "project_id", op: "=", value: duty.project_id },
      { field: "status", op: "=", value: "blocked" },
      { field: "blocked_by", op: "=", value: duty.key },
    ],
    limit: MAX_ACTIVE_READ,
  });
  for (const waiting of rows) {
    ops.push(
      putOp("duties", waiting.key, {
        ...stripMeta(waiting),
        status: "queued",
        priority: "immediate_blocker",
        prio_rank: RANK.immediate_blocker,
        blocked_by: null,
        holder: null,
        lane: null,
        updated_at: now,
      }),
    );
  }
  return rows.map((r) => r.key);
}

/**
 * A machine's setup duty, then the board's rules duty, then everything else in queue order.
 *
 * Both change what every other duty runs against — the tools on the machine, the rules in the
 * prompt — and queue order alone put a newly linked machine to work on an older blocker before it
 * had installed anything. Stable, so the rest keep their priority and age order.
 */
const KIND_ORDER = { setup: 0, rules: 1 };
function firstThingsFirst(rows) {
  return rows
    .map((d, i) => ({ d, i, k: KIND_ORDER[d.kind] ?? 2 }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.d);
}

/** `status = active` on one board. Bounded: nothing about a board makes this large. */
export async function activeDuties(ctx, projectKey) {
  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "project_id", op: "=", value: projectKey },
      { field: "status", op: "=", value: "active" },
    ],
    limit: MAX_ACTIVE_READ,
  });
  return rows;
}

/** Presence for every machine some other caller's parked duty is waiting on — one ask per machine. */
async function presenceFor(ctx, duties) {
  const mine = ctx.caller.machineId;
  const waiting = duties.filter((d) => d.affinity && d.affinity.machine_id !== mine).map((d) => d.affinity.machine_id);
  return waiting.length ? machinesPresent(ctx, waiting) : new Map();
}

export function dutyRunnerTooOld(ctx, duty) {
  return duty.agent_options != null && ctx.caller.machineId && olderRelease(ctx.clientVersion || ctx.caller.machineRow?.cli_version, "2.30.0");
}

/**
 * Why `agentId` may not claim this duty, or null when it may.
 *
 * A reservation is absolute: a setup duty installs tools on ONE machine, and done anywhere else it
 * is done on the wrong computer. Affinity is not: it keeps a parked duty for the machine whose
 * worktree has the half-finished work, but only while that machine is there to pick it up.
 */
/**
 * A board with a team needs a runner that knows its role: an older one would work the duty as if it
 * were alone, and then be refused when it tried to finish what a reviewer has to see first.
 */
export function rosterTooOld(ctx, duty, teamed) {
  return teamed && (duty.kind || "work") === "work" && !!ctx.caller.machineId && olderRelease(ctx.clientVersion || ctx.caller.machineRow?.cli_version, ROSTER_MIN_RELEASE);
}

function claimBlocker(ctx, duty, agentId, present, now, teamed = false) {
  if (dutyRunnerTooOld(ctx, duty)) return "this duty's model priority requires dutyboard 2.30.0 or later";
  if (rosterTooOld(ctx, duty, teamed)) return `this board has a team, which needs dutyboard ${ROSTER_MIN_RELEASE} or later on the machine`;
  if (teamed && duty.agent_options == null && (duty.kind || "work") === "work" && ctx.caller.machineId) {
    const mine = ctx.caller.machineRow?.agent_options;
    if (Array.isArray(mine) && !mine.some((o) => !o.disabled)) return "this machine has no agent/model combination enabled to work a role with";
  }
  if (duty.agent_options != null && ctx.caller.machineId && !duty.agent_options.some((choice) =>
    (ctx.caller.machineRow?.agent_options || []).some((allowed) => !allowed.disabled && choice.agent === allowed.agent && (choice.model || "") === (allowed.model || "") && (choice.effort || "") === (allowed.effort || "")))) {
    return "this machine has no enabled combination matching this duty's model priority";
  }
  if (duty.kind === "note" || duty.approval_required) return "this note or suggestion needs human approval before it can be worked";
  if (duty.reserved_for && !reservedTo(duty.reserved_for, agentId)) {
    return `duty '${duty.key}' is reserved for '${duty.reserved_for}'`;
  }
  const affinity = duty.affinity;
  if (affinity && affinity.machine_id !== ctx.caller.machineId) {
    const online = present.get(affinity.machine_id);
    const waiting = online === true || (online == null && now - (affinity.at || 0) < AFFINITY_GRACE_MS);
    if (waiting) return `duty '${duty.key}' is parked on machine '${affinity.machine_name || affinity.machine_id}', which will resume it`;
  }
  return null;
}

/**
 * `POST /duty/get` — one duty as it stands now.
 *
 * An agent otherwise only ever sees a duty through poll and claim, which is enough to work it and
 * not enough to supervise it: a daemon whose session has just exited needs to know whether the duty
 * was finished, parked, failed or is still held, and why.
 */
export async function getDuty(ctx, body) {
  const duty = await loadDuty(ctx, body.duty_id);
  await projectOfDuty(ctx.caller, duty, ctx.store);
  const project = duty.kind === "note" ? await ctx.store.get("projects", duty.project_id) : null;
  const linked = duty.kind === "note" ? await noteSuggestions(ctx, duty, body.suggestions_cursor) : null;
  // A session reading the duty it holds is told its role again: a runner that restarted reads the
  // duty here, not through a claim.
  const roster = ctx.caller.kind === "agent" && ctx.caller.scope !== "submit" && (duty.kind || "work") === "work" ? await rosterInForce(ctx, duty.project_id) : null;
  return {
    ...(roster ? { roster: roleContext(roster, duty) } : {}),
    ...(linked ? { suggestions: linked.rows.map(d => ({ ...briefOf(d, { full: true }), review_duty_id: d.spawned_by, outcome_summary: d.outcome_summary || null })), suggestions_cursor: linked.cursor } : {}),
    duty: {
      ...briefOf(duty, { full: true }),
      ...(roster ? { agent_options: dutyOptions(ctx, roster, duty), role: roleFor(roster, duty).id } : {}),
      handoffs: duty.handoffs || 0,
      bounces: duty.bounces || 0,
      role_trail: duty.role_trail || [],
      ...(duty.kind === "note" ? { has_suggestions: await hasNoteSuggestions(ctx, duty) } : {}),
      ...(duty.kind === "note" && project?.notes_review_duty_id ? { review_duty_id: project.notes_review_duty_id } : {}),
      outcome_summary: duty.outcome_summary || null,
      last_question: duty.last_question || null,
      attachment_count: duty.attachment_count || 0,
      expect_files: duty.expect_files || 0,
      expire_after_days: duty.expire_after_days || 0,
      expires_at: duty.expires_at || null,
      affinity: duty.affinity || null,
      spawned_by: duty.spawned_by || null,
      blocked_by: duty.blocked_by || null,
      // Set when a schedule filed this duty: the console says so rather than leaving a duty that
      // appeared at 9am on Monday looking like one nobody can account for.
      schedule_id: duty.schedule_id || null,
      // The duty this one was split out of, the duty that checks its pieces together, or the duty
      // whose pieces this one checks.
      split_from: duty.split_from || null,
      acceptance_duty_id: duty.acceptance_duty_id || null,
      acceptance_of: duty.acceptance_of || null,
      // How long agents' sessions have run on it, as their machines reported.
      usage: usageView(await ctx.store.get("duty_usage", duty.key)),
      external_ref: duty.external_ref || null,
      metadata: duty.metadata || null,
      created_by_name: duty.created_by_name || null,
      created_at: duty.created_at,
      updated_at: duty.updated_at,
    },
  };
}

const usageView = (row) => ({ ms: (row && row.ms) || 0, sessions: (row && row.sessions) || 0 });

/** Read a page of any lane without polling or touching an agent's state. */
export async function listDuties(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const status = oneOf(body.status, "status", [...STATUSES, "any"], "any");
  const limit = intIn(body.limit, "limit", 1, 50, 25);
  const { rows, cursor } = await ctx.store.query("duties", {
    where: [{ field: "project_id", op: "=", value: project.key }, ...(status === "any" ? [] : [{ field: "status", op: "=", value: status }])],
    order: [{ field: "updated_at", dir: "desc" }], limit,
    cursor: str(body.cursor, "cursor", { max: 4000, fallback: "" }) || undefined,
  });
  return { project_id: project.key, duties: rows.map(d => ({ ...briefOf(d, { full: true }), outcome_summary: d.outcome_summary || null, last_question: d.last_question || null })), cursor: rows.length === limit ? cursor : null };
}

/** Duties per page of `/duty/changes`. */
const MAX_CHANGES = 100;

/**
 * `POST /duty/changes` — the duties this token filed that moved since `since`, oldest change first.
 *
 * Polling for what a webhook would have said, for a caller with nowhere to receive one: keep the
 * `next_since` it answers and pass it back. A duty that moves twice between polls is listed once,
 * as it stands now.
 */
export async function listChanges(ctx, body) {
  const caller = requireAgent(ctx.caller);
  await resolveProject(caller, body.project_id, ctx.store);
  if (!caller.tokenKey) throw forbidden("changes are listed per token — call this with a db_… project token");
  const since = intIn(body.since, "since", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = intIn(body.limit, "limit", 1, MAX_CHANGES, 50);
  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "filed_by_token", op: "=", value: caller.tokenKey },
      { field: "updated_at", op: ">", value: since },
    ],
    order: [{ field: "updated_at", dir: "asc" }],
    limit,
  });
  // One transition can stamp two of its duties with the same millisecond — finishing one puts its
  // parent back in the queue. A full page that ends inside such a millisecond would skip the rest
  // of it next time, so that millisecond is left for the next page whole.
  const more = rows.length === limit;
  const last = rows.length ? rows[rows.length - 1].updated_at : since;
  const page = more && rows[0].updated_at !== last ? rows.filter((d) => d.updated_at !== last) : rows;
  return {
    more,
    duties: page.map((d) => ({
      ...briefOf(d, { full: true }),
      outcome_summary: d.outcome_summary || null,
      last_question: d.last_question || null,
      attachment_count: d.attachment_count || 0,
      external_ref: d.external_ref || null,
      metadata: d.metadata || null,
      updated_at: d.updated_at,
    })),
    next_since: page.length ? page[page.length - 1].updated_at : since,
  };
}

/** `POST /duty/thread` — the decision log for one duty, oldest first. */
export async function listThread(ctx, body) {
  const duty = await loadDuty(ctx, body.duty_id);
  // This endpoint used to be the one duty-scoped route with no ownership check on it:
  // `loadDuty` trusted its callers to check, and this caller did not. Any signed-in
  // person, or any agent token for any board, could read any decision log by naming a
  // duty id. Ids are ULIDs and not guessable, which is not an access control.
  await projectOfDuty(ctx.caller, duty, ctx.store);
  const limit = intIn(body.limit, "limit", 1, 100, 20);
  const { rows } = await ctx.store.query("threads", {
    where: [{ field: "duty_id", op: "=", value: duty.key }],
    order: [{ field: "created_at", dir: "asc" }],
    limit,
  });
  return {
    duty_id: duty.key,
    entries: rows.map((t) => ({
      id: t.key,
      author_type: t.author_type,
      author_id: t.author_id,
      kind: t.kind,
      message: t.message,
      metadata: t.metadata || null,
      created_at: t.created_at,
    })),
  };
}

// --- transitions ----------------------------------------------------------

/** `POST /duty/claim` — queued → active, for exactly one agent. */
export async function claimDuty(ctx, body) {
  const agentId = agentIdFrom(ctx, body, { required: true });
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const now = Date.now();

  if (duty.status !== "queued") {
    throw conflict(`duty '${duty.key}' is ${duty.status}, not queued`, { status: duty.status });
  }
  // The board row carries how many duties may be active at once, which rules are current and whether
  // it has a team — all of which a claim needs and `projectOfDuty` deliberately does not read.
  const board = await ctx.store.get("projects", project.key);
  const blocker = claimBlocker(ctx, duty, agentId, await presenceFor(ctx, [duty]), now, hasRoster(board));
  if (blocker) throw conflict(blocker, { reserved_for: duty.reserved_for || null, affinity: duty.affinity || null });
  if (duty.kind !== "setup" && (await hasUnfinished(ctx, project.key, [{ field: "kind", op: "=", value: "setup" }]))) {
    // Worded like the exclusive refusal below, which a daemon already reads as "the board is busy".
    throw conflict("a machine's setup has the board to itself until it finishes", { waiting_for: "setup" });
  }

  await withinBudget(ctx, duty, board, project, now);
  const [active, roster] = await Promise.all([activeDuties(ctx, project.key), hasRoster(board) ? rosterInForce(ctx, project.key) : null]);
  const lane = pickLane(duty, board, active, project.key);
  // The role this claim works as. A duty filed before the board had a team, or naming a role the team
  // no longer has, starts with whoever reads new duties first.
  const role = roleFor(roster, duty);

  const aKey = agentKey(project.key, agentId);
  const agent = (await ctx.store.get("agents", aKey)) || newAgent(project, agentId, now);
  if (agent.active_duty_id && agent.active_duty_id !== duty.key) {
    // The agent row can name a duty that is no longer this agent's — deleted, or moved by a person
    // — when nothing polled in between to heal it. The duty row is the truth, as in poll.
    const held = await ctx.store.get("duties", agent.active_duty_id);
    if (!held || held.status !== "active" || held.assigned_agent_id !== agentId) agent.active_duty_id = null;
  }
  if (agent.active_duty_id && agent.active_duty_id !== duty.key) {
    // The single-active invariant, reported so the agent knows what to finish first.
    throw conflict(`agent '${agentId}' already holds duty '${agent.active_duty_id}'`, {
      active_duty_id: agent.active_duty_id,
    });
  }

  // The mutex. A unique index on agents.active_duty_id means two agents cannot both hold
  // one duty: the second transaction to write that value is refused by the datastore, and
  // the whole transaction fails, so the duty is not modified either.
  //
  // This replaced a compare-after-write, which could not work and did not. Both claimers
  // wrote, then both read back — and whoever read before the other wrote saw itself and
  // walked away believing it had won. Two agents in ten got the same duty, measured, which
  // is the exact failure that check was written to prevent.
  //
  // Nulls do not collide, which is what makes this usable: every idle agent has
  // active_duty_id null, and any number of them may.
  await Promise.all([
    ctx.store.ensureUniqueIndex("agents", ["active_duty_id"]),
    ctx.store.ensureUniqueIndex("duties", ["holder"]),
    ctx.store.ensureUniqueIndex("duties", ["lane"]),
  ]);

  const claimed = {
    ...stripMeta(duty),
    status: "active",
    assigned_agent_id: agentId,
    holder: holderKey(project.key, agentId),
    lane,
    // Whoever claims it now has the work; a worktree left on another machine is that machine's
    // to clean up, and the daemon that parks it again sets this again.
    affinity: null,
    // The claim hands over every note on the duty so far; finishing it is refused while there are
    // newer ones the session has not been shown (see unreadNotes).
    notes_seen_at: now,
    // When this claim started, kept apart from `updated_at`, which every checkpoint moves: "running
    // for 40m" on the boards page has to mean since the agent took it, not since it last spoke.
    claimed_at: now,
    updated_at: now,
    ...(role ? { role: role.id, role_trail: [...new Set([...(duty.role_trail || []), role.id])].slice(-MAX_ROLE_TRAIL) } : {}),
  };
  try {
    await ctx.store.transaction([
      putOp("duties", duty.key, claimed),
      putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: duty.key, last_seen_at: now }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // One of the two constraints refused it, and which one is worth saying: either
      // somebody else took this duty, or this agent already holds another. Re-read to find
      // out. Nothing was written — the transaction is atomic — so there is nothing to undo.
      const [now2, mine] = await Promise.all([
        ctx.store.get("duties", duty.key),
        ctx.store.get("agents", aKey),
      ]);
      if (mine && mine.active_duty_id && mine.active_duty_id !== duty.key) {
        throw conflict(`agent '${agentId}' already holds duty '${mine.active_duty_id}'`, {
          active_duty_id: mine.active_duty_id,
        });
      }
      // Still queued, so nobody took THIS duty: what refused it was the lane, taken by another
      // duty's claim in the same instant.
      if (lane && now2 && now2.status === "queued") {
        throw conflict(`another claim took this board's last free lane at the same moment — poll again`, {
          parallel: boardParallel(board),
        });
      }
      throw conflict(`duty '${duty.key}' was claimed by another agent`, {
        assigned_agent_id: now2 ? now2.assigned_agent_id || null : null,
      });
    }
    throw err;
  }

  await ctx.publish(project.key, duty.key, {
    t: "duty",
    id: duty.key,
    status: "active",
    ag: agentEvent(agentId, duty.key, now),
  });
  // `claimed` is the row that was just written, minus the envelope stripMeta removed — so
  // the key comes back from the duty it was built from rather than a re-read.
  const notes = await peopleNotes(ctx, duty.key);
  return {
    status: "active",
    duty_id: duty.key,
    duty: {
      ...briefOf({ ...claimed, key: duty.key }, { full: true }),
      ...(role ? { agent_options: dutyOptions(ctx, roster, claimed) } : {}),
      expect_files: claimed.expect_files || 0,
      notes,
    },
    // So a daemon can tell, from the claim alone, whether the rules it has are current.
    rules_version: (board && board.rules_version) || 0,
    // Who this session is on the board's team, and who it can hand the duty to.
    ...(role ? { roster: roleContext(roster, claimed) } : {}),
    // What the team has written down for whoever works here next.
    memory: await memoryOf(ctx, project.key),
  };
}

const boardParallel = (board) => (board && board.runner && board.runner.parallel) || null;

/**
 * The lane this claim will occupy, or null on a board that does not limit parallel work.
 *
 * Throws when the board has no room — which is a 409 the daemon expects and moves on from, not
 * an error. A board with no `runner.parallel` predates the setting and keeps its old behaviour:
 * any number of agents at once, and no lane written.
 */
function pickLane(duty, board, active, projectKey) {
  const exclusive = active.find((d) => EXCLUSIVE_KINDS.has(d.kind));
  if (exclusive) {
    throw conflict(`duty '${exclusive.key}' (${exclusive.kind}) has the board to itself until it finishes`, {
      exclusive_duty_id: exclusive.key,
    });
  }
  const parallel = boardParallel(board);
  if (EXCLUSIVE_KINDS.has(duty.kind)) {
    if (active.length) {
      throw conflict(`a ${duty.kind} duty needs the board to itself, and ${active.length} other duties are active`, {
        active: active.length,
      });
    }
    // Lane 1 always, so an exclusive claim and an ordinary one racing on an empty board collide
    // on the same key and only one lands.
    return laneKey(projectKey, 1);
  }
  if (!parallel) return null;
  if (active.length >= parallel) {
    throw conflict(`this board runs ${parallel} ${parallel === 1 ? "duty" : "duties"} at a time, and ${parallel === 1 ? "it is" : "all are"} taken`, {
      parallel,
    });
  }
  const used = new Set(active.map((d) => d.lane).filter(Boolean));
  for (let n = 1; n <= parallel; n++) {
    if (!used.has(laneKey(projectKey, n))) return laneKey(projectKey, n);
  }
  // Active rows from before lanes existed carry none, so the count above can pass while every
  // numbered lane is in use by rows that do. Full is full.
  throw conflict(`this board runs ${parallel} duties at a time, and all are taken`, { parallel });
}

// The first source retains the existing index, including suggestions made before
// multi-note reviews. Additional sources have independent links, written atomically.
async function noteSuggestions(ctx, note, value, since = 0) {
  const recent = since ? [{ field: "created_at", op: ">", value: since - 1 }] : [];
  const cursor = str(value, "suggestions_cursor", { max: 4000, fallback: "" });
  let rows = [];
  if (!cursor.startsWith("sources:")) {
    const page = await ctx.store.query("duties", {
      where: [{ field: "project_id", op: "=", value: note.project_id }, { field: "source_note_id", op: "=", value: note.key }, { field: "kind", op: "=", value: "work" }, ...recent],
      order: [{ field: "created_at", dir: "desc" }], limit: 25, cursor: cursor || undefined,
    });
    rows = page.rows;
    if (page.cursor && rows.length === 25) return page;
    if (rows.length === 25) return { rows, cursor: "sources:" };
  }
  const page = await ctx.store.query("note_sources", {
    where: [{ field: "project_id", op: "=", value: note.project_id }, { field: "note_id", op: "=", value: note.key }, ...recent],
    order: [{ field: "created_at", dir: "desc" }], limit: 25 - rows.length,
    cursor: cursor.startsWith("sources:") ? cursor.slice(8) || undefined : undefined,
  });
  const duties = await ctx.store.getMany("duties", page.rows.map(r => r.duty_id));
  return { rows: [...rows, ...page.rows.map(r => duties.get(r.duty_id)).filter(d => d?.project_id === note.project_id)], cursor: page.cursor ? `sources:${page.cursor}` : null };
}

// Clearing eligibility keeps provenance intact. Each new suggestion records the note's
// current round. Legacy proposals count until a note is explicitly cleared by this
// version (older clear actions did not detach suggestion links). Deleted duties
// are absent from this lookup and therefore no longer prevent another suggestion.
async function hasNoteSuggestions(ctx, note) {
  let cursor;
  do {
    const page = await noteSuggestions(ctx, note, cursor, note.suggestions_cleared_at || 0);
    if (page.rows.some(d => d.source_note_rounds
      ? (d.source_note_rounds[note.key] || "initial") === (note.suggestion_round || "initial")
      : !note.suggestions_cleared_at)) return true;
    cursor = page.cursor;
  } while (cursor);
  return false;
}

export const sourceNoteIDs = duty => duty.source_note_ids || (duty.source_note_id ? [duty.source_note_id] : []);

/** Notes live outside the runnable queue, but share files, threads and board access. */
export async function listNotes(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const page = await ctx.store.query("duties", {
    where: [{ field: "project_id", op: "=", value: project.key }, { field: "status", op: "=", value: "note" }],
    order: [{ field: "created_at", dir: "asc" }], limit: 100,
    cursor: str(body.cursor, "cursor", { max: 4000, fallback: "" }) || undefined,
  });
  const review = project.notes_review_duty_id ? await ctx.store.get("duties", project.notes_review_duty_id) : null;
  return { notes: await Promise.all(page.rows.map(async d => ({ ...briefOf(d, { full: true }), has_suggestions: await hasNoteSuggestions(ctx, d), attachment_count: d.attachment_count || 0, created_at: d.created_at }))),
    cursor: page.rows.length === 100 ? page.cursor : null,
    review: review && UNFINISHED.includes(review.status) ? briefOf(review, { full: true }) : null };
}

export async function moveNote(ctx, body) {
  requireHuman(ctx.caller);
  const note = await loadDuty(ctx, body.note_id);
  await projectOfDuty(ctx.caller, note, ctx.store);
  if (note.kind !== "note") throw conflict("this is not a board note");
  if (!Number.isInteger(body.x) || !Number.isInteger(body.y) || body.x < 0 || body.x > 10000 || body.y < 0 || body.y > 50000) throw badRequest("x and y must be whole-number positions within the notes board");
  const position = { x: body.x, y: body.y };
  await ctx.store.putOne("duties", note.key, { ...stripMeta(note), note_position: position });
  await ctx.publish(note.project_id, note.key, { t: "duty", id: note.key, status: "note" });
  return { ok: true, note_position: position };
}

async function notesProject(ctx, body) {
  if (!body.note_id) return resolveProject(ctx.caller, body.project_id, ctx.store);
  const note = await loadDuty(ctx, body.note_id);
  if (note.kind !== "note") throw conflict("this is not a board note");
  await projectOfDuty(ctx.caller, note, ctx.store);
  return resolveProject(ctx.caller, note.project_id, ctx.store);
}

export async function createNote(ctx, body) {
  requireHuman(ctx.caller);
  const brief = str(body.brief, "brief", { max: 4000, fallback: "" });
  if (!brief && !body.expect_files) throw badRequest("add note text or a file");
  return enqueueDuty(ctx, { project_id: body.project_id, title: body.title, brief: brief || "See attached files.", expect_files: body.expect_files }, { note: true });
}

export async function processNote(ctx, body) {
  requireHuman(ctx.caller);
  const project = await notesProject(ctx, body);
  if (project.notes_review_duty_id) {
    const review = await ctx.store.get("duties", project.notes_review_duty_id);
    if (review && UNFINISHED.includes(review.status)) return filedAlready(review);
  }
  const notes = [];
  let cursor;
  do {
    const page = await listNotes(ctx, { project_id: project.key, cursor });
    notes.push(...page.notes);
    cursor = page.cursor;
  } while (cursor && notes.length < MAX_OPEN_DUTIES);
  if (!notes.length) throw badRequest("add at least one note before suggesting duties");
  const legacyIDs = [...new Set(notes.map(n => n.review_duty_id).filter(Boolean))];
  const legacy = await ctx.store.getMany("duties", legacyIDs);
  if ([...legacy.values()].some(r => UNFINISHED.includes(r.status))) throw conflict("finish or cancel the existing note review first");
  const eligible = notes.filter(n => !n.has_suggestions);
  if (!eligible.length) throw badRequest("all notes already have linked suggestions; clear a note link to suggest again");
  return enqueueDuty(ctx, {
    project_id: project.key, title: `Suggest duties from ${eligible.length} ${eligible.length === 1 ? "note" : "notes"}`,
    brief: `This review includes only notes without a current linked suggestion. Review ALL source_note_ids on this review, including each note's files, discussion and linked suggestions. Consider related notes together; one proposed duty can use several notes. Use duty_suggest with source_note_ids naming the notes that support each proposal, a complete brief and an optional question. Avoid duplicating existing work. Every suggestion requires human approval. Do not implement, change accounts, schedule work, commit, integrate or deploy. Finish with duty_complete and the suggested IDs, or explain why none are needed. Notes added after this review was requested belong to the next review.`,
  }, { reviewNotes: eligible.map(n => n.id), reviewAfter: project.notes_review_duty_id || project.notes_review_round || "initial" });
}

export async function clearNoteSuggestions(ctx, body) {
  requireHuman(ctx.caller);
  const project = await notesProject(ctx, body);
  if (project.notes_review_duty_id) {
    const review = await ctx.store.get("duties", project.notes_review_duty_id);
    if (review && UNFINISHED.includes(review.status)) throw conflict("finish or cancel the current review before clearing it");
  }
  const note = body.note_id ? await loadDuty(ctx, body.note_id) : null;
  if (note?.review_duty_id) {
    const review = await ctx.store.get("duties", note.review_duty_id);
    if (review && UNFINISHED.includes(review.status)) throw conflict("finish or cancel the current review before clearing its link");
  }
  // note_id clears only this note's eligibility link. Keep the board review pointer
  // so retries of a new review still deduplicate against the same predecessor.
  const ops = note
    ? [putOp("duties", note.key, { ...stripMeta(note), review_duty_id: null, suggestion_round: dutyId(), suggestions_cleared_at: Date.now(), updated_at: Date.now() })]
    : [putOp("projects", project.key, { ...stripMeta(project), notes_review_duty_id: null, notes_review_round: dutyId() })];
  await ctx.store.transaction(ops);
  await ctx.publish(project.key, null, { t: "notes" });
  if (note) await ctx.publish(note.project_id, note.key, { t: "duty", id: note.key, status: "note" });
  return { ok: true, project_id: project.key, ...(note ? { note_id: note.key } : {}) };
}

export async function suggestDuty(ctx, body) {
  requireAgent(ctx.caller);
  return enqueueDuty(ctx, body, { suggest: true });
}

/**
 * `POST /duty/enqueue` — new work, from either side of the board.
 *
 * `immediate_blocker` from an agent that is holding something means "I cannot continue
 * until this is done": the held duty moves to `blocked` referencing the new child, and
 * the agent is freed to claim the child on its next poll.
 */
export async function enqueueDuty(ctx, body, internal = {}) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const submit = ctx.caller.scope === "submit";
  const agentId = submit ? "" : agentIdFrom(ctx, body, { required: false });
  // A review can only file suggestions, even if it uses the ordinary enqueue tool.
  const agent = agentId ? await ctx.store.get("agents", agentKey(project.key, agentId)) : null;
  const held = agent?.active_duty_id ? await ctx.store.get("duties", agent.active_duty_id) : null;
  const spawningID = str(body.spawned_by, "spawned_by", { max: 64, fallback: "" });
  const spawning = spawningID ? await ctx.store.get("duties", spawningID) : null;
  if (spawning?.project_id === project.key && spawning.kind === "note_review" && (held?.key !== spawning.key || held.status !== "active")) {
    throw conflict("this note review is no longer held; its session must stop");
  }
  const review = held?.status === "active" && held.kind === "note_review" ? held : null;
  if (internal.suggest && !review) throw conflict("claim a note review before suggesting duties");
  if (review && (body.kind && body.kind !== "work" || body.parent_id)) throw forbidden("a note review only creates suggested work");
  let sources = [];
  if (review) {
    const available = sourceNoteIDs(review);
    const requested = body.source_note_ids ?? (available.length === 1 ? available : null);
    if (!Array.isArray(requested) || !requested.length || requested.length > 50 || requested.some(id => typeof id !== "string" || !available.includes(id))) {
      throw badRequest("source_note_ids must name 1–50 notes from the held review");
    }
    const ids = [...new Set(requested)];
    const found = await ctx.store.getMany("duties", ids);
    sources = ids.map(id => found.get(id));
    if (sources.some(n => !n || n.kind !== "note" || n.project_id !== project.key)) throw conflict("a source note no longer exists on this board");
    if (review.review_scope === "board" ? project.notes_review_duty_id !== review.key : sources.some(n => n.review_duty_id !== review.key)) throw conflict("this note review is no longer current");
  } else if (body.source_note_ids != null) {
    throw forbidden("source notes can only be linked while holding their review");
  }

  // The caller's own name for this work — an order id, a CI run — under which filing it again
  // answers the duty already filed instead of filing a second. The unique index on `api_ref` is
  // what makes that hold when two retries race; the read first is what makes the common case
  // (a retry long after the first went through) an answer rather than an error.
  const externalRef = str(body.external_ref, "external_ref", { max: 128, fallback: "" }) || null;
  const apiRef = internal.reviewNotes ? `notes-review:${project.key}:${internal.reviewAfter || project.notes_review_round || "initial"}`
    : review ? `note-suggestion:${review.key}:${externalRef || str(body.title, "title", { required: true, max: 200 })}`
    : externalRef ? `${refOwner(ctx.caller)}:${externalRef}` : null;
  if (apiRef) {
    const existing = await dutyByRef(ctx, apiRef);
    if (existing) return filedAlready(existing);
  }

  if (internal.note) {
    const count = await ctx.store.countAtMost("duties", [{ field: "project_id", op: "=", value: project.key }, { field: "status", op: "=", value: "note" }], MAX_OPEN_DUTIES);
    if (count >= MAX_OPEN_DUTIES) throw badRequest("this board has 500 notes; delete some before adding more");
  }
  // Counted before anything is written, so a loop is refused rather than recorded.
  const open = await ctx.store.countAtMost(
    "duties",
    [
      { field: "project_id", op: "=", value: project.key },
      { field: "status", op: "in", value: UNFINISHED },
    ],
    MAX_OPEN_DUTIES,
  );
  if (open >= MAX_OPEN_DUTIES) {
    throw badRequest(
      `this board has ${MAX_OPEN_DUTIES} unfinished duties, which is the limit. Finish or ` +
        `delete some before adding more. If you are an agent that has been enqueueing ` +
        `repeatedly, stop and report that instead of retrying.`,
    );
  }

  const now = Date.now();
  const priority = oneOf(body.priority, "priority", PRIORITIES, "next");
  // A submit token is no agent: it holds nothing, so there is nothing for an interrupt to block.
  const kind = internal.note ? "note" : internal.reviewNotes ? "note_review" : oneOf(body.kind, "kind", KINDS, "work");
  if (submit) {
    // What it files is work, standing on its own. Setup and rules duties change what every other
    // duty runs against; a parent or a spawning duty would tie it to work it cannot see.
    if (kind !== "work") throw forbidden("a submit token files work duties only");
    if (body.parent_id || body.spawned_by) throw forbidden("a submit token files duties of its own — no parent_id or spawned_by");
  }
  const reservedFor = await reservation(ctx, body, project.key);
  const metadata = metadataFrom(body.metadata);
  const role = await filedRole(ctx, body, project, { kind, held, outsider: submit || !!review || !!ctx.caller.crossBoard });

  const duty = {
    project_id: project.key,
    owner_uid: project.owner_uid,
    parent_id: str(body.parent_id, "parent_id", { max: 64, fallback: null }) || null,
    title: str(body.title, "title", { required: true, max: 200 }),
    brief: str(body.brief, "brief", { required: true, max: 4000 }),
    status: internal.note ? "note" : review ? "needs_decision" : "queued",
    source_note_id: sources[0]?.key || internal.reviewNotes?.[0] || null,
    source_note_ids: review ? sources.map(n => n.key) : internal.reviewNotes || null,
    ...(internal.reviewNotes ? { review_scope: "board" } : {}),
    ...(review ? { source_note_rounds: Object.fromEntries(sources.map(n => [n.key, n.suggestion_round || "initial"])) } : {}),
    approval_required: !!review,
    agent_options: dutyAgentOptions(body.agent_options),
    // Who on the board's team has it. Null on a board with none.
    role,
    // A piece an agent split out of the duty it held, naming who works it. When every piece of one
    // duty is finished, the whole is checked once more (see `acceptanceOps`).
    split_from: role && body.role && held ? held.key : null,
    priority,
    prio_rank: RANK[priority],
    origin_board_id: ctx.caller.crossBoard?.source || null,
    origin_duty_id: ctx.caller.crossBoard?.sourceDutyID || null,
    origin: submit ? "api" : ctx.caller.kind === "agent" ? "agent" : "human",
    // WHICH person. `origin` said "a human", which was the same thing as "the owner" until a
    // board could be shared; now a member files work too, and a card that says "from you" to
    // everyone who opens the board is wrong for all but one of them. From outside, the token's
    // name is the nearest thing to a who.
    created_by: ctx.caller.kind === "human" ? ctx.caller.uid : null,
    created_by_name: ctx.caller.kind === "human" ? ctx.caller.name : submit ? ctx.caller.tokenName || null : null,
    // The token that filed it, by its hash: who a submit token may see, and whose webhook hears
    // about every move it makes.
    filed_by_token: ctx.caller.tokenKey || null,
    external_ref: externalRef,
    api_ref: apiRef,
    metadata,
    assigned_agent_id: null,
    outcome_summary: null,
    spawned_by: review?.key || str(body.spawned_by, "spawned_by", { max: 64, fallback: null }) || null,
    blocked_by: null,
    last_question: review ? str(body.question, "question", { max: 4000, fallback: `Created from ${sources.length === 1 ? "note" : "notes"}. Approve this suggested duty?` }) : null,
    last_resolution: null,
    kind,
    reserved_for: reservedFor,
    affinity: null,
    lane: null,
    // Files the person filing it is about to attach. The console adds them once the duty exists, and a
    // runner claims within seconds — so it waits for this many before it starts, rather than working
    // a duty whose input has not arrived.
    expect_files: intIn(body.expect_files, "expect_files", 0, MAX_ATTACHMENTS, 0),
    // Left out, a work duty takes the board's default. Setup and rules duties are kept: they are the
    // record of how the board came to be set up the way it is.
    expire_after_days:
      body.expire_after_days != null
        ? expireDays(body.expire_after_days)
        : kind === "work"
          ? (project.profile && project.profile.expire_after_days) || 0
          : 0,
    expires_at: null,
    created_at: now,
    updated_at: now,
  };
  const id = dutyId();
  const ops = [putOp("duties", id, duty)];
  if (internal.reviewNotes) ops.push(putOp("projects", project.key, { ...stripMeta(project), notes_review_duty_id: id }));
  for (const source of sources.slice(1)) ops.push(putOp("note_sources", `${source.key}:${id}`, {
    project_id: project.key, owner_uid: project.owner_uid, note_id: source.key, duty_id: id, created_at: now,
  }));
  if (review) ops.push(putOp("threads", threadId(), {
    duty_id: id, project_id: project.key, owner_uid: project.owner_uid,
    ...authorOf(ctx.caller, agentId), kind: "question", message: duty.last_question, created_at: now,
    metadata: { source_note_id: sources[0].key, source_note_ids: sources.map(n => n.key) },
  }));

  // Does this interrupt something the caller is holding?
  let blocked = null;
  if (priority === "immediate_blocker" && agentId && !review) {
    const aKey = agentKey(project.key, agentId);
    const agent = await ctx.store.get("agents", aKey);
    if (agent && agent.active_duty_id) {
      const held = await ctx.store.get("duties", agent.active_duty_id);
      if (held && held.status === "active") {
        duty.parent_id = duty.parent_id || held.key;
        ops.push(putOp("duties", held.key, { ...stripMeta(held), status: "blocked", blocked_by: id, holder: null, lane: null, updated_at: now }));
        ops.push(putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: null, last_seen_at: now }));
        blocked = held.key;
      }
    }
  }

  if (apiRef) await ctx.store.ensureUniqueIndex("duties", ["api_ref"]);
  try {
    await ctx.store.transaction(ops);
  } catch (err) {
    // Two retries of one external_ref, at once: the other one's duty is the answer to both.
    const existing = apiRef && isUniqueViolation(err) ? await dutyByRef(ctx, apiRef) : null;
    if (existing) return filedAlready(existing);
    throw err;
  }
  await ctx.publish(project.key, id, { t: "duty", id, status: duty.status });
  if (internal.reviewNotes || review) await ctx.publish(project.key, null, { t: "notes" });
  if (review) await notifyNeedsYou(ctx, project, { ...duty, key: id }, duty.last_question);
  if (blocked) {
    // The interrupt released whoever it interrupted, in the same transaction.
    await ctx.publish(project.key, blocked, {
      t: "duty",
      id: blocked,
      status: "blocked",
      ag: agentEvent(agentId, null, now),
    });
  }

  return { duty_id: id, status: duty.status, priority, kind, reserved_for: reservedFor, blocked_duty_id: blocked, external_ref: externalRef };
}

/**
 * The role a newly filed duty starts with. On a board with a team that is whoever reads new duties
 * first, and nobody filing work chooses otherwise — except an agent splitting the duty it holds,
 * which has just worked out who each piece is for and may say so.
 */
async function filedRole(ctx, body, project, { kind, held, outsider }) {
  const wanted = str(body.role, "role", { max: 32, fallback: "" });
  if (!hasRoster(project) || kind !== "work") {
    if (wanted) throw badRequest("this board has no team, so there is no role to name");
    return null;
  }
  if (!wanted) return project.roster.intake;
  if (ctx.caller.kind !== "agent" || outsider) {
    throw forbidden("file the duty without 'role': on this board the role that reads new duties first decides who works them");
  }
  if (!held || held.status !== "active" || held.project_id !== project.key) {
    throw conflict("name a role only for work you are splitting out of the duty you hold");
  }
  const roster = await rosterInForce(ctx, project.key);
  if (!roster || !roster.roles.some((r) => r.id === wanted)) {
    throw badRequest(`this board has no role '${wanted}' — its roles are: ${roster ? roster.roles.map((r) => r.id).join(", ") : "none"}`);
  }
  return wanted;
}

/** Whose namespace an `external_ref` is in: the token, machine or person filing. Two integrations
 *  that both call their work "build-42" are two duties. */
const refOwner = (caller) => caller.crossBoard ? caller.crossBoard.refOwner : caller.tokenKey || caller.machineId || caller.uid || "";

async function dutyByRef(ctx, apiRef) {
  const { rows } = await ctx.store.query("duties", { where: [{ field: "api_ref", op: "=", value: apiRef }], limit: 1 });
  return rows[0] || null;
}

const filedAlready = (duty) => ({
  duty_id: duty.key,
  status: duty.status,
  priority: duty.priority,
  kind: duty.kind || "work",
  reserved_for: duty.reserved_for || null,
  blocked_duty_id: null,
  external_ref: duty.external_ref || null,
  existing: true,
});

/** The caller's own fields, carried on the duty and handed back on every read and webhook. Small,
 *  because it is stored on a row the console reads whole. */
const MAX_METADATA_BYTES = 2048;

function metadataFrom(v) {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw badRequest("'metadata' must be a JSON object");
  const json = JSON.stringify(v);
  if (json.length > MAX_METADATA_BYTES) throw badRequest(`'metadata' must be at most ${MAX_METADATA_BYTES} bytes as JSON`);
  return JSON.parse(json);
}

/**
 * Who a new duty is reserved for, if anyone.
 *
 * A machine may reserve work for itself — that is how a session that finds a missing tool asks
 * for a setup duty on its own computer. A person may reserve for any agent prefix.
 *
 * A project token may reserve for a machine linked to the board, and only that: a reservation to a
 * name no runner has would sit queued for ever with nothing to say why. A token the owner pinned to
 * one runner files everything there, and may not ask for anywhere else.
 */
async function reservation(ctx, body, projectKey) {
  const wanted = str(body.reserved_for, "reserved_for", { max: 64, fallback: "" });
  if (ctx.caller.kind === "human") return wanted || null;
  if (ctx.caller.machineId) {
    if (!wanted) return null;
    if (wanted !== ctx.caller.agentPrefix) {
      throw forbidden(`this machine can reserve work only for itself ('${ctx.caller.agentPrefix}')`);
    }
    return wanted;
  }
  const pin = ctx.caller.reserveFor || "";
  if (pin) {
    if (wanted && !reservedTo(pin, wanted)) throw forbidden(`this token's duties go to '${pin}' — the board's owner set that on the token`);
    return wanted || pin;
  }
  if (!wanted) return null;
  const prefixes = await runnerPrefixes(ctx, projectKey);
  if (!prefixes.some((p) => reservedTo(p, wanted))) {
    throw badRequest(
      prefixes.length
        ? `'reserved_for' must name one of this board's runners: ${prefixes.join(", ")}`
        : "this board has no runners to reserve work for — a person links a machine to it first",
    );
  }
  return wanted;
}

/**
 * A duty row for work the server files on its own — the rules duty a new board starts with, the
 * setup duty a newly linked machine gets. Returned as a put op so it lands in the caller's
 * transaction. Not counted against MAX_OPEN_DUTIES: each is bounded by what triggers it (one per
 * board, one per link).
 */
export function seedDuty(project, { title, brief, kind, priority = "next", reservedFor = null, now = Date.now(), fields = {} }) {
  const id = dutyId();
  const op = putOp("duties", id, {
    project_id: project.key,
    owner_uid: project.owner_uid,
    parent_id: null,
    title,
    brief,
    status: "queued",
    priority,
    prio_rank: RANK[priority],
    origin: "human",
    created_by: null,
    created_by_name: "DutyBoard",
    assigned_agent_id: null,
    outcome_summary: null,
    spawned_by: null,
    blocked_by: null,
    last_question: null,
    last_resolution: null,
    kind,
    reserved_for: reservedFor,
    affinity: null,
    lane: null,
    created_at: now,
    updated_at: now,
    // What filed it, where the caller needs that recorded on the row itself — a recurring duty
    // carries the occurrence it belongs to, under a unique index, so one occurrence files one duty.
    ...fields,
  });
  return { id, op };
}

/**
 * `POST /duty/checkpoint` — record a question, a note, or a milestone.
 *
 * With `set_status: "needs_decision"` this is the non-blocking pause: the question goes
 * on the duty's thread, the duty parks, and the agent is released to claim other work.
 */
export async function checkpointDuty(ctx, body) {
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const agentId = agentIdFrom(ctx, body, { required: false });
  const now = Date.now();

  if (body.set_status && (duty.kind === "note" || duty.approval_required)) throw forbidden("notes and unapproved suggestions cannot be activated; a person must approve the suggestion");
  const kind = oneOf(body.kind, "kind", THREAD_KINDS, "note");
  if (kind === "resolution" && ctx.caller.kind === "agent") {
    // Only a human resolves. Otherwise an agent could answer its own question and the
    // decision log would stop meaning what it says.
    throw forbidden("agents cannot post a 'resolution' — use /duty/resolve as a human");
  }
  const message = str(body.message, "message", { required: true, max: 4000 });
  const options = suggestedOptions(body.suggested_options);
  const setStatus = body.set_status
    ? oneOf(body.set_status, "set_status", ["needs_decision", "blocked", "active"])
    : null;
  // A session stopping as its duty is cancelled can still get a last call in. That must not bring
  // the duty back: only a person takes a duty out of a terminal state.
  if (setStatus && ctx.caller.kind !== "human" && (duty.status === "done" || duty.status === "failed")) {
    throw conflict(`duty '${duty.key}' is already ${duty.status}`, { status: duty.status });
  }

  // Built once and returned below. A caller that has just written an entry should not
  // have to re-read the thread to find out what it wrote — that read is the single most
  // common one this API serves, and it is entirely avoidable.
  const entryKey = threadId();
  const entry = {
    duty_id: duty.key,
    project_id: project.key,
    owner_uid: project.owner_uid,
    ...authorOf(ctx.caller, agentId),
    kind,
    message,
    metadata: options.length ? { suggested_options: options } : null,
    created_at: now,
  };
  // One duty's thread is the other unbounded write path: an agent that checkpoints in a
  // loop grows a single document set forever, and unlike duties nothing else ever prunes it.
  const entries = await ctx.store.countAtMost(
    "threads",
    [{ field: "duty_id", op: "=", value: duty.key }],
    MAX_THREAD_ENTRIES,
  );
  if (entries >= MAX_THREAD_ENTRIES) {
    throw badRequest(
      `duty '${duty.key}' already has ${MAX_THREAD_ENTRIES} thread entries, which is the ` +
        `limit. A duty needing this much discussion should be finished, failed, or split ` +
        `into smaller ones with /duty/enqueue.`,
    );
  }

  const ops = [putOp("threads", entryKey, entry)];

  let state = duty.status;
  let freed = null; // set when this checkpoint releases the agent, for the live payload
  if (setStatus && setStatus !== duty.status) {
    state = setStatus;
    // Leaving `active` releases the holder slot, in the same write that changes the status.
    const next = { ...stripMeta(duty), status: setStatus, updated_at: now };
    if (setStatus !== "active") {
      next.holder = null;
      next.lane = null;
      // A daemon parking this keeps it for the machine that has the worktree (see claimBlocker).
      // Only a machine can ask, and only for itself; everyone else's park leaves it open to all.
      if (body.affinity === true && ctx.caller.machineId) {
        next.affinity = {
          machine_id: ctx.caller.machineId,
          machine_name: (ctx.caller.machineRow && ctx.caller.machineRow.name) || "",
          at: now,
        };
      }
    }
    if (setStatus === "needs_decision") {
      next.last_question = options.length ? `${message} Options: ${options.join(" / ")}` : message;
      next.last_resolution = null;
    }
    ops.push(putOp("duties", duty.key, next));
    if (FREES_AGENT.has(setStatus) && agentId) {
      const aKey = agentKey(project.key, agentId);
      const agent = await ctx.store.get("agents", aKey);
      if (agent && agent.active_duty_id === duty.key) {
        ops.push(putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: null, last_seen_at: now }));
        freed = agentId;
      }
    }
  }

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, duty.key, {
    t: "thread",
    id: duty.key,
    status: state,
    ...(freed ? { ag: agentEvent(freed, null, now) } : {}),
  });
  if (setStatus === "needs_decision" && duty.status !== "needs_decision") {
    await notifyNeedsYou(ctx, project, duty, options.length ? `${message} (${options.join(" / ")})` : message);
  }
  return { ok: true, state, duty_id: duty.key, entry: { id: entryKey, ...entry } };
}

/**
 * `POST /duty/handoff` — `{ duty_id, to_role, note }`. The role holding a duty passes it to another.
 *
 * It stays the SAME duty: its thread, its files and — for a machine — the worktree its work is in
 * all carry over, which is the point. A builder hands work that has not landed to a reviewer who
 * verifies it where it sits, so nothing merges until it has been seen working; a reviewer hands it
 * straight back with findings, and the builder picks up the same branch.
 *
 * It goes back to the queue ahead of work nobody has started, since a duty in flight is worth
 * finishing first, and is kept for the machine that holds its workspace while that machine is around.
 *
 * Two handoffs stop for a person instead. A reviewer sending work back for the Nth time, where N is
 * the board's limit: two roles that cannot agree need someone to say what should change. And, when
 * the board asks for it, a plan: a person approves it before anyone builds it.
 */
export async function handoffDuty(ctx, body) {
  requireAgent(ctx.caller);
  if (ctx.caller.scope === "submit") throw forbidden("this credential works no duties, so it has none to hand on");
  const agentId = agentIdFrom(ctx, body, { required: true });
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const now = Date.now();

  if (duty.status !== "active" || duty.assigned_agent_id !== agentId) {
    throw conflict(`duty '${duty.key}' is not one you are holding`, { status: duty.status, assigned_agent_id: duty.assigned_agent_id || null });
  }
  const roster = (duty.kind || "work") === "work" ? await rosterInForce(ctx, project.key) : null;
  const from = roleFor(roster, duty);
  if (!from) throw conflict("this board has no team to hand a duty to — finish it yourself, or park it with a question");
  const toId = str(body.to_role, "to_role", { required: true, max: 32 });
  const to = roster.roles.find((r) => r.id === toId);
  const team = roster.roles.filter((r) => r.id !== from.id).map((r) => `'${r.id}' (${r.name})`).join(", ");
  if (!to) throw badRequest(`this board has no role '${toId}' — you can hand this duty to: ${team}`);
  if (to.id === from.id) throw badRequest(`you are ${from.name} already — hand it to another role (${team}), or carry on`);
  const note = str(body.note, "note", { required: true, max: 4000 });
  await unreadNotes(ctx, duty, "handoff");

  const settings = settingsFrom(roster.settings);
  const sentBack = !!from.reviews && !!to.reviewed;
  const bounces = (duty.bounces || 0) + (sentBack ? 1 : 0);
  const handoffs = (duty.handoffs || 0) + 1;
  const stuck = sentBack && bounces % settings.max_bounces === 0;
  const plan = settings.plan_approval && !!from.plans && !to.plans;
  // Passed around without ever being finished: any two roles can do this, not only a reviewer and a builder.
  const circling = !stuck && !plan && handoffs % settings.max_handoffs === 0;
  const question = stuck
    ? `${from.name} has sent this back to ${to.name} ${bounces} times. The latest findings:\n\n${note}\n\nWhat should change before ${to.name} tries again?`
    : plan
      ? `${from.name} proposes this plan for ${to.name} to build:\n\n${note}\n\nApprove it, or say what to change.`
      : circling
        ? `This duty has been handed from role to role ${handoffs} times without being finished. ${from.name}'s latest note, for ${to.name}:\n\n${note}\n\nWhat should happen to it?`
        : null;
  const machine = !!ctx.caller.machineId;
  const risk = riskAfter(duty, from, body, machine);
  // What only the machine that ran the session can say, and so is taken only from one: which model
  // did the work, and that the project's checks passed on what is being handed over.
  const workedWith = machine && body.worked_with && typeof body.worked_with === "object"
    ? { agent: str(body.worked_with.agent, "worked_with.agent", { max: 40 }), model: str(body.worked_with.model, "worked_with.model", { max: 160 }) }
    : null;
  const checks = machine && body.checks && typeof body.checks === "object" && body.checks.passed === true
    ? { command: str(body.checks.command, "checks.command", { max: 500 }), commit: str(body.checks.commit, "checks.commit", { max: 64 }), at: now }
    : null;
  const status = question ? "needs_decision" : "queued";
  const base = RANK[duty.priority] ?? RANK.next;

  const next = {
    ...stripMeta(duty),
    status,
    role: to.id,
    handoff: { from: from.id, from_name: from.name, to: to.id, note, sent_back: sentBack, at: now, ...(workedWith ? { worked_with: workedWith } : {}), ...(checks ? { checks } : {}) },
    handoffs,
    bounces,
    risk,
    // Ahead of fresh work at the same priority, behind anything more urgent.
    prio_rank: Math.min(duty.prio_rank ?? base, base - 0.5),
    holder: null,
    lane: null,
    // The work is in this machine's worktree; the next role picks it up there while it is around.
    affinity: ctx.caller.machineId
      ? { machine_id: ctx.caller.machineId, machine_name: (ctx.caller.machineRow && ctx.caller.machineRow.name) || "", at: now }
      : duty.affinity || null,
    ...(question ? { last_question: clip(question, 4000), last_resolution: null } : {}),
    updated_at: now,
  };
  const ops = [
    putOp("duties", duty.key, next),
    putOp("threads", threadId(), {
      duty_id: duty.key,
      project_id: project.key,
      owner_uid: project.owner_uid,
      ...authorOf(ctx.caller, agentId),
      kind: "checkpoint",
      message: note,
      metadata: {
        handoff: {
          from: from.id, from_name: from.name, to: to.id, to_name: to.name, sent_back: sentBack, risk,
          // What the machine said for itself: the model that did the work, and the tests it saw pass.
          ...(workedWith ? { worked_with: workedWith } : {}),
          ...(checks ? { checks: { command: checks.command, commit: checks.commit } } : {}),
        },
      },
      created_at: now,
    }),
    roleEventOp(project, duty, from, now, { stints: 1, ms: stintMs(duty, now), handoffs: 1 }),
  ];
  if (sentBack) ops.push(roleEventOp(project, duty, to, now, { sent_back: 1 }));
  // And the board remembers what its reviewers send back, for the next look at why (a retro duty).
  const retro = sentBack ? await noteSentBack(ctx, project, roster, duty, from, to, note, now, ops) : null;
  if (question) {
    ops.push(putOp("threads", threadId(), {
      duty_id: duty.key,
      project_id: project.key,
      owner_uid: project.owner_uid,
      author_type: "agent",
      author_id: "DutyBoard",
      kind: "question",
      message: stuck
        ? `${from.name} and ${to.name} have passed this back and forth ${bounces} times. What should change before it is tried again?`
        : plan
          ? `Approve ${from.name}'s plan before ${to.name} builds it?`
          : `This duty has been handed on ${handoffs} times without being finished. What should happen to it?`,
      metadata: plan ? { suggested_options: ["Approve the plan"] } : null,
      created_at: now + 1,
    }));
  }
  const aKey = agentKey(project.key, agentId);
  const agent = await ctx.store.get("agents", aKey);
  if (agent && agent.active_duty_id === duty.key) ops.push(putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: null, last_seen_at: now }));

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, duty.key, {
    t: "duty",
    id: duty.key,
    status,
    handoff: { from: from.id, to: to.id, sent_back: sentBack },
    ag: agentEvent(agentId, null, now),
  });
  if (question) await notifyNeedsYou(ctx, project, duty, question);
  if (retro) await ctx.publish(project.key, retro, { t: "duty", id: retro, status: "queued" });
  // A recurring duty remembers where the role that reads duties first sent it, so the next run goes
  // straight there instead of being read and routed again. After the handoff, and unable to fail it.
  if (duty.schedule_id && from.intake && !question) {
    await rememberRoute(ctx, duty.schedule_id, project.key, { role: to.id, risk, at: now }).catch((err) => console.log("remembering a schedule's route:", err && err.message));
  }

  return {
    ok: true,
    duty_id: duty.key,
    status,
    role: to.id,
    bounces,
    risk,
    message: question
      ? `Not handed on yet: a person is asked first${stuck ? " what should change" : plan ? " to approve the plan" : " what should happen to it"}. Stop this session now; ${to.name} takes it once they answer.`
      : `Handed to ${to.name}. It is no longer yours: stop this session now.`,
  };
}

const riskRank = (r) => Math.max(0, RISKS.indexOf(r || "normal"));

/**
 * How careful a duty's review should be after this handoff. The role that reads duties first, or one
 * that plans, sets it either way — they are the ones deciding what the work is. Anyone else may only
 * raise it. And a machine that saw the change touch one of the board's sensitive paths makes it high,
 * whatever anyone said.
 */
function riskAfter(duty, from, body, machine) {
  const current = duty.risk || "normal";
  if (machine && body.sensitive === true) return "high";
  if (body.risk == null || body.risk === "") return current;
  const wanted = oneOf(body.risk, "risk", RISKS);
  return from.intake || from.plans || riskRank(wanted) > riskRank(current) ? wanted : current;
}

/**
 * Remember a send-back on the board's roster row, as an op for the caller's transaction, and — every
 * `RETRO_EVERY` of them — file a retro duty to look at what keeps coming back. Answers the retro
 * duty's id when it filed one.
 */
async function noteSentBack(ctx, project, roster, duty, from, to, note, now, ops) {
  const recent = [...(roster.sent_backs || []), { duty_id: duty.key, title: duty.title, from: from.name, to: to.name, note: clip(note, 600), at: now }].slice(-SENT_BACKS_KEPT);
  let since = (roster.sent_back_since_retro || 0) + 1;
  let filed = null;
  if (since >= RETRO_EVERY && !(await hasUnfinished(ctx, project.key, [{ field: "kind", op: "=", value: "retro" }]))) {
    const seeded = seedDuty(project, { ...retroDuty(recent), kind: "retro", now });
    ops.push(seeded.op);
    filed = seeded.id;
    since = 0;
  }
  ops.push(putOp("rosters", project.key, { ...stripMeta(roster), sent_backs: recent, sent_back_since_retro: since }));
  return filed;
}

/** What a retro duty is asked: the send-backs it is about are in its brief, so it starts from them. */
export function retroDuty(sentBacks) {
  const listed = sentBacks.length
    ? sentBacks.map((b) => `- “${b.title}” (\`${b.duty_id}\`): ${b.from} sent it back to ${b.to} — ${b.note}`).join("\n")
    : "- none recorded yet: read the board's recent duties for work that was sent back or reopened.";
  return {
    title: "Look at what keeps being sent back",
    brief:
      "Reviewers on this board have sent work back these times lately:\n\n" +
      listed +
      "\n\nFind what they have in common — the same kind of finding more than once is a standard nobody was told, or one that is too vague to follow. " +
      "Read the duties' threads for the full findings (duty_thread), and any duty a person reopened. " +
      "Then propose the smallest changes that would have prevented them: to a role's charter (board_roster_submit, with the whole team), " +
      "to the project's rules (board_rules_submit, with the whole rules), or both. A person accepts each before it takes effect. " +
      "If nothing repeats, say so and change nothing.",
  };
}

/**
 * Refuse a claim on a duty that has used its board's allowance of agent session time, and ask a
 * person whether to go on. The duty parks with the question; answering it grants the same allowance
 * again. A bound on the bill, in the spirit of MAX_OPEN_DUTIES: hitting it means something is looping.
 */
async function withinBudget(ctx, duty, board, project, now) {
  const minutes = board && board.runner && board.runner.duty_minutes != null ? board.runner.duty_minutes : DEFAULT_DUTY_MINUTES;
  if (!minutes || (duty.kind || "work") !== "work") return;
  const usage = await ctx.store.get("duty_usage", duty.key);
  const used = (usage && usage.ms) || 0;
  const allowed = minutes * 60000 + (duty.budget_extra_ms || 0);
  if (used < allowed) return;
  const hours = (ms) => `${Math.round(ms / 360000) / 10}h`;
  const question = `Agents have spent ${hours(used)} of session time on this duty, over this board's limit of ${hours(allowed)} for one duty. Answer to let it go on for as long again — or cancel it, or say what should change.`;
  await ctx.store.transaction([
    putOp("duties", duty.key, { ...stripMeta(duty), status: "needs_decision", last_question: question, last_resolution: null, budget_asked_ms: minutes * 60000, holder: null, lane: null, updated_at: now }),
    putOp("threads", threadId(), { duty_id: duty.key, project_id: project.key, owner_uid: project.owner_uid, author_type: "agent", author_id: "DutyBoard", kind: "question", message: question, metadata: null, created_at: now }),
  ]);
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: "needs_decision" });
  await notifyNeedsYou(ctx, project, duty, question);
  throw conflict(`duty '${duty.key}' is over its board's limit of agent time and is waiting for a person to say whether it goes on`, { used_ms: used, allowed_ms: allowed });
}

/**
 * `POST /duty/usage` — `{ duty_id, ms }`. A machine says how long a session it ran on a duty lasted.
 *
 * Kept in a row of its own, never on the duty: the report arrives after the session, when the duty
 * may already be claimed by someone else, and a late write of the whole duty row would undo that.
 */
export async function reportUsage(ctx, body) {
  if (!ctx.caller.machineId) throw forbidden("only the machine that ran a session reports its time");
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const ms = intIn(body.ms, "ms", 0, 24 * 60 * 60 * 1000, 0);
  const row = await ctx.store.get("duty_usage", duty.key);
  const next = { project_id: project.key, owner_uid: project.owner_uid, duty_id: duty.key, ms: ((row && row.ms) || 0) + ms, sessions: ((row && row.sessions) || 0) + 1, updated_at: Date.now() };
  await ctx.store.putOne("duty_usage", duty.key, next);
  return { ok: true, duty_id: duty.key, ms: next.ms, sessions: next.sessions };
}

/**
 * When the last piece of a split duty finishes, file one more: check the pieces together.
 *
 * A role that splits a duty finishes its own with the plan, and each piece is then built and
 * reviewed on its own — so nothing ever asked whether the pieces, together, did what the original
 * asked for. This asks it once, of a reviewer, when `finishing` is the last of them (or is the split
 * duty itself, finishing after all its pieces). Answers ops for the caller's transaction, and the new
 * duty's id.
 */
async function acceptanceOps(ctx, project, finishing, roster, now) {
  const parentKey = finishing.split_from || finishing.key;
  const parent = finishing.split_from ? await ctx.store.get("duties", finishing.split_from) : finishing;
  // Checked once; and a check of the whole that itself files follow-ups is not checked again in turn.
  if (!parent || parent.acceptance_duty_id || parent.acceptance_of) return { ops: [], id: null };
  // The split duty has to be finished too: while its role is still filing pieces, the count is not final.
  if (finishing.split_from && parent.status !== "done" && parent.status !== "failed") return { ops: [], id: null };
  const { rows } = await ctx.store.query("duties", {
    where: [{ field: "project_id", op: "=", value: project.key }, { field: "split_from", op: "=", value: parentKey }],
    limit: 50,
  });
  const pieces = rows.map((d) => (d.key === finishing.key ? finishing : d));
  if (!pieces.length || pieces.some((d) => d.key !== finishing.key && UNFINISHED.includes(d.status))) return { ops: [], id: null };
  const stateOf = (d) => (d.key === finishing.key ? finishing.outcome_status : d.status);
  // Nothing was delivered — every piece failed or was cancelled — so there is no whole to check.
  if (!pieces.some((d) => stateOf(d) === "done")) return { ops: [], id: null };

  const reviewer = roster && (roster.roles.find((r) => r.reviews) || intakeOf(roster));
  const listed = pieces
    .map((d) => `- “${d.title}” (\`${d.key}\`, ${stateOf(d)}): ${clip(d.key === finishing.key ? finishing.outcome_text : d.outcome_summary || "no outcome recorded", 300)}`)
    .join("\n");
  const seeded = seedDuty(project, {
    title: clip(`Check the whole: ${parent.title}`, 200),
    brief: clip(
      `“${parent.title}” was split into ${pieces.length} ${pieces.length === 1 ? "piece" : "pieces"}, and the last of them has now finished. Each was built and reviewed on its own. ` +
        "Check what nobody has yet: that together they deliver what was originally asked. Use it the way the person who asked would, on what has actually landed; do not review each piece again.\n\n" +
        `**Originally asked**\n\n${parent.brief}\n\n**The pieces**\n\n${listed}\n\n` +
        "If it holds together, complete this duty saying what you checked. If something is missing or the pieces do not fit, file what is needed with duty_enqueue — saying what and why — and name it in your outcome.",
      4000,
    ),
    kind: "work",
    now,
    fields: { role: reviewer ? reviewer.id : null, acceptance_of: parentKey, risk: "high", agent_options: null },
  });
  const ops = [seeded.op];
  // Marked on the split duty, so a piece reopened and finished again does not file a second check.
  if (parent.key !== finishing.key) ops.push(putOp("duties", parent.key, { ...stripMeta(parent), acceptance_duty_id: seeded.id }));
  return { ops, id: seeded.id, onSelf: parent.key === finishing.key };
}

/** `POST /duty/complete` — active → done, with the summary that outlives the run. */
export async function completeDuty(ctx, body) {
  return finishDuty(ctx, body, "done");
}

/** `POST /duty/fail` — the honest end. Not in the happy path, but `failed` is a
 *  state in the spec and a duty that cannot be done must be able to reach it. */
export async function failDuty(ctx, body) {
  return finishDuty(ctx, body, "failed");
}

/**
 * `POST /duty/cancel` — call a duty off.
 *
 * It ends `failed`, not deleted: the record of what was asked and why it was called off stays on
 * the board, and the webhook says so like any other ending.
 *
 * A person on the board may cancel a duty in any unfinished state. The status change is what stops
 * the work: the daemon holding it ends the session and everything it started, then removes the
 * duty's worktree or folder, and says so on the thread.
 *
 * The token that filed a duty may take it back too, but only while nobody is working it: a duty a
 * session holds is not that caller's to pull out from under it.
 */
export async function cancelDuty(ctx, body) {
  const caller = ctx.caller.kind === "human" ? ctx.caller : requireAgent(ctx.caller);
  const duty = await loadDuty(ctx, body.duty_id);
  await projectOfDuty(caller, duty, ctx.store);
  const reason = str(body.reason, "reason", { max: 1000, fallback: "" });
  const said = reason ? `: ${reason}` : ".";
  if (caller.kind === "human") {
    return finishDuty(ctx, { duty_id: duty.key, reason: `Cancelled by ${caller.name}${said}` }, "failed", { duty, cancelled: true });
  }
  if (!caller.tokenKey || duty.filed_by_token !== caller.tokenKey) {
    throw forbidden(`duty '${duty.key}' was not filed by this token — only what it filed can it cancel`);
  }
  if (duty.status === "active") {
    throw conflict(`duty '${duty.key}' is being worked on — cancel it from the board, where whoever holds it can be stopped`, { status: duty.status });
  }
  return finishDuty(ctx, { duty_id: duty.key, reason: `Cancelled by ${caller.tokenName || "the token that filed it"}${said}` }, "failed", { duty, cancelled: true });
}

async function finishDuty(ctx, body, terminal, { duty: held, cancelled = false } = {}) {
  const duty = held || (await loadDuty(ctx, body.duty_id));
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const agentId = agentIdFrom(ctx, body, { required: false });
  const now = Date.now();

  if (duty.kind === "note") throw conflict("notes stay in the notes lane; delete a note to remove it");
  if (duty.approval_required && ctx.caller.kind !== "human") throw forbidden("only a person may approve or reject this suggestion");
  const summaryField = terminal === "done" ? "outcome_summary" : "reason";
  const summary = str(body[summaryField] ?? body.outcome_summary, summaryField, { required: true, max: 4000 });

  if (duty.status === "done" || duty.status === "failed") {
    throw conflict(`duty '${duty.key}' is already ${duty.status}`, { status: duty.status });
  }
  if (duty.assigned_agent_id && agentId && duty.assigned_agent_id !== agentId) {
    throw forbidden(`duty '${duty.key}' is assigned to agent '${duty.assigned_agent_id}'`);
  }
  // On a board with a team, the role holding the duty decides whether it may be the one to finish it.
  const roster = duty.role && (duty.kind || "work") === "work" ? await rosterInForce(ctx, project.key) : null;
  const role = roleFor(roster, duty);
  if (role && role.reviewed && terminal === "done" && ctx.caller.kind === "agent" && duty.status === "active") {
    const reviewers = roster.roles.filter((r) => r.reviews);
    if (reviewers.length) {
      throw conflict(
        `as ${role.name} you do not finish this duty yourself: its work is verified first. Hand it on with duty_handoff to ` +
          `${reviewers.map((r) => `'${r.id}' (${r.name})`).join(" or ")}, with a note saying what changed, how you tested it and what to look at first. ` +
          `Nothing is landed or completed until they pass it.`,
        { role: role.id, hand_to: reviewers.map((r) => r.id) },
      );
    }
  }
  if (ctx.caller.kind === "agent" && duty.status === "active") await unreadNotes(ctx, duty, terminal);

  const ops = [
    putOp("duties", duty.key, {
      ...stripMeta(duty),
      status: terminal,
      outcome_summary: summary,
      holder: null,
      lane: null,
      affinity: null,
      expires_at: expiresAt(duty, terminal, now),
      finished_at: now,
      updated_at: now,
    }),
    putOp("threads", threadId(), {
      duty_id: duty.key,
      project_id: project.key,
      owner_uid: project.owner_uid,
      ...authorOf(ctx.caller, agentId),
      kind: "checkpoint",
      message: summary,
      metadata: { terminal },
      created_at: now,
    }),
  ];
  // Work that ended, counted for the boards page. A cancellation is somebody changing their mind
  // and a rejected suggestion was never work, so neither is counted as work that failed.
  if (!cancelled && !duty.approval_required) ops.push(finishOp(project, duty, terminal, now));
  // And for the team's own record: who finished it, and — when it is done — that every builder whose
  // work it carried got it past review, at the first attempt or not.
  if (!cancelled && role && ctx.caller.kind === "agent") {
    ops.push(roleEventOp(project, duty, role, now, { stints: 1, ms: stintMs(duty, now), [terminal]: 1 }));
    if (terminal === "done") {
      for (const built of roster.roles.filter((r) => r.reviewed && (duty.role_trail || []).includes(r.id))) {
        ops.push(roleEventOp(project, duty, built, now, { passed: 1, first_pass: duty.bounces ? 0 : 1 }));
      }
    }
  }

  // The last piece of a split duty: one more duty, to check the pieces together. Only a board with a
  // team splits work between roles, so only a duty that has a role is looked at.
  const whole = roster && !duty.acceptance_of
    ? await acceptanceOps(ctx, project, { ...duty, outcome_status: terminal, outcome_text: summary }, roster, now)
    : { ops: [], id: null };
  ops.push(...whole.ops);
  if (whole.onSelf) ops[0].data.acceptance_duty_id = whole.id;

  const holder = agentId || duty.assigned_agent_id;
  let freed = null;
  if (holder) {
    const aKey = agentKey(project.key, holder);
    const agent = await ctx.store.get("agents", aKey);
    if (agent && agent.active_duty_id === duty.key) {
      ops.push(putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: null, last_seen_at: now }));
      freed = holder;
    }
  }

  // Finishing a child that something is blocked behind puts the parent back at the front
  // of the queue. Without this the interrupt pattern is a one-way trip: the parent would
  // sit in `blocked` forever with nothing left to unblock it.
  const parent = await unblockParent(ctx, duty, now, ops);
  // And everything blocked behind it that is not its parent — the duties a setup paused — whether it
  // finished or failed: a failed setup must not hold the board for ever.
  const waiting = (await unblockWaiting(ctx, duty, now, ops)).filter((id) => id !== parent);

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, duty.key, {
    t: "duty",
    id: duty.key,
    status: terminal,
    ...(freed ? { ag: agentEvent(freed, null, now) } : {}),
  });
  if (parent) await ctx.publish(project.key, parent, { t: "duty", id: parent, status: "queued" });
  for (const id of waiting) await ctx.publish(project.key, id, { t: "duty", id, status: "queued" });
  if (whole.id) await ctx.publish(project.key, whole.id, { t: "duty", id: whole.id, status: "queued" });

  // After the transaction, never inside it: making a duty findable must not be able to fail
  // finishing one. This is the moment the outcome summary exists, which is the whole reason
  // a finished duty is worth finding.
  await indexFinished(ctx, duty, project, terminal, summary);
  // And, if a schedule filed this duty, what it should tell the next run. Same reasoning as the
  // line above: after the transaction, and unable to fail the finish.
  await noteScheduleOutcome(ctx, duty, summary);

  return { ok: true, status: terminal, duty_id: duty.key, unblocked_duty_id: parent };
}

/**
 * `POST /duty/quiet` — a scheduled duty whose check found nothing to do.
 *
 * The machine holding it ran the schedule's check, which exited cleanly and printed nothing, so no
 * session is started and the duty is removed rather than finished: a check every fifteen minutes
 * would otherwise fill the Done column with runs that did nothing. The schedule counts it instead.
 * Refused once a person has written on the duty — they asked for something, so an agent wakes.
 */
export async function quietDuty(ctx, body) {
  const agentId = agentIdFrom(ctx, body, { required: true });
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  if (!ctx.caller.machineId) throw forbidden("only the machine that ran a duty's check can say it found nothing");
  if (!duty.check || duty.status !== "active" || duty.assigned_agent_id !== agentId) {
    throw conflict(`duty '${duty.key}' is not a checked duty that '${agentId}' holds`, { status: duty.status });
  }
  if ((await peopleNotes(ctx, duty.key)).length) {
    throw conflict(`a person wrote on duty '${duty.key}', so it is worked even though its check found nothing`, { notes: true });
  }
  await removeDuty(ctx, duty, project.key);
  await noteQuietRun(ctx, duty);
  return { ok: true, removed: duty.key };
}

/** How many of a duty's notes a claim carries: the newest, which are the ones still likely to matter. */
const NOTES_ON_CLAIM = 10;

/** The notes people have written on a duty, oldest first — what a session starting on it is shown. */
async function peopleNotes(ctx, dutyKey) {
  const { rows } = await ctx.store.query("threads", {
    where: [{ field: "duty_id", op: "=", value: dutyKey }],
    order: [{ field: "created_at", dir: "desc" }],
    limit: MAX_THREAD_ENTRIES,
  });
  return rows
    .filter((t) => t.author_type === "human" && t.kind === "note")
    .slice(0, NOTES_ON_CLAIM)
    .reverse()
    .map((t) => ({ from: t.author_name || "a person", message: t.message, created_at: t.created_at }));
}

/**
 * Refuses an agent's finish while people have written on the duty since its session was shown the
 * notes — a person who adds "also do X" while the work is under way would otherwise watch it be
 * marked done without X. The refusal carries the notes, and counts as showing them: the next
 * finish goes through unless someone writes again.
 */
async function unreadNotes(ctx, duty, terminal) {
  const verb = { done: "completed", failed: "failed", handoff: "handed on" }[terminal];
  const again = terminal === "handoff" ? "duty_handoff" : `duty_${terminal === "done" ? "complete" : "fail"}`;
  const { rows } = await ctx.store.query("threads", {
    where: [
      { field: "duty_id", op: "=", value: duty.key },
      { field: "created_at", op: ">", value: duty.notes_seen_at || 0 },
    ],
    order: [{ field: "created_at", dir: "asc" }],
    limit: MAX_THREAD_ENTRIES,
  });
  const notes = rows.filter((t) => t.author_type === "human" && t.kind === "note");
  if (!notes.length) return;
  const seen = notes[notes.length - 1].created_at;
  await ctx.store.transaction([putOp("duties", duty.key, { ...stripMeta(duty), notes_seen_at: seen })]);
  const listed = notes.map((t) => `- ${t.author_name || "A person"}: ${t.message}`).join("\n");
  throw conflict(
    `not ${verb} yet — a person wrote on this duty while you were working on it:\n` +
      `${listed}\n` +
      `Do what the note${notes.length > 1 ? "s ask" : " asks"} first. If that changes the work, land it again (commit and ` +
      `duty_integrate, put it in out/, or make it through the board's MCP servers), then call ${again} again — this refusal will not repeat for the same notes.`,
    { notes: notes.length },
  );
}

/**
 * `POST /duty/reopen` — done was wrong. Back to the queue, with a note saying why.
 *
 * The one transition out of a terminal state, and the reason it exists is that `done` is an
 * agent's claim, not a fact. Something ships, you use it, it does not work — and until now
 * the only moves were to edit the status by hand, which says nothing about what went wrong
 * and leaves the duty findable in search as finished work, or to file a new duty, which
 * starts a fresh history for the same job and loses the thread that explains it.
 *
 * The note is REQUIRED. A duty that comes back with no reason is worse than one that never
 * came back: the next agent to claim it re-reads an outcome summary saying the work is done,
 * and has nothing to tell it otherwise. So the note goes on the thread AND onto the row,
 * where `poll` and `claim` carry it into the agent's context without a thread fetch.
 *
 * HUMAN ONLY, like resolve. An agent that finds a problem in finished work enqueues a duty
 * for it — that is what the operating protocol tells it to do, and it keeps the board's
 * history honest: reopening is a verdict on somebody's work, and the person whose board it
 * is gets to pass it. It is also the one thing here that could loop: an agent able to
 * revive its own failures could churn a board forever, and no cap makes that behaviour
 * anything but a bug.
 */
export async function reopenDuty(ctx, body) {
  requireHuman(ctx.caller);
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const now = Date.now();
  const note = str(body.note ?? body.reason, "note", { required: true, max: 4000 });

  if (duty.status !== "done" && duty.status !== "failed") {
    throw conflict(`duty '${duty.key}' is ${duty.status}, so there is nothing to reopen`, { status: duty.status });
  }

  if (duty.approval_required) throw conflict("this suggestion was not approved; request a new suggestion from its note");

  // Reopening moves a duty from the finished pile back into the unfinished one, so it is
  // held to the same bound as creating one. Counted before anything is written.
  const open = await ctx.store.countAtMost(
    "duties",
    [
      { field: "project_id", op: "=", value: project.key },
      { field: "status", op: "in", value: UNFINISHED },
    ],
    MAX_OPEN_DUTIES,
  );
  if (open >= MAX_OPEN_DUTIES) {
    throw badRequest(
      `this board already has ${MAX_OPEN_DUTIES} unfinished duties, which is the limit. ` +
        `Finish or delete some before sending this one back.`,
    );
  }

  // Front of the queue by default: work that was delivered and does not work is the most
  // urgent thing on most boards, and it is why somebody is looking at this screen.
  const priority = oneOf(body.priority, "priority", PRIORITIES, "immediate_blocker");
  const terminal = duty.status;
  // Work a person sent back starts again with whoever reads new duties first, who has the note saying
  // why and decides who should take it — and it counts against every role it had passed through.
  const roster = duty.role && (duty.kind || "work") === "work" ? await rosterInForce(ctx, project.key) : null;
  const usage = await ctx.store.get("duty_usage", duty.key);
  const usedMs = (usage && usage.ms) || 0;

  const ops = [
    putOp("threads", threadId(), {
      duty_id: duty.key,
      project_id: project.key,
      owner_uid: project.owner_uid,
      ...authorOf(ctx.caller),
      kind: "reopen",
      message: note,
      metadata: { reopened_from: terminal },
      created_at: now,
    }),
    putOp("duties", duty.key, {
      ...stripMeta(duty),
      status: "queued",
      priority,
      prio_rank: RANK[priority],
      // What it claimed, kept — but not as `outcome_summary`, which on this board means
      // "this is finished and here is what happened". Leaving it there would put an outcome
      // on a queued duty and show a green Outcome panel above a duty nobody has redone.
      outcome_summary: null,
      previous_outcome: duty.outcome_summary || duty.previous_outcome || null,
      reopen_note: note,
      reopened_from: terminal,
      reopened_at: now,
      finished_at: null,
      // Not a cap, a signal. Nothing refuses the fourth reopen — a person doing this is
      // paying attention by definition — but a duty that keeps coming back is worth being
      // able to see is coming back, on the duty and in the thread.
      reopen_count: (duty.reopen_count || 0) + 1,
      // A person asking for it again is a person saying it is worth more time: the allowance of
      // agent time counts from here, not from the first attempt.
      budget_extra_ms: usedMs,
      budget_asked_ms: 0,
      holder: null,
      lane: null,
      // Redone from scratch, in a fresh worktree: whatever the last one left is the old attempt.
      affinity: null,
      // Not finished any more, so not on its way off the board either.
      expires_at: null,
      updated_at: now,
      ...(roster ? { role: intakeOf(roster).id, handoff: null } : {}),
    }),
  ];
  if (roster && terminal === "done") {
    for (const worked of roster.roles.filter((r) => (duty.role_trail || []).includes(r.id) && !r.intake)) {
      ops.push(roleEventOp(project, duty, worked, now, { reopened: 1 }));
    }
  }

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: "queued" });

  // Out of the finished index, best-effort like everything else search does. It is not
  // finished any more, and a search for completed work that returns something sitting in
  // the queue is how an agent concludes a thing is done when it is not.
  await unindexDuties(ctx, [duty.key]);

  return { ok: true, status: "queued", duty_id: duty.key, priority, reopened_from: terminal, reopen_count: (duty.reopen_count || 0) + 1 };
}

/**
 * `POST /duty/resolve` — the human half of the loop.
 *
 * Appends the resolution to the thread and puts the duty back at the top of the queue
 * with the answer bound onto the row, so the next `poll` carries it without a lookup.
 */
export async function resolveDuty(ctx, body) {
  requireHuman(ctx.caller);
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const now = Date.now();
  if (duty.kind === "note") throw conflict("use Suggest duties to review a note");
  if (duty.approval_required && (body.approve !== true || duty.status !== "needs_decision")) throw conflict("explicitly approve this suggestion before queueing it");
  const text = str(body.resolution_text ?? body.message, "resolution_text", { required: true, max: 4000 });

  if (duty.status === "done" || duty.status === "failed") {
    throw conflict(`duty '${duty.key}' is already ${duty.status}`, { status: duty.status });
  }

  const ops = [
    putOp("threads", threadId(), {
      duty_id: duty.key,
      project_id: project.key,
      owner_uid: project.owner_uid,
      ...authorOf(ctx.caller),
      kind: "resolution",
      message: text,
      metadata: null,
      created_at: now,
    }),
    putOp("duties", duty.key, {
      ...stripMeta(duty),
      status: "queued",
      priority: duty.approval_required ? duty.priority : "immediate_blocker",
      prio_rank: duty.approval_required ? RANK[duty.priority] : RANK.immediate_blocker,
      last_resolution: text,
      approval_required: false,
      ...(duty.approval_required ? { approved_by: ctx.caller.uid, approved_at: now } : {}),
      // Asked whether a duty over its time limit should go on: the answer grants the same allowance again.
      ...(duty.budget_asked_ms ? { budget_extra_ms: (duty.budget_extra_ms || 0) + duty.budget_asked_ms, budget_asked_ms: 0 } : {}),
      resolved_at: now,
      holder: null,
      lane: null,
      updated_at: now,
    }),
  ];

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: "queued" });
  return { ok: true, status: "queued", duty_id: duty.key };
}

/** `POST /duty/update` — the board's own edit path (title, brief, priority, status). */
export async function updateDuty(ctx, body) {
  requireHuman(ctx.caller);
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const now = Date.now();
  const next = { ...stripMeta(duty), updated_at: now };

  if (Object.hasOwn(body, "agent_options")) next.agent_options = dutyAgentOptions(body.agent_options);
  if (body.title != null) next.title = str(body.title, "title", { required: true, max: 200 });
  if (body.brief != null) next.brief = str(body.brief, "brief", { required: true, max: 4000 });
  if (body.priority != null) {
    next.priority = oneOf(body.priority, "priority", PRIORITIES);
    next.prio_rank = RANK[next.priority];
  }
  if (body.status != null) {
    next.status = oneOf(body.status, "status", STATUSES);
    if ((duty.kind === "note" || next.status === "note") && next.status !== duty.status) throw conflict("notes cannot be moved into the work queue");
    if (duty.approval_required && next.status !== duty.status) throw conflict("use Approve or Reject for this suggestion");
    if (next.status !== "active") {
      next.assigned_agent_id = null;
      next.holder = null;
      next.lane = null;
    }
    if (next.status === "done" || next.status === "failed") next.affinity = null;
    if (next.status !== duty.status) next.finished_at = next.status === "done" || next.status === "failed" ? now : null;
  }
  if (body.expire_after_days != null) next.expire_after_days = expireDays(body.expire_after_days);
  // The clock starts when it is done, and stops when it no longer is; a new setting on a duty that is
  // already done counts from now.
  if (next.status !== duty.status || next.expire_after_days !== (duty.expire_after_days || 0)) {
    next.expires_at = expiresAt(next, next.status, now);
  }

  const ops = [putOp("duties", duty.key, next)];
  // Marked done by hand is still work done. Moved to failed by hand is a person calling it off,
  // which is what a cancellation is, and is not counted.
  if (next.status === "done" && duty.status !== "done") ops.push(finishOp(project, duty, "done", now));
  // Moving a duty off `active` by hand has to free whichever agent was holding it, or
  // that agent can never claim anything again.
  if (duty.assigned_agent_id && next.status !== "active") {
    const aKey = agentKey(project.key, duty.assigned_agent_id);
    const agent = await ctx.store.get("agents", aKey);
    if (agent && agent.active_duty_id === duty.key) {
      ops.push(putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: null, last_seen_at: now }));
    }
  }

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: next.status });

  // The status dropdown can also move a duty out of `done`, without a note and without
  // meaning to — `/duty/reopen` is the path that says why, but this one exists and has to
  // leave the same world behind it. A duty that is no longer finished must not still be in
  // the index of finished work.
  const wasTerminal = duty.status === "done" || duty.status === "failed";
  const isTerminal = next.status === "done" || next.status === "failed";
  if (wasTerminal && !isTerminal) await unindexDuties(ctx, [duty.key]);

  return { ok: true, duty_id: duty.key, status: next.status };
}

/** `POST /duty/delete` — remove a duty and its thread. People make mistakes. */
export async function deleteDuty(ctx, body) {
  requireHuman(ctx.caller);
  const duty = await loadDuty(ctx, body.duty_id);
  // Owner only. A member does the work on a board; removing work, and its whole decision log,
  // is the owner's call.
  const project = await projectOfDuty(ctx.caller, duty, ctx.store, { ownerOnly: true });
  await removeDuty(ctx, duty, project.key);
  return { ok: true, deleted: duty.key };
}

/**
 * A duty and everything that hangs off it — its thread, its files, its place in search — gone, and
 * whatever it was holding up let go. What a person deleting it and a finished duty expiring share.
 */
async function removeDuty(ctx, duty, projectKey) {
  const project = { key: projectKey };
  for (const field of ["duty_id", "note_id"]) {
    for (;;) {
      const { rows } = await ctx.store.query("note_sources", { where: [{ field, op: "=", value: duty.key }], limit: 200, keys_only: true });
      if (!rows.length) break;
      await ctx.store.delete("note_sources", rows.map(r => r.key));
      if (rows.length < 200) break;
    }
  }
  // Threads are keyed independently of the duty, so they have to be swept explicitly.
  // Bounded per call and repeated until empty rather than assuming one page is all there is.
  for (;;) {
    const { rows } = await ctx.store.query("threads", {
      where: [{ field: "duty_id", op: "=", value: duty.key }],
      order: [{ field: "created_at", dir: "asc" }],
      limit: 200,
      keys_only: true,
    });
    if (!rows.length) break;
    await ctx.store.delete("threads", rows.map((r) => r.key));
    if (rows.length < 200) break;
  }
  // And its files. Leaving the objects behind would be a slow leak nobody can see: the
  // rows that named them are gone, so nothing would ever list them again.
  await sweepAttachments(ctx, { field: "duty_id", value: duty.key });
  await unindexDuties(ctx, [duty.key]);
  // The time its sessions took, kept in a row of its own (see reportUsage).
  await ctx.store.delete("duty_usage", [duty.key]);
  await ctx.store.delete("duties", [duty.key]);
  // Deleting a setup a board was waiting on lets the board go again.
  const released = [];
  const waiting = await unblockWaiting(ctx, duty, Date.now(), released);
  if (released.length) await ctx.store.transaction(released);
  for (const id of waiting) await ctx.publish(project.key, id, { t: "duty", id, status: "queued" });
  // A duty deleted while held frees whoever held it, or that agent can never claim again.
  if (duty.status === "active" && duty.assigned_agent_id) {
    const aKey = agentKey(project.key, duty.assigned_agent_id);
    const agent = await ctx.store.get("agents", aKey);
    if (agent && agent.active_duty_id === duty.key) {
      await ctx.store.putOne("agents", aKey, { ...stripMeta(agent), active_duty_id: null, last_seen_at: Date.now() });
    }
  }
  // The row is gone by now; the webhook (webhooks.js) is handed the one this started with.
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: "deleted" }, duty);
}

/** Finished duties removed per run of the function's clock; the rest go on the next, a minute later.
 *  Each removal is several calls, and a run of the function may make only so many. */
const EXPIRE_PER_TICK = 20;

/** Remove the finished duties whose time on the board is up. Answers how many went. */
export async function sweepExpiredDuties(ctx, now = Date.now(), limit = EXPIRE_PER_TICK) {
  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "expires_at", op: ">", value: 0 },
      { field: "expires_at", op: "<=", value: now },
    ],
    order: [{ field: "expires_at", dir: "asc" }],
    limit,
  });
  let removed = 0;
  for (const duty of rows) {
    // Read as it stands: one reopened since the query is not done any more.
    if (duty.status !== "done") continue;
    try {
      await removeDuty(ctx, duty, duty.project_id);
      removed++;
    } catch (err) {
      console.log(`expiring ${duty.key}:`, err && err.message);
    }
  }
  return removed;
}

// --- finishes ---------------------------------------------------------------
//
// One small row per duty that ended, for the boards page's "finished per day". Counting the duty
// rows themselves cannot answer that: a board that removes done duties a day after they finish
// would only ever show today, and a deleted duty would take its history with it. These outlive
// both, for FINISHES_KEPT_MS.
//
// `hour` is the hour since the epoch the duty finished in. It is what the console groups on: a
// fortnight is 336 of them, inside one aggregate's 500 groups, and the browser folds hours into
// days in its own timezone — which the function does not know and a stored date would get wrong.

const HOUR_MS = 60 * 60 * 1000;
export const FINISHES_KEPT_MS = 90 * DAY_MS;
const FINISHES_SWEPT_PER_TICK = 100;

/**
 * The row that counts one finish. Keyed by the duty and how many times it has been reopened, so a
 * duty sent back and finished again counts each time it was finished, and a retried finish of the
 * same one writes the same row rather than a second.
 */
export function finishOp(project, duty, terminal, now) {
  return putOp("finishes", `${duty.key}-${duty.reopen_count || 0}`, {
    project_id: project.key,
    owner_uid: project.owner_uid,
    duty_id: duty.key,
    kind: duty.kind || null,
    agent_id: duty.assigned_agent_id || null,
    // Numbers rather than a status, so one aggregate sums both per hour instead of grouping by
    // status, which would double the groups and pass the 500 an aggregate returns.
    done: terminal === "done" ? 1 : 0,
    failed: terminal === "failed" ? 1 : 0,
    hour: Math.floor(now / HOUR_MS),
    claimed_at: duty.claimed_at || null,
    finished_at: now,
  });
}

/** Forget finishes older than the boards page ever shows. Answers how many went. */
export async function sweepOldFinishes(ctx, now = Date.now(), limit = FINISHES_SWEPT_PER_TICK) {
  const { rows } = await ctx.store.query("finishes", {
    where: [{ field: "finished_at", op: "<", value: now - FINISHES_KEPT_MS }],
    keys_only: true,
    limit,
  });
  if (!rows.length) return 0;
  await ctx.store.delete("finishes", rows.map((r) => r.key));
  return rows.length;
}

/** How long the role holding a duty has had it, for the team's record. */
const stintMs = (duty, now) => (duty.claimed_at ? Math.max(0, now - duty.claimed_at) : 0);

/**
 * One line of a role's record: a stint it worked, work of its that passed or was sent back, a duty
 * of its a person reopened. Append-only and all numbers, like `finishes`, so the console sums them
 * with one aggregate and two things happening at once never overwrite each other.
 */
export function roleEventOp(project, duty, role, now, counts) {
  return putOp("role_events", `re_${ulid(now)}`, {
    project_id: project.key,
    owner_uid: project.owner_uid,
    duty_id: duty.key,
    role: role.id,
    role_name: role.name,
    stints: 0,
    ms: 0,
    handoffs: 0,
    done: 0,
    failed: 0,
    passed: 0,
    first_pass: 0,
    sent_back: 0,
    reopened: 0,
    ...counts,
    hour: Math.floor(now / HOUR_MS),
    at: now,
  });
}

/** Forget role events as old as the finishes the boards page has stopped counting. */
export async function sweepOldRoleEvents(ctx, now = Date.now(), limit = FINISHES_SWEPT_PER_TICK) {
  const { rows } = await ctx.store.query("role_events", {
    where: [{ field: "at", op: "<", value: now - FINISHES_KEPT_MS }],
    keys_only: true,
    limit,
  });
  if (!rows.length) return 0;
  await ctx.store.delete("role_events", rows.map((r) => r.key));
  return rows.length;
}

// --- helpers --------------------------------------------------------------

export async function loadDuty(ctx, id) {
  const key = str(id, "duty_id", { required: true, max: 64 });
  const duty = await ctx.store.get("duties", key);
  if (!duty) throw notFound(`duty '${key}' not found`);
  // This does NOT check ownership. Every caller must follow it with `projectOfDuty`,
  // which does — and which is free, so there is no reason not to. The previous version of
  // this comment asserted that every caller already did; one of them did not, and reading
  // any board's decision log was a matter of naming a duty id.
  return duty;
}

async function unblockParent(ctx, duty, now, ops) {
  if (!duty.parent_id) return null;
  const parent = await ctx.store.get("duties", duty.parent_id);
  if (!parent || parent.status !== "blocked" || parent.blocked_by !== duty.key) return null;
  ops.push(
    putOp("duties", parent.key, {
      ...stripMeta(parent),
      status: "queued",
      priority: "immediate_blocker",
      prio_rank: RANK.immediate_blocker,
      blocked_by: null,
      holder: null,
      lane: null,
      updated_at: now,
    }),
  );
  return parent.key;
}

/** The datastore's answer when a unique index refuses a write. Matched on both the code and
 *  the message because this arrives across an RPC boundary and only one of them may survive. */
function isUniqueViolation(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  return code === "ALREADY_EXISTS" || /unique constraint/i.test(String((err && err.message) || ""));
}

function agentIdFrom(ctx, body, { required }) {
  const id = str(body.agent_id ?? ctx.defaultAgentId, "agent_id", { max: 64, fallback: "" });
  if (!id && required) throw badRequest("'agent_id' is required");
  return checkAgentId(ctx.caller, id);
}

async function touchAgent(ctx, project, agentId) {
  const key = agentKey(project.key, agentId);
  const existing = await ctx.store.get("agents", key);
  const now = Date.now();
  await ctx.store.putOne("agents", key, {
    ...(existing ? stripMeta(existing) : newAgent(project, agentId, now)),
    last_seen_at: now,
  });
}

// `owner_uid` is here for the console's sake, not this code's: the browser reads agent
// rows directly, and its row rule matches on exactly that field.
const newAgent = (project, agentId, now) => ({
  project_id: project.key,
  owner_uid: project.owner_uid,
  agent_id: agentId,
  active_duty_id: null,
  created_at: now,
  last_seen_at: now,
});

function suggestedOptions(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw badRequest("'suggested_options' must be an array of strings");
  return v.slice(0, 8).map((o, i) => str(o, `suggested_options[${i}]`, { required: true, max: 200 }));
}

/** Drop the fields `flat()` added so a re-put writes the document and not our envelope. */
export function stripMeta(doc) {
  const { key, _created, _updated, ...data } = doc;
  return data;
}

/**
 * The distilled form an agent receives. This is the token budget: title, a clipped
 * brief, how urgent, and — the part that makes the loop non-blocking — the question and
 * the answer, so a resumed duty carries its own context.
 */
function briefOf(duty, { full = false } = {}) {
  const out = {
    id: duty.key,
    title: duty.title,
    brief: full ? duty.brief : clip(duty.brief, BRIEF_IN_POLL),
    priority: duty.priority,
    origin: duty.origin,
    kind: duty.kind || "work",
    agent_options: duty.agent_options ?? null,
    unblocked_context: null,
  };
  if (duty.origin_board_id) { out.origin_board_id = duty.origin_board_id; out.origin_duty_id = duty.origin_duty_id || null; }
  if (duty.source_note_id) out.source_note_id = duty.source_note_id;
  if (sourceNoteIDs(duty).length) out.source_note_ids = sourceNoteIDs(duty);
  if (duty.review_scope) out.review_scope = duty.review_scope;
  if (duty.note_position) out.note_position = duty.note_position;
  if (duty.kind === "note") out.review_duty_id = duty.review_duty_id || null;
  if (duty.approval_required) out.approval_required = true;
  if (duty.reserved_for) out.reserved_for = duty.reserved_for;
  // Who on the board's team has it, and what the last role said when handing it on.
  if (duty.role) out.role = duty.role;
  if (duty.risk && duty.risk !== "normal") out.risk = duty.risk;
  // The note is the next role's brief, so the duty in hand carries it whole; the queue only says a
  // handoff happened, like the clipped brief beside it.
  if (duty.handoff) out.handoff = full ? duty.handoff : { from: duty.handoff.from, to: duty.handoff.to, sent_back: !!duty.handoff.sent_back };
  if (duty.last_resolution) {
    out.unblocked_context = {
      last_question: duty.last_question || null,
      human_resolution: duty.last_resolution,
    };
  }
  // A duty that was finished and came back. This is the difference between an agent
  // redoing the work from the brief and an agent reading what the last attempt claimed,
  // then the one line saying why that was wrong — which is the whole reason the note is
  // required and lives on the row rather than only on the thread.
  if (duty.reopen_note) {
    out.reopened = {
      note: duty.reopen_note,
      previously: duty.reopened_from || "done",
      previous_outcome: duty.previous_outcome || null,
      times: duty.reopen_count || 1,
    };
  }
  // A scheduled duty with a check: the machine that claims it runs the check before any session.
  if (duty.check) {
    out.check = duty.check;
    out.schedule_id = duty.schedule_id || null;
  }
  if (full) {
    out.status = duty.status;
    out.parent_id = duty.parent_id || null;
    out.assigned_agent_id = duty.assigned_agent_id || null;
  }
  return out;
}
