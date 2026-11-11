// Directional grants: source board agents may act on a target board. The target's
// owner grants access, and must retain access to the source board. No transitive grants.
import { badRequest, forbidden, notFound, str, oneOf } from "./http.js";
import { requireHuman, requireAgent, resolveProject, checkAgentId, memberKey } from "./identity.js";
import { sha256Hex } from "./ids.js";

export const BOARD_ACCESS_LEVELS = ["read", "write", "full"];
export const MAX_BOARD_LINKS = 50;
const rank = { read: 1, write: 2, full: 3 };
const keyOf = (source, target) => `${target}:${source}`;

// An explicit allowlist keeps new tools closed until their permission is decided.
export const BOARD_OPERATIONS = Object.freeze({
  duty_list: "read", duty_get: "read", duty_thread: "read", duty_search: "read",
  duty_attachments: "read", board_profile: "read", board_rules: "read",
  duty_schedule_list: "read", duty_schedule_history: "read",
  duty_enqueue: "write", duty_attach: "write",
  duty_poll: "full", duty_claim: "full", duty_checkpoint: "full", duty_complete: "full",
  duty_fail: "full", duty_cancel: "full", duty_suggest: "full", duty_attachment_delete: "full",
  board_profile_propose: "full", board_rules_submit: "full",
  duty_schedule_create: "full", duty_schedule_update: "full", duty_schedule_delete: "full",
});

async function accessibleTo(store, project, uid) {
  return !!project && (project.owner_uid === uid || !!(await store.get("memberships", memberKey(project.key, uid))));
}

async function liveGrant(ctx, row) {
  if (!row || !rank[row.level]) return null;
  const [source, target] = await Promise.all([
    ctx.store.get("projects", row.source_project_id), ctx.store.get("projects", row.target_project_id),
  ]);
  if (!source || !target || target.owner_uid !== row.granted_by ||
      source.created_at !== row.source_created_at || target.created_at !== row.target_created_at ||
      !(await accessibleTo(ctx.store, source, row.granted_by))) return null;
  return { source, target, row };
}

/** Configure on B: add A to grant A -> B. Sharing authority stays with B's owner. */
export async function setBoardAccess(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const target = await resolveProject(caller, body.project_id, ctx.store, { ownerOnly: true });
  const sourceID = str(body.source_project_id, "source_project_id", { required: true, max: 60 });
  if (sourceID === target.key) throw badRequest("a board already has access to itself");
  const source = await resolveProject(caller, sourceID, ctx.store);
  const level = oneOf(body.level, "level", BOARD_ACCESS_LEVELS);
  const key = keyOf(source.key, target.key);
  const previous = await ctx.store.get("board_access", key);
  if (!previous) {
    for (const [field, value] of [["target_project_id", target.key], ["source_project_id", source.key]]) {
      const count = await ctx.store.countAtMost("board_access", [{ field, op: "=", value }], MAX_BOARD_LINKS);
      if (count >= MAX_BOARD_LINKS) throw badRequest(`a board can have at most ${MAX_BOARD_LINKS} links in each direction`);
    }
  }
  const now = Date.now();
  await ctx.store.putOne("board_access", key, {
    source_project_id: source.key, target_project_id: target.key,
    source_name: source.name, target_name: target.name, level, granted_by: caller.uid,
    source_created_at: source.created_at, target_created_at: target.created_at,
    created_at: previous?.created_at || now, updated_at: now,
  });
  await publishAccess(ctx, source.key, target.key);
  return { ok: true, source_project_id: source.key, target_project_id: target.key, level };
}

export async function removeBoardAccess(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const target = await resolveProject(caller, body.project_id, ctx.store, { ownerOnly: true });
  const source = str(body.source_project_id, "source_project_id", { required: true, max: 60 });
  // Removing a grant must work even if its source was deleted or the grantor lost access.
  await ctx.store.delete("board_access", [keyOf(source, target.key)]);
  await publishAccess(ctx, source, target.key);
  return { ok: true };
}

async function publishAccess(ctx, source, target) {
  await Promise.all([source, target].map(id => ctx.publish(id, null, { t: "board", what: "access" })));
}

export async function listBoardAccess(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const result = { incoming: [], outgoing: [], max_links: MAX_BOARD_LINKS };
  for (const [direction, field] of [["incoming", "target_project_id"], ["outgoing", "source_project_id"]]) {
    const { rows } = await ctx.store.query("board_access", { where: [{ field, op: "=", value: project.key }], limit: MAX_BOARD_LINKS });
    result[direction] = await Promise.all(rows.map(async row => {
      const live = await liveGrant(ctx, row);
      return {
        source_project_id: row.source_project_id, target_project_id: row.target_project_id,
        source_name: live?.source.name || row.source_name, target_name: live?.target.name || row.target_name,
        level: row.level, active: !!live,
      };
    }));
  }
  return result;
}

/** Agent discovery includes only outgoing, currently usable grants. */
export async function linkedBoards(ctx) {
  const caller = requireAgent(ctx.caller);
  if (caller.scope === "submit" || caller.crossBoard) throw forbidden("this credential cannot discover linked boards");
  await resolveProject(caller, caller.projectId, ctx.store);
  const { rows } = await ctx.store.query("board_access", {
    where: [{ field: "source_project_id", op: "=", value: caller.projectId }], limit: MAX_BOARD_LINKS,
  });
  const boards = [];
  for (const row of rows) {
    const live = await liveGrant(ctx, row);
    if (live) boards.push({ project_id: live.target.key, name: live.target.name, level: row.level,
      operations: Object.keys(BOARD_OPERATIONS).filter(name => rank[BOARD_OPERATIONS[name]] <= rank[row.level]) });
  }
  return { project_id: caller.projectId, boards };
}

