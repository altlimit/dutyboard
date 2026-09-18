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

import { notifyNeedsYou } from "./notify.js";
import { badRequest, conflict, forbidden, notFound, str, oneOf, intIn, clip } from "./http.js";
import { dutyId, threadId } from "./ids.js";
import { putOp } from "./store.js";
import { resolveProject, projectOfDuty, requireHuman, authorOf, checkAgentId } from "./identity.js";
import { sweepAttachments } from "./attachments.js";
import { indexFinished, unindexDuties } from "./searching.js";
import { machinesPresent } from "./live.js";
import { noteScheduleOutcome } from "./schedules.js";

export const STATUSES = ["queued", "active", "needs_decision", "blocked", "done", "failed"];
export const PRIORITIES = ["immediate_blocker", "next", "backlog"];
export const THREAD_KINDS = ["question", "resolution", "checkpoint", "note"];

/**
 * What a duty is for. `work` is everything a person files. The other two are how a daemon sets a
 * project up, and they change what every other duty on the board runs against — the toolchain,
 * the rules — which is why they are exclusive (invariant 3).
 */
export const KINDS = ["work", "setup", "rules"];
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

  const rows = await runnableDuties(ctx, project.key, agentId, limit);
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
export async function runnableDuties(ctx, projectKey, agentId, limit) {
  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "project_id", op: "=", value: projectKey },
      { field: "status", op: "=", value: "queued" },
    ],
    order: [
      { field: "prio_rank", dir: "asc" },
      { field: "created_at", dir: "asc" },
    ],
    limit: limit + RUNNABLE_OVERFETCH,
  });
  const present = await presenceFor(ctx, rows);
  const now = Date.now();
  const settingUp = await hasUnfinished(ctx, projectKey, [{ field: "kind", op: "=", value: "setup" }]);
  return firstThingsFirst(rows.filter((d) => !claimBlocker(ctx, d, agentId, present, now) && (!settingUp || d.kind === "setup"))).slice(0, limit);
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

/**
 * Why `agentId` may not claim this duty, or null when it may.
 *
 * A reservation is absolute: a setup duty installs tools on ONE machine, and done anywhere else it
 * is done on the wrong computer. Affinity is not: it keeps a parked duty for the machine whose
 * worktree has the half-finished work, but only while that machine is there to pick it up.
 */
