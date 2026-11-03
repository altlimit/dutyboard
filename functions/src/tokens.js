// Agent project tokens.
//
// Only the SHA-256 of a token is stored, and the row's key IS that hash — so verifying
// a token is a single point-read with no query and no scan, and a stolen database gives
// up no working credential. The plaintext is returned exactly once, at mint.
//
// The hash is safe to show its owner (it is not reversible), which is what lets the
// console list and revoke tokens by id without the platform ever holding the secret.
//
// A token has a scope. `agent` — every token before scopes existed — works the board: poll,
// claim, complete, everything an agent does. `submit` is for software outside the board, a CI
// job or someone's backend: it files duties and follows the ones IT filed, and nothing else. It
// cannot claim work, see other duties, or finish anything; what it files is done by the board's
// agents like any other duty, and it learns the outcome by polling `/duty/changes` or from its
// webhook (webhooks.js).

import { badRequest, notFound, forbidden, str, intIn, oneOf } from "./http.js";
import { mintToken, sha256Hex } from "./ids.js";
import { requireHuman, resolveProject } from "./identity.js";
import { dropWebhook, webhookSettings, webhooksOf } from "./webhooks.js";

export const TOKEN_SCOPES = ["agent", "submit"];

/** A board's machines link at most this many times; read whole to check a reservation. */
const MAX_RUNNERS_READ = 20;

/** The agent prefixes of the machines linked to a board — what a duty can be reserved to and
 *  actually be picked up. */
export async function runnerPrefixes(ctx, projectKey) {
  const { rows } = await ctx.store.query("machine_links", {
    where: [{ field: "project_id", op: "=", value: projectKey }],
    limit: MAX_RUNNERS_READ,
  });
  return rows.map((l) => l.agent_prefix).filter(Boolean);
}

/** `reserve_for` on a token: one of the board's runners, or none. */
async function pinFrom(ctx, projectKey, v) {
  const pin = str(v, "reserve_for", { max: 64, fallback: "" });
  if (!pin) return null;
  const prefixes = await runnerPrefixes(ctx, projectKey);
  if (!prefixes.includes(pin)) {
    throw badRequest(
      prefixes.length
        ? `'reserve_for' must be one of this board's runners: ${prefixes.join(", ")}`
        : "this board has no runners to reserve work for — link a machine first",
    );
  }
  return pin;
}

/** `POST /tokens/mint` — returns the one and only copy of the token.
 *
 * Every token endpoint is the OWNER's alone. A token is how software gets onto a board, and
 * who may hand that out is exactly what a member is not trusted with. */
/** Live tokens per board. A token is a credential; a board accumulating hundreds of them
 *  is a board nobody is revoking, which is the state this is meant to make visible. */
const MAX_TOKENS = 50;

export async function createToken(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });

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
  const scope = oneOf(body.scope, "scope", TOKEN_SCOPES, "agent");
  const reserveFor = await pinFrom(ctx, project.key, body.reserve_for);
  const now = Date.now();

  const token = mintToken();
  const key = sha256Hex(token);
  await ctx.store.putOne("tokens", key, {
    project_id: project.key,
    owner_uid: caller.uid,
    name,
    default_agent_id: defaultAgentId || null,
    scope,
    // Where every duty it files is reserved, when the owner has decided that for it.
    reserve_for: reserveFor,
    // Enough of the token to recognise which one is on which machine, and no more.
    hint: token.slice(0, 7) + "…" + token.slice(-4),
    revoked: false,
    created_at: now,
    last_used_at: null,
  });

  return { token, token_id: key, project_id: project.key, name, default_agent_id: defaultAgentId || null, scope, reserve_for: reserveFor };
}

/** `POST /tokens/update` — what a token may be changed in after it is minted: its name, and where
 *  the duties it files go. Its scope is not among them: a token that could be widened is a token
 *  nobody can reason about from where it was handed out. */
export async function updateToken(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const id = str(body.token_id, "token_id", { required: true, max: 128 });
  const row = await ctx.store.get("tokens", id);
  if (!row || row.project_id !== project.key) throw notFound(`token '${id}' not found`);
  const { key, _created, _updated, ...data } = row;
  const next = { ...data };
  if (body.name !== undefined) next.name = str(body.name, "name", { required: true, max: 80 });
  if (body.reserve_for !== undefined) next.reserve_for = await pinFrom(ctx, project.key, body.reserve_for);
  await ctx.store.putOne("tokens", id, next);
  return { ok: true, token_id: id, name: next.name, reserve_for: next.reserve_for || null };
}

/** `POST /tokens/list` — names and hints only; the values are gone. */
export async function listTokens(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const limit = intIn(body.limit, "limit", 1, 100, 50);
  const [{ rows, cursor }, hooks, settings] = await Promise.all([
    ctx.store.query("tokens", {
      where: [{ field: "project_id", op: "=", value: project.key }],
      order: [{ field: "created_at", dir: "desc" }],
      limit,
      cursor: body.cursor || undefined,
    }),
    webhooksOf(ctx, project.key, MAX_TOKENS),
    webhookSettings(ctx),
  ]);
  return {
    tokens: rows.map((t) => ({
      token_id: t.key,
      name: t.name,
      hint: t.hint,
      default_agent_id: t.default_agent_id || null,
      scope: t.scope || "agent",
      reserve_for: t.reserve_for || null,
      revoked: !!t.revoked,
      created_at: t.created_at,
      last_used_at: t.last_used_at || null,
      webhook: hooks.get(t.key) || null,
    })),
    cursor,
    // What a webhook URL may point at here, so the console can say before it is refused.
    webhook_hosts: settings.ready ? settings.hosts : [],
  };
}

/** `POST /tokens/revoke` — the row stays, marked, so a revoked token's last use
 *  is still visible. `identify` refuses it from the next request onward. */
export async function revokeToken(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const id = str(body.token_id, "token_id", { required: true, max: 128 });
  const row = await ctx.store.get("tokens", id);
  if (!row) throw notFound(`token '${id}' not found`);
  if (row.project_id !== project.key) throw forbidden("that token belongs to another project");

  const { key, _created, _updated, ...data } = row;
  await ctx.store.putOne("tokens", id, { ...data, revoked: true, revoked_at: Date.now() });
  await dropWebhook(ctx, id);
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
