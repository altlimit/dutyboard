// Finished duties, findable.
//
// `outcome_summary` is described everywhere in this project as the one thing that outlives
// an agent's session. It was not findable. An agent asking the obvious question — "have we
// done this before, and what happened?" — had `duty_poll`, which only returns runnable
// work, and `duty_thread`, which needs an id it does not have. The record survived and
// nothing could reach it.
//
// So finished duties are indexed. Not open ones: the board already shows those, in five
// columns, and a search that returns things you are looking at is noise. What is worth
// finding is the work nobody remembers doing.
//
// SCOPING IS BY FACET, NOT BY QUERY STRING. The caller's query goes to the search engine
// verbatim, and if the board were pinned by pasting `project_id="x" AND (...)` in front of
// it, then a query containing its own quotes and parentheses would be a way to read another
// board. A facet refinement is applied by the engine outside the query, so nothing the
// caller writes can widen it. `project_id` is therefore written as BOTH a field and a facet
// — the docs are explicit that these are separate arrays, and faceting on a value written
// only as a field silently matches nothing.
//
// Everything here is best-effort. Search is an enhancement: a deployment without it works,
// and a search instance that is briefly unreachable must never turn a completed duty into
// an error the agent has to retry.

import { badRequest, str, intIn } from "./http.js";
import { requireHuman, resolveProject } from "./identity.js";

/** One index, named for what it holds. */
const INDEX = "finished_duties";

/** Duties per reindex call. Bounded so a large board is several calls, not a timeout. */
const REINDEX_PAGE = 100;

/** Is search configured at all? */
export const searchConfigured = (ctx) => !!(ctx.env.search && ctx.cfg.searchInstance);

const target = (ctx) => ({ instance: ctx.cfg.searchInstance });

const atom = (name, value) => ({ name, type: "atom", value: String(value) });
const text = (name, value) => ({ name, type: "text", value: String(value || "") });

/**
 * Record a duty that has just finished, so it can be found later.
 *
 * Called after the transaction that finished it, never inside: this must not be able to
 * fail a state transition. The duty id is the document id, so re-finishing (or a retry)
 * replaces rather than duplicates.
 */
/** One document, built the same way whether it is written as a duty finishes or swept up by
 *  a reindex — two shapes for the same thing is how a backfill quietly produces results that
 *  look different from live ones. */
function document(duty, project, terminal, summary) {
  return {
    id: duty.key,
    fields: [
      atom("project_id", project.key),
      atom("status", terminal),
      atom("agent", duty.assigned_agent_id || ""),
      text("title", duty.title),
      text("brief", duty.brief),
      text("outcome", summary),
      // When it finished, as the duty itself records it — not "now", which on a reindex
      // would sort years of history as though it all happened this afternoon.
      { name: "finished_at", type: "number", value: Number(duty.updated_at) || Date.now() },
    ],
    // Countable, and — for project_id — the only safe way to scope a query. See the note
    // at the top of this file.
    facets: [atom("project_id", project.key), atom("status", terminal)],
  };
}

export async function indexFinished(ctx, duty, project, terminal, summary) {
  if (!searchConfigured(ctx)) return;
  const doc = document({ ...duty, updated_at: Date.now() }, project, terminal, summary);
  try {
    await ctx.env.search.index(target(ctx), INDEX, [doc]);
  } catch (err) {
    console.log("search index failed (ignored):", err && err.message);
  }
}

/** Forget duties — because they were deleted, or their whole board was. */
export async function unindexDuties(ctx, ids) {
  if (!searchConfigured(ctx) || !ids.length) return;
  try {
    await ctx.env.search.delete(target(ctx), INDEX, ids);
  } catch (err) {
    console.log("search delete failed (ignored):", err && err.message);
  }
}