function claimBlocker(ctx, duty, agentId, present, now) {
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
  return {
    duty: {
      ...briefOf(duty, { full: true }),
      outcome_summary: duty.outcome_summary || null,
      last_question: duty.last_question || null,
      attachment_count: duty.attachment_count || 0,
      affinity: duty.affinity || null,
      spawned_by: duty.spawned_by || null,
      blocked_by: duty.blocked_by || null,
      // Set when a schedule filed this duty: the console says so rather than leaving a duty that
      // appeared at 9am on Monday looking like one nobody can account for.
      schedule_id: duty.schedule_id || null,
      updated_at: duty.updated_at,
    },
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
  const blocker = claimBlocker(ctx, duty, agentId, await presenceFor(ctx, [duty]), now);
  if (blocker) throw conflict(blocker, { reserved_for: duty.reserved_for || null, affinity: duty.affinity || null });
  if (duty.kind !== "setup" && (await hasUnfinished(ctx, project.key, [{ field: "kind", op: "=", value: "setup" }]))) {
    // Worded like the exclusive refusal below, which a daemon already reads as "the board is busy".
    throw conflict("a machine's setup has the board to itself until it finishes", { waiting_for: "setup" });
  }

  // The board row carries how many duties may be active at once, and which rules are current —
  // both of which a claim needs and `projectOfDuty` deliberately does not read.
  const [board, active] = await Promise.all([ctx.store.get("projects", project.key), activeDuties(ctx, project.key)]);
  const lane = pickLane(duty, board, active, project.key);

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
    updated_at: now,
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
  return {
    status: "active",
    duty_id: duty.key,
    duty: briefOf({ ...claimed, key: duty.key }, { full: true }),
    // So a daemon can tell, from the claim alone, whether the rules it has are current.
    rules_version: (board && board.rules_version) || 0,
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

/**
 * `POST /duty/enqueue` — new work, from either side of the board.
 *
 * `immediate_blocker` from an agent that is holding something means "I cannot continue
 * until this is done": the held duty moves to `blocked` referencing the new child, and
 * the agent is freed to claim the child on its next poll.
 */
export async function enqueueDuty(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);

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
  const agentId = agentIdFrom(ctx, body, { required: false });
  const kind = oneOf(body.kind, "kind", KINDS, "work");
  const reservedFor = reservation(ctx, body);

  const duty = {
    project_id: project.key,
    owner_uid: project.owner_uid,
    parent_id: str(body.parent_id, "parent_id", { max: 64, fallback: null }) || null,
    title: str(body.title, "title", { required: true, max: 200 }),
    brief: str(body.brief, "brief", { required: true, max: 4000 }),
    status: "queued",
    priority,
    prio_rank: RANK[priority],
    origin: ctx.caller.kind === "agent" ? "agent" : "human",
    // WHICH person. `origin` said "a human", which was the same thing as "the owner" until a
    // board could be shared; now a member files work too, and a card that says "from you" to
    // everyone who opens the board is wrong for all but one of them.
    created_by: ctx.caller.kind === "human" ? ctx.caller.uid : null,
    created_by_name: ctx.caller.kind === "human" ? ctx.caller.name : null,
    assigned_agent_id: null,
    outcome_summary: null,
    spawned_by: str(body.spawned_by, "spawned_by", { max: 64, fallback: null }) || null,
    blocked_by: null,
    last_question: null,
    last_resolution: null,
    kind,
    reserved_for: reservedFor,
    affinity: null,
    lane: null,
    created_at: now,
    updated_at: now,
  };
  const id = dutyId();
  const ops = [putOp("duties", id, duty)];

  // Does this interrupt something the caller is holding?
  let blocked = null;
  if (priority === "immediate_blocker" && agentId) {
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

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, id, { t: "duty", id, status: "queued" });
  if (blocked) {
    // The interrupt released whoever it interrupted, in the same transaction.
    await ctx.publish(project.key, blocked, {
      t: "duty",
      id: blocked,
      status: "blocked",
      ag: agentEvent(agentId, null, now),
    });
  }

  return { duty_id: id, status: "queued", priority, kind, reserved_for: reservedFor, blocked_duty_id: blocked };
}

/**
 * Who a new duty is reserved for, if anyone.
 *
 * A machine may reserve work for itself — that is how a session that finds a missing tool asks
 * for a setup duty on its own computer. A person may reserve for any agent prefix. A project
 * token may not: it has no machine, so there is nothing for it to reserve to.
 */
function reservation(ctx, body) {
  const wanted = str(body.reserved_for, "reserved_for", { max: 64, fallback: "" });
  if (!wanted) return null;
  if (ctx.caller.kind === "human") return wanted;
  if (ctx.caller.machineId) {
    if (wanted !== ctx.caller.agentPrefix) {
      throw forbidden(`this machine can reserve work only for itself ('${ctx.caller.agentPrefix}')`);
    }
    return wanted;
  }
  throw forbidden("a project token cannot reserve work — only a machine or a person can");
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

/** `POST /duty/complete` — active → done, with the summary that outlives the run. */
export async function completeDuty(ctx, body) {
  return finishDuty(ctx, body, "done");
}

/** `POST /duty/fail` — the honest end. Not in the happy path, but `failed` is a
 *  state in the spec and a duty that cannot be done must be able to reach it. */
export async function failDuty(ctx, body) {
  return finishDuty(ctx, body, "failed");
}

async function finishDuty(ctx, body, terminal) {
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  const agentId = agentIdFrom(ctx, body, { required: false });
  const now = Date.now();

  const summaryField = terminal === "done" ? "outcome_summary" : "reason";
  const summary = str(body[summaryField] ?? body.outcome_summary, summaryField, { required: true, max: 4000 });

  if (duty.status === "done" || duty.status === "failed") {
    throw conflict(`duty '${duty.key}' is already ${duty.status}`, { status: duty.status });
  }
  if (duty.assigned_agent_id && agentId && duty.assigned_agent_id !== agentId) {
    throw forbidden(`duty '${duty.key}' is assigned to agent '${duty.assigned_agent_id}'`);
  }

  const ops = [
    putOp("duties", duty.key, { ...stripMeta(duty), status: terminal, outcome_summary: summary, holder: null, lane: null, affinity: null, updated_at: now }),
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
      // Not a cap, a signal. Nothing refuses the fourth reopen — a person doing this is
      // paying attention by definition — but a duty that keeps coming back is worth being
      // able to see is coming back, on the duty and in the thread.
      reopen_count: (duty.reopen_count || 0) + 1,
      holder: null,
      lane: null,
      // Redone from scratch, in a fresh worktree: whatever the last one left is the old attempt.
      affinity: null,
      updated_at: now,
    }),
  ];

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
      priority: "immediate_blocker",
      prio_rank: RANK.immediate_blocker,
      last_resolution: text,
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

  if (body.title != null) next.title = str(body.title, "title", { required: true, max: 200 });
  if (body.brief != null) next.brief = str(body.brief, "brief", { required: true, max: 4000 });
  if (body.priority != null) {
    next.priority = oneOf(body.priority, "priority", PRIORITIES);
    next.prio_rank = RANK[next.priority];
  }
  if (body.status != null) {
    next.status = oneOf(body.status, "status", STATUSES);
    if (next.status !== "active") {
      next.assigned_agent_id = null;
      next.holder = null;
      next.lane = null;
    }
    if (next.status === "done" || next.status === "failed") next.affinity = null;
  }

  const ops = [putOp("duties", duty.key, next)];
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
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: "deleted" });
  return { ok: true, deleted: duty.key };
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
    unblocked_context: null,
  };
  if (duty.reserved_for) out.reserved_for = duty.reserved_for;
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
  if (full) {
    out.status = duty.status;
    out.parent_id = duty.parent_id || null;
    out.assigned_agent_id = duty.assigned_agent_id || null;
  }
  return out;
}
