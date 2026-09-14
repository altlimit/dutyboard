// Projects — a board, its owner, and the sweep that removes one.
//
// A project's key IS its slug, because agents name it in configuration and a human has
// to be able to type it. That makes creation a uniqueness check rather than an auto-id.

import { badRequest, conflict, forbidden, str, intIn } from "./http.js";
import { putOp } from "./store.js";
import { slugify } from "./ids.js";
import { requireHuman, resolveProject } from "./identity.js";
import { liveConfigured, mintLive } from "./live.js";
import { sweepAttachments } from "./attachments.js";
import { searchConfigured, unindexDuties } from "./searching.js";
import { sharedBoards, sweepMembers, syncAccess } from "./members.js";
import { mergeProfile, mergeRunner } from "./profile.js";
import { rulesDuty, sweepBoardMachines } from "./machines.js";

const SWEEP_PAGE = 200;

/** `POST /projects/create` */
/** How many agents the board strip shows. More than this on one board and the strip is
 *  not the thing that needs fixing. */
const MAX_AGENTS = 10;

/** Boards one person may own. High enough that nobody organising their work honestly will
 *  meet it, low enough that a script in a loop stops somewhere. */
const MAX_BOARDS = 100;

export async function createProject(ctx, body) {
  return createProjectFor(ctx, requireHuman(ctx.caller), body);
}

/**
 * Make a board owned by `caller` — `{ uid, name }`. Split out so a person's own paired machine can
 * make one for them (`/machine/boards/create`) when it is linking a folder that has no board yet.
 */
export async function createProjectFor(ctx, caller, body) {

  const owned = await ctx.store.countAtMost(
    "projects",
    [{ field: "owner_uid", op: "=", value: caller.uid }],
    MAX_BOARDS,
  );
  if (owned >= MAX_BOARDS) {
    throw badRequest(`you already have ${MAX_BOARDS} boards, which is the limit — delete one to make another`);
  }
  const name = str(body.name, "name", { required: true, max: 120 });
  const key = slugify(str(body.project_id ?? body.slug ?? name, "project_id", { max: 60 }));
  const now = Date.now();

  const existing = await ctx.store.get("projects", key);
  if (existing) {
    throw conflict(
      existing.owner_uid === caller.uid
        ? `you already have a project '${key}'`
        : `the project id '${key}' is taken — choose another`,
    );
  }

  // A profile is what makes this a board a `dutyboard` daemon can run. Both are validated before
  // anything is written, so a bad field refuses the board rather than making half of one.
  const withRunner = body.profile != null || body.runner != null;
  const profile = body.profile != null ? mergeProfile(null, body.profile) : null;
  const runner = withRunner ? mergeRunner(null, body.runner) : null;

  const row = {
    name,
    slug: key,
    owner_uid: caller.uid,
    owner_name: caller.name,
    ...(withRunner ? { profile, runner, rules_version: 0 } : {}),
    created_at: now,
    updated_at: now,
  };
  // A board made for a runner starts with its rules to write. One made the old way — for an agent
  // connected by hand — does not: a duty it never asked for would be the first thing that agent
  // claimed.
  const rules = withRunner ? rulesDuty({ key, owner_uid: caller.uid }, now) : null;
  await ctx.store.transaction([putOp("projects", key, row), ...(rules ? [rules.op] : [])]);
  return { project_id: key, name, rules_duty_id: rules ? rules.id : null };
}

/** `POST /projects/list` — the boards this person owns, and the ones shared with them.
 *
 * Shared boards come on the first page only and are not paged: a person is a member of at
 * most MAX_SHARED_BOARDS, so they are one bounded read, and a cursor over two differently
 * ordered sets is a way to skip boards. */
export async function listProjects(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const limit = intIn(body.limit, "limit", 1, 100, 50);
  const [{ rows, cursor }, access] = await Promise.all([
    ctx.store.query("projects", {
      where: [{ field: "owner_uid", op: "=", value: caller.uid }],
      order: [{ field: "created_at", dir: "desc" }],
      limit,
      cursor: body.cursor || undefined,
    }),
    // This list is where someone looks for a board they have just been added to, so it is also
    // where the token gets checked against the membership rows — and `refresh` tells the
    // console its token is behind, in the same response rather than a second call.
    body.cursor ? Promise.resolve(null) : syncAccess(ctx).catch(() => null),
  ]);
  return {
    projects: rows.map((p) => ({ project_id: p.key, name: p.name, created_at: p.created_at, role: "owner" })),
    shared: access ? await sharedBoards(ctx, access.boards) : [],
    refresh: !!(access && access.refresh),
    cursor,
  };
}

