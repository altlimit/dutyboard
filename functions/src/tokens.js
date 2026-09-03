// Agent project tokens.
//
// Only the SHA-256 of a token is stored, and the row's key IS that hash — so verifying
// a token is a single point-read with no query and no scan, and a stolen database gives
// up no working credential. The plaintext is returned exactly once, at mint.
//
// The hash is safe to show its owner (it is not reversible), which is what lets the
// console list and revoke tokens by id without the platform ever holding the secret.

import { badRequest, notFound, forbidden, str, intIn } from "./http.js";
import { mintToken, sha256Hex } from "./ids.js";
import { requireHuman, resolveProject } from "./identity.js";

/** `POST /tokens/mint` — returns the one and only copy of the token. */
/** Live tokens per board. A token is a credential; a board accumulating hundreds of them
 *  is a board nobody is revoking, which is the state this is meant to make visible. */
const MAX_TOKENS = 50;

export async function createToken(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);

  const existing = await ctx.store.countAtMost(
    "tokens",
    [{ field: "project_id", op: "=", value: project.key }],
    MAX_TOKENS,
  );
  if (existing >= MAX_TOKENS) {
    throw badRequest(`this board has ${MAX_TOKENS} agent tokens, which is the limit — revoke some before minting more`);
  }
  const name = str(body.name, "name", { required: true, max: 80 });
  const defaultAgentId = str(body.default_agent_id, "default_agent_id", { max: 64, fallback: "" });
  const now = Date.now();

  const token = mintToken();
  const key = sha256Hex(token);
  await ctx.store.putOne("tokens", key, {
    project_id: project.key,
    owner_uid: caller.uid,
    name,
    default_agent_id: defaultAgentId || null,
    // Enough of the token to recognise which one is on which machine, and no more.
    hint: token.slice(0, 7) + "…" + token.slice(-4),
    revoked: false,
    created_at: now,
    last_used_at: null,
  });

  return { token, token_id: key, project_id: project.key, name, default_agent_id: defaultAgentId || null };
}

/** `POST /tokens/list` — names and hints only; the values are gone. */
export async function listTokens(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const limit = intIn(body.limit, "limit", 1, 100, 50);
  const { rows, cursor } = await ctx.store.query("tokens", {
    where: [{ field: "project_id", op: "=", value: project.key }],
    order: [{ field: "created_at", dir: "desc" }],
    limit,
    cursor: body.cursor || undefined,
  });
  return {
    tokens: rows.map((t) => ({
      token_id: t.key,
      name: t.name,
      hint: t.hint,
      default_agent_id: t.default_agent_id || null,
      revoked: !!t.revoked,
      created_at: t.created_at,
      last_used_at: t.last_used_at || null,
    })),
    cursor,
  };
}

/** `POST /tokens/revoke` — the row stays, marked, so a revoked token's last use
 *  is still visible. `identify` refuses it from the next request onward. */
export async function revokeToken(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const id = str(body.token_id, "token_id", { required: true, max: 128 });
  const row = await ctx.store.get("tokens", id);
  if (!row) throw notFound(`token '${id}' not found`);
  if (row.project_id !== project.key) throw forbidden("that token belongs to another project");

  const { key, _created, _updated, ...data } = row;
  await ctx.store.putOne("tokens", id, { ...data, revoked: true, revoked_at: Date.now() });
  return { ok: true, token_id: id };
}

/** Record that a token was used. Best-effort and never on the critical path — a write
 *  on every agent call is real cost, so this only fires once a minute per token. */
export async function noteTokenUse(ctx, caller) {
  if (caller.kind !== "agent") return;
  // `identify` already read this row to authenticate the call — reading it again would
  // double the cost of every agent request for a field nobody is waiting on.
  const row = caller.tokenRow;
  if (!row) return;
  const now = Date.now();
  if (row.last_used_at && now - row.last_used_at < 60_000) return;
  const { key, _created, _updated, ...data } = row;
  await ctx.store.putOne("tokens", caller.tokenKey, { ...data, last_used_at: now });
}
