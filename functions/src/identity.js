// Who is calling, and what they may touch.
//
// A function URL is public, so this is the whole trust boundary. Three kinds of caller
// reach it and they authenticate differently on purpose:
//
//   agent    `Authorization: Bearer db_…` — a project token. Only its SHA-256 is stored,
//            so the row this resolves to IS the authorisation: the token names exactly one
//            project and an agent can never name another.
//   machine  `Authorization: Bearer dbm_…` — a machine key, held by a `dutyboard` daemon.
//            One key reaches every board the machine is LINKED to, and nothing else. A call
//            about a board names it in `x-dutyboard-board`; the link row for that board is
//            the authorisation, and the caller then becomes an agent on that one board, so
//            every duty endpoint treats it exactly like a project token. Without the header
//            it can only reach the /machine/* routes about itself.
//   human    `Authorization: Bearer <id_token>` — an end-user identity token from the auth
//            instance, verified by the platform (the signing secret never enters this code).
//            A human owns boards, or is a member of someone else's; both are checked per
//            request, against rows rather than against anything the token claims.
//
// The prefixes are what tell them apart, which is also why keys and tokens carry them.

import { unauthorized, forbidden, notFound, badRequest } from "./http.js";
import { sha256Hex } from "./ids.js";

const AGENT_TOKEN_PREFIX = "db_";
const MACHINE_KEY_PREFIX = "dbm_";

export const linkKey = (projectId, machineId) => `${projectId}:${machineId}`;

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
 *   { kind: "human", uid, name, email, claims }
 */
export async function identify(request, env, cfg, store) {
  const token = bearer(request);
  if (!token) throw unauthorized("send an Authorization: Bearer header (a db_… project token, a dbm_… machine key, or an end-user id_token)");

  if (token.startsWith(MACHINE_KEY_PREFIX)) return identifyMachine(request, token, store);

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
    // The server-set claims this token was issued with. Read ONLY to tell whether the token is
    // out of date (see members.js) — never to authorise anything here, because a token can be
    // up to an hour older than the membership rows it would be vouching for.
    claims: (identity.claims && typeof identity.claims === "object" && identity.claims) || {},
  };
}

/**
 * A machine key, and — when the request names a board — the link that lets it act there.
 *
 * Two point reads: the machine by its key's hash, the link by `<board>:<machine>`. The link is
 * checked on every request rather than cached on the machine row, so unlinking a board, removing
 * a member, or taking away their permission to run agents takes effect on the very next call.
 */
async function identifyMachine(request, token, store) {
  const key = sha256Hex(token);
  const machine = await store.get("machines", key);
  if (!machine || machine.revoked) throw unauthorized("machine key is not valid");
  const base = {
    machineId: machine.machine_id,
    machineKey: key,
    machineRow: machine,
    ownerUid: machine.owner_uid,
    agentPrefix: machine.agent_prefix,
  };

  const board = (request.headers.get("x-dutyboard-board") || "").trim();
  if (!board) return { kind: "machine", ...base };
  if (board.length > 60) throw badRequest("'x-dutyboard-board' is not a board id");

  const link = await store.get("machine_links", linkKey(board, machine.machine_id));
  if (!link) throw forbidden(`this machine is not linked to board '${board}'`);
  return {
    kind: "agent",
    projectId: board,
    tokenName: machine.name || "",
    // A machine's sessions are `<prefix>/1`, `<prefix>/2`, …; a call that names none is the
    // machine itself, which is still an agent id this board will accept from it.
    defaultAgentId: machine.agent_prefix,
    ...base,
    link,
  };
}

/**
 * Refuse an agent id a machine may not use.
 *
 * A project token may call itself anything — that is the contract it was minted under. A machine
 * may not: its agent ids are how the console tells two people's laptops apart on a shared board,
 * and a machine that could sign as another would put work in someone else's name.
 */
export function checkAgentId(caller, agentId) {
  if (!caller.machineId || !agentId) return agentId;
  const prefix = caller.agentPrefix;
  if (agentId !== prefix && !agentId.startsWith(prefix + "/")) {
    throw forbidden(`this machine's agent ids are '${prefix}' and '${prefix}/<n>', not '${agentId}'`);
  }
  return agentId;
}

/** Only a machine key reaches the /machine/* routes. Naming a board as well is harmless. */
export function requireMachine(caller) {
  if (!caller.machineId) throw forbidden("this endpoint is for a dutyboard machine key");
  return caller;
}

export const memberKey = (projectId, uid) => `${projectId}:${uid}`;

/** Is this person a member of the board? Memoised on the caller, so a request that asks about
 *  the same board twice reads the row once. */
export async function isMember(caller, store, projectId) {
  if (!caller._memberships) caller._memberships = new Map();
  if (!caller._memberships.has(projectId)) {
    const row = await store.get("memberships", memberKey(projectId, caller.uid));
    caller._memberships.set(projectId, !!row);
  }
  return caller._memberships.get(projectId);
}

const OWNER_ONLY = "only the board's owner can do that";

/**
 * Resolve the project this call is about and confirm the caller may act on it.
 *
 * An agent never chooses: its token names the project, and a `project_id` in the body
 * that disagrees is refused rather than ignored — an agent pointed at the wrong board
 * should find out immediately, not write to the right one and believe otherwise.
 *
 * A person may act on a board they own or are a member of. `ownerOnly` is for what a member
 * may not do: delete or rename the board, change who is on it, mint or revoke its agent
 * tokens, delete a duty. Everything else — the work on the board — a member may.
 */
const NAME_THE_BOARD = "a machine key acts on a board only when the request names it — send x-dutyboard-board";

export async function resolveProject(caller, requestedId, store, { ownerOnly = false } = {}) {
  if (caller.kind === "machine") throw forbidden(NAME_THE_BOARD);
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
  if (project.owner_uid === caller.uid) return project;
  if (await isMember(caller, store, project.key)) {
    if (ownerOnly) throw forbidden(OWNER_ONLY);
    return project;
  }
  throw forbidden(`you do not own project '${requestedId}'`);
}

/**
 * The same check as `resolveProject`, for a call that already holds the duty — and with
 * no second read.
 *
 * A duty row carries `project_id` and `owner_uid`, which are the only two facts
 * `resolveProject` goes to the projects collection to find out. Every duty-scoped
 * endpoint was paying a point read to learn something it already had in its hand.
 *
 * It does not check that the project still exists, and does not need to: deleting a board
 * sweeps its duties in the same request, so a duty whose project is gone is not a state
 * this can observe. If that ever stops being true, this is the comment that is wrong.
 */
export async function projectOfDuty(caller, duty, store, { ownerOnly = false } = {}) {
  if (caller.kind === "machine") throw forbidden(NAME_THE_BOARD);
  if (caller.kind === "agent") {
    if (duty.project_id !== caller.projectId) {
      // Deliberately the same words as a missing duty. A token scoped to one board must
      // not be able to learn that a duty id on another board exists.
      throw notFound(`duty '${duty.key}' not found`);
    }
  } else if (duty.owner_uid !== caller.uid) {
    // Not the owner: a member, or nobody. A member costs one point read, memoised; a stranger
    // gets the same answer as a missing duty, for the same reason an agent does.
    if (!(await isMember(caller, store, duty.project_id))) throw notFound(`duty '${duty.key}' not found`);
    if (ownerOnly) throw forbidden(OWNER_ONLY);
  }
  return { key: duty.project_id, owner_uid: duty.owner_uid };
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