/** Authorize once, then call the unchanged agent handler with a strictly target-scoped identity. */
export async function callWithBoardAccess(ctx, body, handler) {
  const caller = requireAgent(ctx.caller);
  if (caller.scope === "submit" || caller.crossBoard) throw forbidden("this credential cannot use board links");
  const targetID = str(body.project_id, "project_id", { required: true, max: 60 });
  if (targetID === caller.projectId) throw badRequest("use the ordinary tools for your own board");
  const operation = oneOf(body.operation, "operation", Object.keys(BOARD_OPERATIONS));
  const grant = await liveGrant(ctx, await ctx.store.get("board_access", keyOf(caller.projectId, targetID)));
  if (!grant || rank[grant.row.level] < rank[BOARD_OPERATIONS[operation]]) throw forbidden("this board link does not allow that operation");
  const input = body.arguments ?? {};
  if (typeof input !== "object" || Array.isArray(input)) throw badRequest("'arguments' must be an object");
  if (input.project_id && input.project_id !== targetID) throw forbidden("arguments must name the linked target board");
  const args = { ...input, project_id: targetID };
  // Every reference remains inside the target, even handlers whose secondary references
  // predate board linking. A supplied id cannot turn B access into C access.
  for (const field of ["duty_id", "note_id", "parent_id", "spawned_by"]) {
    if (!args[field]) continue;
    const id = str(args[field], field, { required: true, max: 64 });
    const row = await ctx.store.get("duties", id);
    if (!row || row.project_id !== targetID) throw notFound(`duty '${id}' not found`);
    if (operation === "duty_attach" && grant.row.level === "write" && row.origin_board_id !== caller.projectId) {
      throw forbidden("WRITE may attach files only to duties filed by this source board");
    }
  }
  for (const [field, collection] of [["schedule_id", "schedules"], ["attachment_id", "attachments"]]) {
    if (!args[field]) continue;
    const row = await ctx.store.get(collection, str(args[field], field, { required: true, max: 64 }));
    if (!row || row.project_id !== targetID) throw notFound(`${field} not found`);
  }
  if (grant.row.level === "write" && operation === "duty_enqueue") {
    if (args.kind && args.kind !== "work" || args.parent_id || args.spawned_by) throw forbidden("WRITE files independent work duties only");
  }
  const actor = checkAgentId(caller, str(body.agent_id ?? ctx.defaultAgentId, "agent_id", { max: 64, fallback: "" }));
  const sourceAgent = actor ? await ctx.store.get("agents", `${caller.projectId}:${actor}`) : null;
  const sourceHeld = sourceAgent?.active_duty_id ? await ctx.store.get("duties", sourceAgent.active_duty_id) : null;
  if (sourceHeld?.status === "active" && sourceHeld.kind === "note_review" && BOARD_OPERATIONS[operation] !== "read") {
    throw forbidden("a note review may read linked boards, but may not start or change their work");
  }
  const sourceDutyID = str(body.source_duty_id, "source_duty_id", { max: 64, fallback: "" });
  if (sourceDutyID) {
    const duty = await ctx.store.get("duties", sourceDutyID);
    if (!duty || duty.project_id !== caller.projectId || duty.status !== "active" || duty.assigned_agent_id !== actor) {
      throw forbidden("the source duty must be active and held by this agent");
    }
    if (duty.kind === "note_review" && BOARD_OPERATIONS[operation] !== "read") {
      throw forbidden("a note review may read linked boards, but may not start or change their work");
    }
  }
  // A stable, distinct agent identity avoids collisions with target-board agents. Do not
  // carry machine authority, source token webhooks or human credentials across the grant.
  const credential = caller.machineId || caller.tokenKey || "agent";
  const remoteActor = `link/${caller.projectId.slice(0, 20)}/${sha256Hex(`${caller.projectId}:${credential}:${actor}`).slice(0, 24)}`;
  args.agent_id = remoteActor;
  delete args.affinity; // no target workspace or machine link was granted
  const refOwner = `linked:${caller.projectId}:${targetID}:${sha256Hex(credential).slice(0, 24)}`;
  const delegated = {
    kind: "agent", scope: "agent", projectId: targetID, defaultAgentId: remoteActor,
    tokenName: `${grant.source.name}: ${actor || "agent"}`,
    tokenKey: refOwner,
    crossBoard: { source: caller.projectId, target: targetID, sourceDutyID, actor: remoteActor, refOwner },
  };
  const next = { ...ctx, caller: delegated, defaultAgentId: remoteActor, readOnly: BOARD_OPERATIONS[operation] === "read" };
  return handler(next, args);
}

export async function sweepBoardAccess(ctx, projectID) {
  let removed = 0;
  for (const field of ["source_project_id", "target_project_id"]) {
    for (;;) {
      const { rows } = await ctx.store.query("board_access", { where: [{ field, op: "=", value: projectID }], limit: 100, keys_only: true });
      if (!rows.length) break;
      removed += await ctx.store.delete("board_access", rows.map(r => r.key));
    }
  }
  return removed;
}
