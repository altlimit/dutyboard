// Members — people other than the owner who work on a board.
//
// A board has one owner and, now, any number of members up to a cap. A member does the work
// on the board: adds duties, answers questions, sends finished work back, attaches files,
// edits. The owner keeps what can hurt the board or reach outside it: deleting it, renaming
// it, deciding who else is on it, and minting the agent tokens that let software in.
//
// TWO PLACES HOLD MEMBERSHIP, ON PURPOSE.
//
//   `memberships` rows  — the truth. This function reads them on every write a member makes,
//                         so adding and removing someone takes effect on the next request.
//   the `boards` claim  — a copy, on the person's auth account, for the console's direct
//                         datastore reads. Row rules can match `project_id in
//                         $auth.claims.boards`, and nothing else a rule can see knows who is
//                         on a board. It rides the identity token, so it is as fresh as the
//                         token: up to an hour stale for reads, never for writes.
//
// The rows are what a member list is made of; the claim is derived from them and rewritten
// whenever they change. `syncAccess` heals the two when they disagree — an account made
// before this existed, a claim write that failed, a token issued before a change.
//
// THE CLAIM IS NEVER EMPTY AND NEVER MISSING. Both are refusals on this platform, and both
// would lock owners out of their own boards, not just members out of shared ones:
//
//   - a rule that references a claim the account does not have is a hard deny for the whole
//     rule — every branch of the OR, including `owner_uid = $auth.uid`;
//   - an `in` over an empty list is refused as a bad query.
//
// So the list always starts with NO_BOARD, a value no board id can be: board ids are slugs of
// [a-z0-9-] that never start or end with a hyphen.

import { badRequest, conflict, forbidden, notFound, str } from "./http.js";
import { memberKey, requireHuman, resolveProject } from "./identity.js";

/** People on one board besides its owner. */
export const MAX_MEMBERS = 25;

/** Boards one person can be a member of. The claim is capped in bytes and the rule's `in` in
 *  values (80), and this sits well under both with room for board ids at their longest. */
export const MAX_SHARED_BOARDS = 50;

/** The placeholder that keeps the claim non-empty. See the note at the top. */
export const NO_BOARD = "-";

const SWEEP_PAGE = 200;

const authTarget = (ctx) => ({ instance: ctx.cfg.authInstance });

function needAuthAdmin(ctx) {
  if (!ctx.env.auth || typeof ctx.env.auth.setClaims !== "function") {
    throw badRequest("this deployment cannot manage members: the function needs `write` on its auth instance");
  }
}

/** The boards `uid` is a member of, from the rows. Sorted, so two lists compare by value. */
async function boardsOf(ctx, uid) {
  const { rows } = await ctx.store.query("memberships", {
    where: [{ field: "uid", op: "=", value: uid }],
    limit: MAX_SHARED_BOARDS + 1,
    keys_only: true,
  });
  // The key is `<board>:<uid>`. Neither half can contain a colon — a board id is a slug and a
  // uid is a UUID — so the board is everything before the last one.
  return rows.map((r) => String(r.key).slice(0, String(r.key).lastIndexOf(":"))).sort();
}

const claimValue = (boards) => [NO_BOARD, ...boards];
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** Rewrite one person's `boards` claim from their membership rows, keeping every other claim.
 *  setClaims REPLACES the whole object, so the rest is read first and sent back. */
async function writeBoardsClaim(ctx, uid) {
  const want = claimValue(await boardsOf(ctx, uid));
  const user = await ctx.env.auth.getUser(authTarget(ctx), uid);
  if (!user) return want; // the account is gone; nothing to write to
  const claims = (user.claims && typeof user.claims === "object" ? user.claims : {}) || {};
  if (!sameList(claims.boards, want)) {
    await ctx.env.auth.setClaims(authTarget(ctx), uid, { ...claims, boards: want });
  }
  return want;
}

/**
 * `POST /me/access` — make this person's token able to read what they are allowed to.
 *
 * The console calls it once a page load, before its first direct read. It answers whether the
 * token in hand is out of date; when it is, the console refreshes and the new token carries
 * the corrected claim. Nothing is refreshed when nothing changed, so the steady state is one
 * keys-only query.
 */
export async function syncAccess(ctx) {
  const caller = requireHuman(ctx.caller);
  const want = claimValue(await boardsOf(ctx, caller.uid));
  if (sameList(caller.claims && caller.claims.boards, want)) return { refresh: false, boards: want.slice(1) };
  needAuthAdmin(ctx);
  await writeBoardsClaim(ctx, caller.uid);
  return { refresh: true, boards: want.slice(1) };
}

const memberView = (m) => ({
  uid: m.uid,
  identifier: m.identifier || "",
  name: m.name || "",
  added_at: m.created_at || null,
});

/** `POST /board/members/list` — the owner and everyone else on a board. Members may read it:
 *  knowing who else is working here is not a secret from the people working here. */
