// The team's memory: what the agents on a board have learned about its project and want the next
// session to know. Their CLAUDE.md or AGENTS.md, kept on the board rather than in one machine's
// folder, so every machine and every role starts from it.
//
// It is the AGENTS' notebook. The board's description is what a person says the project is, and
// the rules are what a person has put in force; this is neither. An agent writes it without asking
// — it is how the work stops being rediscovered — and the owner can read, edit or clear it.
//
// Small on purpose: the whole of it is read into every session's prompt, so it is held to a size
// where that is cheap, and it is REPLACED rather than appended to. An agent that wants to add a
// line reads it, edits it and writes it back, which is also what keeps it curated.

import { badRequest, conflict, forbidden, str } from "./http.js";
import { resolveProject, checkAgentId } from "./identity.js";

/** About 1,500 tokens: enough for what a project's next session must know, cheap in every prompt. */
export const MAX_MEMORY_CHARS = 6000;
/**
 * Earlier versions kept. The memory is replaced whole, by agents, without anyone asking — so one bad
 * write could cost everything the team had learned. These are what the owner restores from.
 */
export const MEMORY_VERSIONS_KEPT = 10;

const historyKey = (projectKey, version) => `${projectKey}:${String(version).padStart(8, "0")}`;

const withoutMeta = ({ key, _created, _updated, ...data }) => data;

const memoryView = (projectKey, row) => {
  const body = (row && row.body) || "";
  return {
    project_id: projectKey,
    body,
    version: (row && row.version) || 0,
    chars: body.length,
    max_chars: MAX_MEMORY_CHARS,
    updated_at: (row && row.updated_at) || null,
    updated_by: (row && row.updated_by) || null,
  };
};

/** The memory as it stands, for a claim to hand to the session taking a duty. */
export async function memoryOf(ctx, projectKey) {
  return memoryView(projectKey, await ctx.store.get("memories", projectKey));
}

/** `POST /board/memory` — what the team has written down. Anyone on the board, and its agents. */
export async function getMemory(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  return memoryOf(ctx, project.key);
}

/**
 * `POST /board/memory/write` — `{ body, based_on }`. Replaces the whole memory.
 *
 * `based_on` is the version the caller read. Two sessions run at once on a busy board; without it
 * the second to write would silently erase what the first learned. A stale write is refused with
 * the current text, so the caller merges and writes again.
 *
 * An agent writes only while it holds an active duty that is real work — a note review reads the
 * board and changes nothing. The board's owner may edit or clear it at any time.
 */
export async function writeMemory(ctx, body) {
  const human = ctx.caller.kind === "human";
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: human });
  if (ctx.caller.scope === "submit" || ctx.caller.crossBoard) throw forbidden("this credential cannot write the board's memory");

  let by = human ? { uid: ctx.caller.uid, name: ctx.caller.name || "" } : null;
  if (!human) {
    const agentId = checkAgentId(ctx.caller, str(body.agent_id ?? ctx.defaultAgentId, "agent_id", { required: true, max: 64 }));
    const agent = await ctx.store.get("agents", `${project.key}:${agentId}`);
    const held = agent && agent.active_duty_id ? await ctx.store.get("duties", agent.active_duty_id) : null;
    if (!held || held.status !== "active" || held.project_id !== project.key) {
      throw conflict("the memory is written from work in hand — hold an active duty on this board first");
    }
    if (held.kind === "note_review") throw forbidden("a note review reads the board and changes nothing, the memory included");
    by = { agent_id: agentId, duty_id: held.key, role: held.role || null };
  }

  if (typeof body.body !== "string") throw badRequest("'body' must be the whole memory as text — an empty string clears it");
  const text = body.body.trim();
  if (text.length > MAX_MEMORY_CHARS) {
    throw badRequest(
      `the memory is ${text.length} characters and may be at most ${MAX_MEMORY_CHARS}. It is read into every session, so keep it to what the next one ` +
        `cannot work out from the code, the rules or the profile: cut what is stale, merge what repeats, and write it again.`,
    );
  }

  const row = await ctx.store.get("memories", project.key);
  const current = (row && row.version) || 0;
  if (!human || body.based_on != null) {
    if (!Number.isInteger(body.based_on)) throw badRequest("'based_on' must be the version you read with board_memory");
    if (body.based_on !== current) {
      throw conflict(
        `the memory changed since you read it (it is at version ${current}, you read ${body.based_on}). Read it again, keep what was added, and write your merged text with based_on ${current}.`,
        memoryView(project.key, row),
      );
    }
  }

  const now = Date.now();
  const next = {
    ...(row ? withoutMeta(row) : { project_id: project.key, owner_uid: project.owner_uid, created_at: now }),
    body: text,
    version: current + 1,
    updated_by: by,
    updated_at: now,
  };
  // What is being replaced is kept first: if this stops half-way there is a spare copy, never a gap.
  if (row && row.body) {
    await ctx.store.putOne("memory_history", historyKey(project.key, current), {
      project_id: project.key,
      owner_uid: project.owner_uid,
      version: current,
      body: row.body,
      updated_by: row.updated_by || null,
      updated_at: row.updated_at || null,
      replaced_at: now,
    });
    if (current > MEMORY_VERSIONS_KEPT) await ctx.store.delete("memory_history", [historyKey(project.key, current - MEMORY_VERSIONS_KEPT)]).catch(() => 0);
  }
  await ctx.store.putOne("memories", project.key, next);
  await ctx.publish(project.key, null, { t: "board", what: "memory" });
  return { ok: true, ...memoryView(project.key, next) };
}

/**
 * `POST /board/memory/history` — the versions before the current one, newest first, for a person to
 * read and restore from. Restoring is writing an old body back, which makes it the newest version.
 */
export async function memoryHistory(ctx, body) {
  if (ctx.caller.kind !== "human") throw forbidden("the memory's earlier versions are for the people on the board");
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const row = await ctx.store.get("memories", project.key);
  const current = (row && row.version) || 0;
  const keys = [];
  for (let v = current - 1; v >= 1 && keys.length < MEMORY_VERSIONS_KEPT; v--) keys.push(historyKey(project.key, v));
  const found = await ctx.store.getMany("memory_history", keys);
  const versions = keys
    .map((k) => found.get(k))
    .filter(Boolean)
    .map((h) => ({ version: h.version, body: h.body, chars: h.body.length, updated_by: h.updated_by || null, updated_at: h.updated_at || null }));
  return { project_id: project.key, version: current, versions };
}