/**
 * `POST /board/reindex` — make work finished BEFORE search existed findable.
 *
 * Without this, turning search on gives you an index that knows only about duties completed
 * from that moment — so the answer to "have we done this before" is no for exactly the
 * history you turned it on to reach. Every existing board has this problem once, and a
 * feature that only works on boards created after it shipped is not much of a feature.
 *
 * Bounded per call and resumable: it reports how far it got and whether there is more, so a
 * board with thousands of finished duties is several calls rather than one that times out.
 */
export async function reindexBoard(ctx, body) {
  requireHuman(ctx.caller);
  if (!searchConfigured(ctx)) {
    throw badRequest("search is not configured for this deployment (no search instance)");
  }
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const cursor = body.cursor ? str(body.cursor, "cursor", { max: 500 }) : undefined;

  const { rows, cursor: next } = await ctx.store.query("duties", {
    where: [
      { field: "project_id", op: "=", value: project.key },
      { field: "status", op: "in", value: ["done", "failed"] },
    ],
    order: [{ field: "updated_at", dir: "desc" }],
    limit: REINDEX_PAGE,
    cursor,
  });

  const docs = rows.map((duty) => document(duty, project, duty.status, duty.outcome_summary || ""));
  if (docs.length) {
    // NOT swallowed, unlike indexing on the way past a finished duty: this is the whole
    // point of the call, and a caller told "indexed 0" while it silently failed would have
    // no way to tell that from a board with nothing to index.
    await ctx.env.search.index(target(ctx), INDEX, docs);
  }
  return {
    project_id: project.key,
    indexed: docs.length,
    cursor: rows.length === REINDEX_PAGE ? next : null,
    more: rows.length === REINDEX_PAGE,
  };
}

/**
 * `POST /duty/search` — find finished work on this board.
 *
 * The query is App Engine Search syntax and goes through as written: bare terms, `~stemmed`,
 * `"a phrase"`, `title:something`, `AND`/`OR`/`-negated`. What it cannot do is leave this
 * board, because that is a facet refinement rather than part of the query.
 */
export async function searchDuties(ctx, body) {
  if (!searchConfigured(ctx)) {
    throw badRequest("search is not configured for this deployment (no search instance)");
  }
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const q = str(body.query, "query", { required: true, max: 500 });
  const limit = intIn(body.limit, "limit", 1, 25, 10);

  const refinements = [{ name: "project_id", value: project.key }];
  if (body.status != null) {
    const status = str(body.status, "status", { max: 20 });
    if (status !== "any") refinements.push({ name: "status", value: status === "failed" ? "failed" : "done" });
  }

  const res = await ctx.env.search.search(target(ctx), INDEX, {
    query: q,
    limit,
    cursor: body.cursor || undefined,
    facet_refinements: refinements,
    // Newest first. `default` is required — it is what a document missing the field sorts
    // as, and every document here has one, so the value only matters to the validator.
    sort: [{ expr: "finished_at", desc: true, default: 0 }],
  });

  // A result is `{id, rank, document: {id, fields: [{name, type, value}]}}`. The fields are
  // a LIST, not an object — reading `r.fields.title` gives undefined for every one of them,
  // which looks exactly like a document that was indexed empty.
  const hits = (res.results || []).map((r) => {
    const f = Object.fromEntries(((r.document && r.document.fields) || []).map((x) => [x.name, x.value]));
    return {
      duty_id: r.id ?? (r.document && r.document.id) ?? null,
      title: f.title ?? null,
      brief: f.brief ?? null,
      outcome_summary: f.outcome ?? null,
      status: f.status ?? null,
      agent_id: f.agent || null,
      finished_at: f.finished_at ?? null,
    };
  });

  return {
    project_id: project.key,
    query: q,
    hits,
    // A lower bound unless the engine says otherwise — the docs are explicit that this is
    // counted only as far as it is asked to count, so it is passed through as-is rather
    // than presented as a total.
    total: res.total_hits ?? hits.length,
    total_is_exact: res.total_hits_exact ?? null,
    cursor: res.cursor || null,
  };
}
