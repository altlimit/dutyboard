// Projects — a board, its owner, and the sweep that removes one.
//
// A project's key IS its slug, because agents name it in configuration and a human has
// to be able to type it. That makes creation a uniqueness check rather than an auto-id.

import { conflict, forbidden, str, intIn } from "./http.js";
import { slugify } from "./ids.js";
import { requireHuman, resolveProject } from "./identity.js";

const SWEEP_PAGE = 200;

/** `POST /api/projects/create` */
export async function createProject(ctx, body) {
  const caller = requireHuman(ctx.caller);
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

  await ctx.store.putOne("projects", key, {
    name,
    slug: key,
    owner_uid: caller.uid,
    owner_name: caller.name,
    created_at: now,
    updated_at: now,
  });
  return { project_id: key, name };
}

/** `POST /api/projects/list` — the boards this person owns. */
export async function listProjects(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const limit = intIn(body.limit, "limit", 1, 100, 50);
  const { rows, cursor } = await ctx.store.query("projects", {
    where: [{ field: "owner_uid", op: "=", value: caller.uid }],
    order: [{ field: "created_at", dir: "desc" }],
    limit,
    cursor: body.cursor || undefined,
  });
  return {
    projects: rows.map((p) => ({ project_id: p.key, name: p.name, created_at: p.created_at })),
    cursor,
  };
}

/** `POST /api/projects/rename` */
export async function renameProject(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const name = str(body.name, "name", { required: true, max: 120 });
  await ctx.store.putOne("projects", project.key, {
    ...withoutMeta(project),
    name,
    updated_at: Date.now(),
  });
  return { ok: true, project_id: project.key, name };
}

/**
 * `POST /api/projects/delete` — the project and everything under it.
 *
 * Deliberately requires the caller to repeat the project id in `confirm`: this removes
 * duties, threads, agent rows and tokens, and there is no undo short of the datastore's
 * own point-in-time restore.
 */
export async function deleteProject(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  if (body.confirm !== project.key) {
    throw forbidden(`to delete this board, send confirm: "${project.key}"`);
  }

  const removed = {
    threads: await sweep(ctx, "threads", project.key),
    duties: await sweep(ctx, "duties", project.key),
    agents: await sweep(ctx, "agents", project.key),
    tokens: await sweep(ctx, "tokens", project.key),
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
    await ctx.store.delete(collection, rows.map((r) => r.key));
    total += rows.length;
    if (rows.length < SWEEP_PAGE) return total;
  }
}

function withoutMeta(doc) {
  const { key, _created, _updated, ...data } = doc;
  return data;
}
