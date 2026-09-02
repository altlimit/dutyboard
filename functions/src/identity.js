// Who is calling, and what they may touch.
//
// A function URL is public, so this is the whole trust boundary. Two kinds of caller
// reach it and they authenticate differently on purpose:
//
//   agent  `Authorization: Bearer db_…` — a project token. Only its SHA-256 is stored,
//          so the row this resolves to IS the authorisation: the token names exactly one
//          project and an agent can never name another.
//   human  `Authorization: Bearer <id_token>` — an end-user identity token from the auth
//          instance, verified by the platform (the signing secret never enters this code).
//          A human owns projects; ownership is checked per request.
//
// The `db_` prefix is what tells them apart, which is also why tokens carry it.

import { unauthorized, forbidden, notFound } from "./http.js";
import { sha256Hex } from "./ids.js";

const AGENT_TOKEN_PREFIX = "db_";

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
}

/**
 * Resolve the caller. Throws 401 when there is no usable credential.
 *
 * Returns either
 *   { kind: "agent", projectId, tokenKey, tokenName, defaultAgentId }
 *   { kind: "human", uid, name, email }
 */
export async function identify(request, env, cfg, store) {
  const token = bearer(request);
  if (!token) throw unauthorized("send an Authorization: Bearer header (a db_… project token, or an end-user id_token)");

  if (token.startsWith(AGENT_TOKEN_PREFIX)) {
    const key = sha256Hex(token);
    const row = await store.get("tokens", key);
    // A revoked token is deliberately indistinguishable from a wrong one: a caller who
    // should no longer be here learns nothing about whether the token ever existed.
    if (!row || row.revoked) throw unauthorized("project token is not valid");
    return {
      kind: "agent",
      projectId: row.project_id,
      tokenKey: key,
      tokenName: row.name || "",
      defaultAgentId: row.default_agent_id || "",
      ownerUid: row.owner_uid || "",
      // Kept so `noteTokenUse` can stamp last-used without reading the row a second time.
      tokenRow: row,
    };
  }

  if (!env.auth) throw unauthorized("this deployment has no auth grant, so only db_… project tokens are accepted");
  const identity = await env.auth.verifyToken({ instance: cfg.authInstance }, token);
  // The verified claims name the end user in `sub` (the JWT subject). `uid` is accepted
  // too so this keeps working if the platform ever aliases it — but `sub` is what the
  // token actually carries, and reading only `uid` silently rejects every real caller.
  const uid = identity && (identity.sub || identity.uid);
  if (!uid) throw unauthorized("identity token is not valid");
  return {
    kind: "human",
    uid,
    name: (identity.profile && identity.profile.name) || identity.identifier || "someone",
    email: identity.email || identity.identifier || "",
  };
}

/**
 * Resolve the project this call is about and confirm the caller may act on it.
 *
 * An agent never chooses: its token names the project, and a `project_id` in the body
 * that disagrees is refused rather than ignored — an agent pointed at the wrong board
 * should find out immediately, not write to the right one and believe otherwise.
 */
export async function resolveProject(caller, requestedId, store) {
  if (caller.kind === "agent") {
    if (requestedId && requestedId !== caller.projectId) {
      throw forbidden(`this token is scoped to project '${caller.projectId}'`);
    }
    const project = await store.get("projects", caller.projectId);
    if (!project) throw notFound(`project '${caller.projectId}' no longer exists`);
    return project;
  }
  if (!requestedId) throw forbidden("'project_id' is required");
  const project = await store.get("projects", requestedId);
  if (!project) throw notFound(`project '${requestedId}' not found`);
  if (project.owner_uid !== caller.uid) throw forbidden(`you do not own project '${requestedId}'`);
  return project;
}

/** Only a human owns things; agents act inside a project a human already owns. */
export function requireHuman(caller) {
  if (caller.kind !== "human") throw forbidden("this endpoint is for signed-in people, not agent tokens");
  return caller;
}

export function requireAgent(caller) {
  if (caller.kind !== "agent") throw forbidden("this endpoint is for agent project tokens");
  return caller;
}

/** How a thread entry is attributed. Agents sign with the agent id they claimed under. */
export function authorOf(caller, agentId) {
  return caller.kind === "agent"
    ? { author_type: "agent", author_id: agentId || caller.tokenName || "agent" }
    : { author_type: "human", author_id: caller.uid, author_name: caller.name };
}
