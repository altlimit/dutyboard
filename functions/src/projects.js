// Projects — a board, its owner, and the sweep that removes one.
//
// A project's key IS its slug, because agents name it in configuration and a human has
// to be able to type it. That makes creation a uniqueness check rather than an auto-id.

import { badRequest, conflict, forbidden, notFound, str, intIn } from "./http.js";
import { putOp } from "./store.js";
import { slugify } from "./ids.js";
import { isMember, requireHuman, resolveProject } from "./identity.js";
import { liveConfigured, mintLive, mintBoardsLive } from "./live.js";
import { sweepBoardAccess } from "./board-access.js";
import { sweepAttachments } from "./attachments.js";
import { searchConfigured, unindexDuties } from "./searching.js";
import { sharedBoards, sweepMembers, syncAccess } from "./members.js";
import { isFolderBoard, mergeProfile, mergeRunner } from "./profile.js";
import { rulesDuty, runnersOf, runnersOfBoards, sweepBoardMachines } from "./machines.js";
import { upcomingSchedules } from "./schedules.js";
import { presetOps, startingPreset, hasRoster, intakeOf, roleCard } from "./roster.js";

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
  // claimed. Nor does a board with no repository — one-off tasks, or an account run through its MCP
  // servers: there is no project to read rules from.
  const rules = withRunner && !isFolderBoard(row) ? rulesDuty({ key, owner_uid: caller.uid }, now) : null;
  // The team the board starts with, when it asks for one: in force from its first duty.
  const preset = startingPreset(body.roster, profile);
  const team = preset ? presetOps({ key, owner_uid: caller.uid }, preset, now) : null;
  if (team) row.roster = team.pointer;
  await ctx.store.transaction([putOp("projects", key, row), ...(rules ? [rules.op] : []), ...(team ? [team.op] : [])]);
  return { project_id: key, name, rules_duty_id: rules ? rules.id : null, roster: preset };
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

/** Boards `/projects/runners` answers for in one call: a full page of your own and every shared one. */
const MAX_RUNNER_BOARDS = 150;

/**
 * `POST /projects/runners` — `{ project_ids }`. The machines on each of these boards, keyed by
 * board, in the shape `/board/runners` gives one board — so the boards page can say "runner
 * offline" with the same words the board's own header uses.
 *
 * Separate from `/projects/list` because presence is a call per machine: the list draws first and
 * this fills in. A board the caller cannot see is refused, as `resolveProject` refuses it — the
 * whole request, not just that board, so a list of guesses learns nothing about which ones exist.
 * The console treats a refusal as "no runner lines", so a board deleted between the list and this
 * costs one refresh's worth of them.
 */
export async function listRunners(ctx, body) {
  const projects = await boardsAsked(ctx, body);
  const runners = await runnersOfBoards(ctx, projects);
  return { runners: Object.fromEntries(runners) };
}

/**
 * `POST /projects/upcoming` — `{ project_ids }`. What the boards' schedules will file next, across
 * all of them: the soonest runs, and each board's next one.
 *
 * A board's schedules were only to be found in its settings, one board at a time, and "what is
 * about to happen" is a question about every board at once. The browser cannot read schedules
 * itself (they are not in the row rules), so this answers it, with the same all-or-nothing check
 * as `/projects/runners`.
 */
export async function listUpcoming(ctx, body) {
  const projects = await boardsAsked(ctx, body);
  return upcomingSchedules(ctx, projects.map((p) => p.key));
}

/**
 * `POST /projects/rosters` — `{ project_ids }`. Each board's team as cards, keyed by board: who reads
 * new duties first and every role's name, level and what it does — no charters. Null for a board
 * with no team. What the boards page's office draws a cubicle per role from, in one request rather
 * than one per board, with the same all-or-nothing check as `/projects/runners`.
 */
export async function listRosters(ctx, body) {
  const projects = await boardsAsked(ctx, body);
  const teamed = projects.filter(hasRoster).map((p) => p.key);
  const rows = teamed.length ? await ctx.store.getMany("rosters", teamed) : new Map();
  return {
    rosters: Object.fromEntries(
      projects.map((p) => {
        const r = rows.get(p.key);
        return [p.key, r && Array.isArray(r.roles) && r.roles.length ? { version: r.version || 0, intake: intakeOf(r).id, roles: r.roles.map(roleCard) } : null];
      }),
    ),
  };
}

/** Boards one live token watches. A person with more than this sees the busiest of them move. */
const MAX_LIVE_BOARDS = 40;

/**
 * `POST /live/boards` — `{ project_ids }`. One subscribe-only token for the board channels of several
 * boards, so a page that shows them all opens one socket rather than one per board.
 */
export async function liveBoards(ctx, body) {
  if (!liveConfigured(ctx)) throw badRequest("live updates are not configured for this deployment");
  if (Array.isArray(body.project_ids) && body.project_ids.length > MAX_LIVE_BOARDS) {
    throw badRequest(`at most ${MAX_LIVE_BOARDS} boards on one live token`);
  }
  const projects = await boardsAsked(ctx, body);
  if (!projects.length) throw badRequest("name at least one board");
  return mintBoardsLive(ctx, projects.map((p) => p.key), ctx.caller.uid);
}

/** The boards a `{ project_ids }` request names, each one the caller owns or is on — or a refusal. */
async function boardsAsked(ctx, body) {
  const caller = requireHuman(ctx.caller);
  if (!Array.isArray(body.project_ids)) throw badRequest("'project_ids' must be a list");
  const ids = [...new Set(body.project_ids.map(String))];
  if (ids.length > MAX_RUNNER_BOARDS) throw badRequest(`at most ${MAX_RUNNER_BOARDS} boards at once`);
  const found = ids.length ? await ctx.store.getMany("projects", ids) : new Map();
  return Promise.all(
    ids.map(async (id) => {
      const p = found.get(id);
      if (!p) throw notFound(`project '${id}' not found`);
      if (p.owner_uid !== caller.uid && !(await isMember(caller, ctx.store, p.key))) throw forbidden(`you do not own project '${id}'`);
      return p;
    }),
  );
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

  const [agents, live, runners] = await Promise.all([
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
    // The machines working this board, for the header's runner pill. Best-effort like live: a
    // board still opens if this fails.
    runnersOf(ctx, project).catch(() => []),
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
      // Whether the board has a team, and which role reads new duties first.
      roster: project.roster || null,
    },
    // Which of the two this caller is, so the console can leave out what a member cannot do
    // rather than offer it and refuse.
    role: project.owner_uid === ctx.caller.uid ? "owner" : "member",
    agents,
    runners,
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
    board_access: await sweepBoardAccess(ctx, project.key),
    attachments: await sweepAttachments(ctx, { field: "project_id", value: project.key }),
    threads: await sweep(ctx, "threads", project.key),
    duties: await sweep(ctx, "duties", project.key),
    note_sources: await sweep(ctx, "note_sources", project.key),
    agents: await sweep(ctx, "agents", project.key),
    tokens: await sweep(ctx, "tokens", project.key),
    // Each holding the secret its token's deliveries were signed with.
    webhooks: await sweep(ctx, "webhooks", project.key),
    schedules: await sweep(ctx, "schedules", project.key),
    finishes: await sweep(ctx, "finishes", project.key),
    role_events: await sweep(ctx, "role_events", project.key),
    // The team and what it wrote down, each one row keyed by the board.
    roster: await ctx.store.delete("rosters", [project.key]).catch(() => 0),
    memory: await ctx.store.delete("memories", [project.key]).catch(() => 0),
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