/**
 * `POST /board/open` — everything the console needs before it can draw a board.
 *
 * The board's name, the agents on it, and a subscribe token for its channel. That was
 * three round trips from the browser: two datastore queries and a token mint. It is one
 * here because this function was already reading the project row to authorise the mint —
 * the other two ride along on a request that was being made anyway.
 *
 * The DUTIES are deliberately not here. They are paged, refreshed independently, and read
 * straight from the datastore where the row rules scope them to their owner; folding them
 * in would mean reimplementing that access control in this function, which is exactly the
 * split the whole design rests on.
 */
export async function openBoard(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);

  const [agents, live] = await Promise.all([
    ctx.store
      .query("agents", {
        where: [{ field: "project_id", op: "=", value: project.key }],
        order: [{ field: "last_seen_at", dir: "desc" }],
        limit: MAX_AGENTS,
      })
      .then((res) => res.rows.map(agentView)),
    // Live updates are an enhancement: a board with no channel configured still opens,
    // it just does not move on its own.
    liveConfigured(ctx) ? mintLive(ctx, project, body).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    project: {
      project_id: project.key,
      name: project.name,
      created_at: project.created_at,
      owner_name: project.owner_name || "",
      profile: project.profile || null,
      runner: project.runner || null,
      rules_version: project.rules_version || 0,
    },
    // Which of the two this caller is, so the console can leave out what a member cannot do
    // rather than offer it and refuse.
    role: project.owner_uid === ctx.caller.uid ? "owner" : "member",
    agents,
    live,
    // Whether this deployment can search finished work. Reported here rather than probed
    // separately: the console needs it to decide whether to offer a search box at all, and
    // it already has to make this call before it can draw anything.
    search: searchConfigured(ctx),
  };
}

const agentView = (a) => ({
  agent_id: a.agent_id,
  active_duty_id: a.active_duty_id || null,
  last_seen_at: a.last_seen_at || null,
});

/** `POST /projects/rename` */
export async function renameProject(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const name = str(body.name, "name", { required: true, max: 120 });
  await ctx.store.putOne("projects", project.key, {
    ...withoutMeta(project),
    name,
    updated_at: Date.now(),
  });
  return { ok: true, project_id: project.key, name };
}

/**
 * `POST /projects/delete` — the project and everything under it.
 *
 * Deliberately requires the caller to repeat the project id in `confirm`: this removes
 * duties, threads, agent rows and tokens, and there is no undo short of the datastore's
 * own point-in-time restore.
 */
export async function deleteProject(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  if (body.confirm !== project.key) {
    throw forbidden(`to delete this board, send confirm: "${project.key}"`);
  }

  const removed = {
    attachments: await sweepAttachments(ctx, { field: "project_id", value: project.key }),
    threads: await sweep(ctx, "threads", project.key),
    duties: await sweep(ctx, "duties", project.key),
    agents: await sweep(ctx, "agents", project.key),
    tokens: await sweep(ctx, "tokens", project.key),
    // And everyone who was on it, with the board taken back out of their claims.
    members: await sweepMembers(ctx, project.key),
    // And every machine working it, each told so its daemon stops.
    machine_links: await sweepBoardMachines(ctx, project.key),
  };
  await ctx.store.delete("projects", [project.key]);
  return { ok: true, deleted: project.key, removed };
}

/** Delete every row in `collection` belonging to a project, a bounded page at a time.
 *  Every one of these can grow without limit, so none of them is read in one go. */
async function sweep(ctx, collection, projectId) {
  let total = 0;
  for (;;) {
    const { rows } = await ctx.store.query(collection, {
      where: [{ field: "project_id", op: "=", value: projectId }],
      limit: SWEEP_PAGE,
      keys_only: true,
    });
    if (!rows.length) return total;
    const keys = rows.map((r) => r.key);
    // A finished duty is also a search document. Unindexing it HERE, from the same page of
    // keys the delete uses, is the only place that list exists — a search index has no
    // delete-by-query, and once these rows are gone nothing could enumerate them again.
    if (collection === "duties") await unindexDuties(ctx, keys);
    await ctx.store.delete(collection, keys);
    total += keys.length;
    if (keys.length < SWEEP_PAGE) return total;
  }
}

function withoutMeta(doc) {
  const { key, _created, _updated, ...data } = doc;
  return data;
}
