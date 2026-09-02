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
//        │         ┌───────────┐
//        ▼         │ done/failed│
//   ┌─────────┐    └─────┬─────┘
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

import { badRequest, conflict, forbidden, notFound, str, oneOf, intIn, clip } from "./http.js";
import { dutyId, threadId } from "./ids.js";
import { putOp } from "./store.js";
import { resolveProject, projectOfDuty, requireHuman, authorOf } from "./identity.js";
import { sweepAttachments } from "./attachments.js";

export const STATUSES = ["queued", "active", "needs_decision", "blocked", "done", "failed"];
export const PRIORITIES = ["immediate_blocker", "next", "backlog"];
export const THREAD_KINDS = ["question", "resolution", "checkpoint", "note"];

/** Priority is an enum to people and a sort key to the scheduler. Alphabetical order of
 *  the names is wrong (`backlog` < `immediate_blocker`), so the rank is stored alongside. */
const RANK = { immediate_blocker: 0, next: 1, backlog: 2 };

/**
 * The three fields the console's agent strip shows, carried on the event that changed them.
 *
 * Only the four transitions that actually write an agent row send it. This is the whole
 * reason a live event costs one query instead of two: without it every open tab re-reads
 * the agents collection just to learn that one badge moved from "working" to "idle".
 */
const agentEvent = (id, activeDutyId, at) => ({ id, active: activeDutyId || null, seen: at });

/** Terminal and near-terminal states an agent is no longer holding. */
const FREES_AGENT = new Set(["needs_decision", "blocked", "done", "failed", "queued"]);

const BRIEF_IN_POLL = 220; // characters — poll answers straight into an agent's context

const agentKey = (projectId, agentId) => `${projectId}:${agentId}`;

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

  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "project_id", op: "=", value: project.key },
      { field: "status", op: "=", value: "queued" },
    ],
    order: [
      { field: "prio_rank", dir: "asc" },
      { field: "created_at", dir: "asc" },
    ],
    limit,
  });

  return {
    project_id: project.key,
    active_duty: active,
    runnable_duties: rows.map((d) => briefOf(d)),
  };
}

/** `POST /duty/thread` — the decision log for one duty, oldest first. */
export async function listThread(ctx, body) {
  const duty = await loadDuty(ctx, body.duty_id);
  // This endpoint used to be the one duty-scoped route with no ownership check on it:
  // `loadDuty` trusted its callers to check, and this caller did not. Any signed-in
  // person, or any agent token for any board, could read any decision log by naming a
  // duty id. Ids are ULIDs and not guessable, which is not an access control.
  projectOfDuty(ctx.caller, duty);
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
  const project = projectOfDuty(ctx.caller, duty);
  const now = Date.now();

  if (duty.status !== "queued") {
    throw conflict(`duty '${duty.key}' is ${duty.status}, not queued`, { status: duty.status });
  }

  const aKey = agentKey(project.key, agentId);
  const agent = (await ctx.store.get("agents", aKey)) || newAgent(project, agentId, now);
  if (agent.active_duty_id && agent.active_duty_id !== duty.key) {
    // The single-active invariant, reported so the agent knows what to finish first.
    throw conflict(`agent '${agentId}' already holds duty '${agent.active_duty_id}'`, {
      active_duty_id: agent.active_duty_id,
    });
  }

  const claimed = { ...stripMeta(duty), status: "active", assigned_agent_id: agentId, updated_at: now };
  await ctx.store.transaction([
    putOp("duties", duty.key, claimed),
    putOp("agents", aKey, { ...stripMeta(agent), active_duty_id: duty.key, last_seen_at: now }),
  ]);

  // Compare-after-write. Two agents can read `queued` in the same instant; only one of
  // them is named on the row afterwards, and the other must not walk away thinking it won.
  const after = await ctx.store.get("duties", duty.key);
  if (!after || after.assigned_agent_id !== agentId || after.status !== "active") {
    throw conflict(`duty '${duty.key}' was claimed by another agent`, {
      assigned_agent_id: after ? after.assigned_agent_id : null,
    });
  }

  await ctx.publish(project.key, duty.key, {
    t: "duty",
    id: duty.key,
    status: "active",
    ag: agentEvent(agentId, duty.key, now),
  });
  return { status: "active", duty_id: duty.key, duty: briefOf(after, { full: true }) };
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
  const now = Date.now();
  const priority = oneOf(body.priority, "priority", PRIORITIES, "next");
  const agentId = agentIdFrom(ctx, body, { required: false });

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
    assigned_agent_id: null,
    outcome_summary: null,
    spawned_by: str(body.spawned_by, "spawned_by", { max: 64, fallback: null }) || null,
    blocked_by: null,
    last_question: null,
    last_resolution: null,
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
        ops.push(putOp("duties", held.key, { ...stripMeta(held), status: "blocked", blocked_by: id, updated_at: now }));
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

  return { duty_id: id, status: "queued", priority, blocked_duty_id: blocked };
}

/**
 * `POST /duty/checkpoint` — record a question, a note, or a milestone.
 *
 * With `set_status: "needs_decision"` this is the non-blocking pause: the question goes
 * on the duty's thread, the duty parks, and the agent is released to claim other work.
 */
export async function checkpointDuty(ctx, body) {
  const duty = await loadDuty(ctx, body.duty_id);
  const project = projectOfDuty(ctx.caller, duty);
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
  const ops = [putOp("threads", entryKey, entry)];

  let state = duty.status;
  let freed = null; // set when this checkpoint releases the agent, for the live payload
  if (setStatus && setStatus !== duty.status) {
    state = setStatus;
    const next = { ...stripMeta(duty), status: setStatus, updated_at: now };
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
  const project = projectOfDuty(ctx.caller, duty);
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
    putOp("duties", duty.key, { ...stripMeta(duty), status: terminal, outcome_summary: summary, updated_at: now }),
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

  await ctx.store.transaction(ops);
  await ctx.publish(project.key, duty.key, {
    t: "duty",
    id: duty.key,
    status: terminal,
    ...(freed ? { ag: agentEvent(freed, null, now) } : {}),
  });
  if (parent) await ctx.publish(project.key, parent, { t: "duty", id: parent, status: "queued" });

  return { ok: true, status: terminal, duty_id: duty.key, unblocked_duty_id: parent };
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
  const project = projectOfDuty(ctx.caller, duty);
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
  const project = projectOfDuty(ctx.caller, duty);
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
    if (next.status !== "active") next.assigned_agent_id = null;
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
  return { ok: true, duty_id: duty.key, status: next.status };
}

/** `POST /duty/delete` — remove a duty and its thread. People make mistakes. */
export async function deleteDuty(ctx, body) {
  requireHuman(ctx.caller);
  const duty = await loadDuty(ctx, body.duty_id);
  const project = projectOfDuty(ctx.caller, duty);

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
  await ctx.store.delete("duties", [duty.key]);
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
      updated_at: now,
    }),
  );
  return parent.key;
}

function agentIdFrom(ctx, body, { required }) {
  const id = str(body.agent_id ?? ctx.defaultAgentId, "agent_id", { max: 64, fallback: "" });
  if (!id && required) throw badRequest("'agent_id' is required");
  return id;
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
    unblocked_context: null,
  };
  if (duty.last_resolution) {
    out.unblocked_context = {
      last_question: duty.last_question || null,
      human_resolution: duty.last_resolution,
    };
  }
  if (full) {
    out.status = duty.status;
    out.parent_id = duty.parent_id || null;
    out.assigned_agent_id = duty.assigned_agent_id || null;
  }
  return out;
}