export async function listMembers(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const project = await resolveProject(caller, body.project_id, ctx.store);
  const { rows } = await ctx.store.query("memberships", {
    where: [{ field: "project_id", op: "=", value: project.key }],
    order: [{ field: "created_at", dir: "asc" }],
    limit: MAX_MEMBERS,
  });
  return {
    project_id: project.key,
    owner: { uid: project.owner_uid, name: project.owner_name || "" },
    you: project.owner_uid === caller.uid ? "owner" : "member",
    members: rows.map(memberView),
    max_members: MAX_MEMBERS,
  };
}

/**
 * `POST /board/members/add` — owner only. `{ project_id, email }`.
 *
 * The person must already have an account: this adds someone to a board, it does not invite
 * them to the product, and on a deployment with sign-up turned off there is no route by which
 * an email address alone could become one.
 */
export async function addMember(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const project = await resolveProject(caller, body.project_id, ctx.store, { ownerOnly: true });
  needAuthAdmin(ctx);
  const email = str(body.email, "email", { required: true, max: 320 }).trim().toLowerCase();

  // `q` is a substring match, so the exact identifier is checked here: adding "ann@x.com" must
  // not quietly add "joann@x.com" because the search found her first.
  const page = await ctx.env.auth.listUsers(authTarget(ctx), { q: email, limit: 50 });
  const user = ((page && page.users) || []).find((u) => String(u.identifier || "").toLowerCase() === email);
  if (!user) {
    throw notFound(`no account uses '${email}' — they need one before they can be added to a board`);
  }
  if (user.uid === project.owner_uid) throw badRequest("that is the board's owner, who is already on it");

  const key = memberKey(project.key, user.uid);
  const existing = await ctx.store.get("memberships", key);
  if (existing) return { ok: true, member: memberView(existing), already: true };

  const [onBoard, theirBoards] = await Promise.all([
    ctx.store.countAtMost("memberships", [{ field: "project_id", op: "=", value: project.key }], MAX_MEMBERS),
    ctx.store.countAtMost("memberships", [{ field: "uid", op: "=", value: user.uid }], MAX_SHARED_BOARDS),
  ]);
  if (onBoard >= MAX_MEMBERS) throw badRequest(`this board already has ${MAX_MEMBERS} members, which is the limit`);
  if (theirBoards >= MAX_SHARED_BOARDS) {
    throw conflict(`${email} is already a member of ${MAX_SHARED_BOARDS} boards, which is the limit`);
  }

  const row = {
    project_id: project.key,
    uid: user.uid,
    identifier: user.identifier,
    name: (user.profile && user.profile.name) || "",
    owner_uid: project.owner_uid,
    added_by: caller.uid,
    created_at: Date.now(),
  };
  // The row first, then the claim. If the claim write fails the member can already work on the
  // board through this function, and their next page load repairs the claim — the reverse
  // order could leave a claim granting reads with no row behind it.
  await ctx.store.putOne("memberships", key, row);
  await writeBoardsClaim(ctx, user.uid).catch((err) => console.log("claim write failed (healed on next load):", err && err.message));
  return { ok: true, member: memberView(row) };
}

/** `POST /board/members/remove` — owner only. `{ project_id, uid }`. Writes stop at once;
 *  direct reads stop when the member's current token expires. */
export async function removeMember(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const project = await resolveProject(caller, body.project_id, ctx.store, { ownerOnly: true });
  needAuthAdmin(ctx);
  const uid = str(body.uid, "uid", { required: true, max: 64 });
  if (uid === project.owner_uid) throw forbidden("the owner cannot be removed from their own board");

  const key = memberKey(project.key, uid);
  const existing = await ctx.store.get("memberships", key);
  if (!existing) return { ok: true, removed: false };
  await ctx.store.delete("memberships", [key]);
  await writeBoardsClaim(ctx, uid).catch((err) => console.log("claim write failed (healed on next load):", err && err.message));
  return { ok: true, removed: true, uid };
}

/**
 * Everyone off a board that is being deleted, and the board out of each of their claims.
 *
 * Claim writes are best-effort. A claim naming a board that no longer exists grants nothing —
 * there are no rows left carrying that `project_id` — and it is corrected the next time that
 * person loads the console.
 */
export async function sweepMembers(ctx, projectKey) {
  let total = 0;
  for (;;) {
    const { rows } = await ctx.store.query("memberships", {
      where: [{ field: "project_id", op: "=", value: projectKey }],
      limit: SWEEP_PAGE,
    });
    if (!rows.length) return total;
    await ctx.store.delete("memberships", rows.map((r) => r.key));
    total += rows.length;
    if (ctx.env.auth && typeof ctx.env.auth.setClaims === "function") {
      for (const r of rows) {
        await writeBoardsClaim(ctx, r.uid).catch(() => {});
      }
    }
    if (rows.length < SWEEP_PAGE) return total;
  }
}

/** Boards shared with this person, as the board list shows them. Takes the ids `syncAccess`
 *  already read, rather than querying the same rows twice in one request. */
export async function sharedBoards(ctx, ids) {
  if (!ids.length) return [];
  const found = await ctx.store.getMany("projects", ids);
  return ids
    .map((id) => found.get(id))
    .filter(Boolean)
    .map((p) => ({ project_id: p.key, name: p.name, created_at: p.created_at, owner_name: p.owner_name || "", role: "member" }));
}
