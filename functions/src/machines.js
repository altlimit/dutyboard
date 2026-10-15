// Machines — a `dutyboard` daemon, the boards it works, and how it got in.
//
// PAIRING is a device flow, because the daemon runs in a terminal and the person approving it is
// signed in somewhere else:
//
//   daemon  POST /connect/start  → a device_code it keeps, and a user_code it prints
//   person  opens <console>/#/pair, types the user_code, approves        (/connect/lookup, /approve)
//   daemon  POST /connect/poll every few seconds → once approved, the machine key, exactly once
//
// The key is MINTED at that last poll, not at approval, so its plaintext is never stored even for
// a moment. Two polls racing for it cannot both get one: the machine row carries the pairing id
// under a unique index, and it is written in the same transaction that deletes the pairing.
//
// A LINK is a machine allowed to work one board: `machine_links/<board>:<machine>`. `identify()`
// reads it on every call that names a board, so removing it — by the machine, its owner, the
// board's owner, or by taking a member's permission to run agents away — cuts the machine off on
// its next request. Who may link: the board's owner, or a member the owner has let run agents.
//
// Everything a daemon needs to decide what to do is one call, `/machine/poll`, across every board
// it is linked to. It calls it on start, on reconnect, when a session ends, and every fifteen
// minutes; board channel events tell it when to call sooner.

import { badRequest, conflict, forbidden, notFound, str, oneOf, intIn } from "./http.js";
import { mintMachineKey, mintDeviceCode, userCode, machineId, requestId, sha256Hex, slugify } from "./ids.js";
import { putOp, deleteOp } from "./store.js";
import { requireHuman, requireMachine, resolveProject, memberKey, linkKey } from "./identity.js";
import { liveConfigured, mintMachineLive, machinesPresent, publishMachine } from "./live.js";
import { runnableDuties, activeDuties, seedDuty, stripMeta, blockBehindSetup } from "./duties.js";
import { isFilesBoard, mergeRunner, profileView, repoUrl } from "./profile.js";
import { createProjectFor } from "./projects.js";
import { runDueSchedules } from "./schedules.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_POLL_SECONDS = 3;

/** Machines one person may have paired. A person with more computers than this is running a farm,
 *  and a farm should say so to whoever runs this deployment. */
const MAX_MACHINES = 20;
/** Boards one machine works. Also the size of its channel token (one channel per board). */
const MAX_LINKS = 25;
/** Machines on one board. */
const MAX_LINKS_PER_BOARD = 20;
/** Setup requests waiting on one machine. */
const MAX_PENDING_REQUESTS = 20;
/** Duties a daemon reports as in flight on one board, per `/machine/state`. */
const MAX_RUNS = 20;
/** `last_seen_at` is written at most this often per machine: it is a hint, not a heartbeat. */
const TOUCH_EVERY_MS = 60_000;

/**
 * The first `dutyboard` that can work a board with no repository. An older one reads such a board as
 * a repository whose URL is missing, and says so — which sends its owner to the board's settings to
 * fix something that is not wrong. It is told to update itself instead.
 */
const FILES_RUNNER = "2.18.0";

/** Whether release `a` is older than release `b`. A build with no release number is never older. */
function olderRelease(a, b) {
  const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "")) || []).slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Why the calling machine cannot work `project`, when it is too old to; "" when it can. */
function runnerTooOld(ctx, project, machineName) {
  return tooOldFor(project, ctx.clientVersion || (ctx.caller.machineRow && ctx.caller.machineRow.cli_version) || "", machineName);
}

/** Why a machine running `version` cannot work `project`; "" when it can. */
function tooOldFor(project, version, machineName) {
  if (!isFilesBoard(project) || !olderRelease(version, FILES_RUNNER)) return "";
  return `${machineName || "this machine"} runs dutyboard ${version}, which cannot work a board without a repository — ` +
    `update it to ${FILES_RUNNER} or later: on it, run \`alt update altlimit/dutyboard && dutyboard --service\``;
}

export const RUN_STATES = ["working", "integrating", "parked", "limited", "waiting", "error"];
const REMOTE_SETUP = ["auto", "ask"];
const UNFINISHED = ["queued", "active", "needs_decision", "blocked"];

const machineView = (m, { online = null, links = [], requests = [] } = {}) => ({
  machine_id: m.machine_id,
  name: m.name,
  agent_prefix: m.agent_prefix,
  os: m.os || "",
  arch: m.arch || "",
  cli_version: m.cli_version || "",
  paused: !!m.paused,
  max_sessions: m.max_sessions || 3,
  remote_setup: m.remote_setup || "auto",
  workspace_root: m.workspace_root || "",
  created_at: m.created_at,
  last_seen_at: m.last_seen_at || null,
  online,
  links,
  requests,
});

const linkView = (l) => ({
  project_id: l.project_id,
  machine_id: l.machine_id,
  machine_name: l.machine_name || "",
  agent_prefix: l.agent_prefix,
  path_hint: l.path_hint || "",
  runs: l.runs || [],
  problem: l.problem || "",
  runs_at: l.runs_at || null,
  created_at: l.created_at,
});

const requestView = (r) => ({
  request_id: r.key,
  machine_id: r.machine_id,
  project_id: r.project_id,
  kind: r.kind,
  path: r.path || "",
  repo_url: r.repo_url || "",
  // For a create_repo request: the GitHub repository to make.
  repo: r.repo || null,
  status: r.status,
  result: r.result || "",
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** `m_01J…` → `faisal-wsl-7k2q`. The suffix is what keeps two people's "laptop" apart on one board,
 *  where agent ids have to be unique. */
const agentPrefixFor = (name, id) => `${slugify(name, "machine").slice(0, 40)}-${id.slice(-4).toLowerCase()}`;

// --- pairing -----------------------------------------------------------------------------

/** `POST /connect/start` — no credential. `{ name, os?, arch?, cli_version? }`. */
export async function startPairing(ctx, body) {
  const name = str(body.name, "name", { required: true, max: 60 });
  const now = Date.now();

  // Nothing else ever removes a pairing nobody finished, and this door is unauthenticated, so the
  // one that makes them also cleans up after them — a page at a time, never all at once.
  const { rows: stale } = await ctx.store.query("pairings", {
    where: [{ field: "expires_at", op: "<", value: now }],
    limit: 50,
    keys_only: true,
  });
  if (stale.length) await ctx.store.delete("pairings", stale.map((r) => r.key));

  await ctx.store.ensureUniqueIndex("pairings", ["user_code"]);
  const deviceCode = mintDeviceCode();
  const row = {
    status: "pending",
    machine_name: name,
    os: str(body.os, "os", { max: 30 }),
    arch: str(body.arch, "arch", { max: 30 }),
    cli_version: str(body.cli_version, "cli_version", { max: 40 }),
    created_at: now,
    expires_at: now + PAIRING_TTL_MS,
  };
  // A user code colliding with a live one is a 1-in-a-trillion event, and the unique index turns
  // it into a failed write rather than two machines behind one code. Try again with a new code.
  for (let attempt = 0; ; attempt++) {
    const code = userCode();
    try {
      await ctx.store.transaction([putOp("pairings", sha256Hex(deviceCode), { ...row, user_code: code })]);
      return {
        device_code: deviceCode,
        user_code: code,
        expires_in: PAIRING_TTL_MS / 1000,
        interval: PAIRING_POLL_SECONDS,
        verify_path: "/#/pair",
        console_url: ctx.cfg.consoleUrl || null,
      };
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/** The pairing a person is looking at, by the code they typed. Codes are read case- and
 *  hyphen-insensitively, because people type them both ways. */
async function pairingByCode(ctx, raw) {
  const compact = str(raw, "user_code", { required: true, max: 20 }).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 8) throw notFound("no pairing is waiting on that code");
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  const { rows } = await ctx.store.query("pairings", { where: [{ field: "user_code", op: "=", value: code }], limit: 1 });
  const row = rows[0];
  // Expired and never-existed read the same, so a code cannot be probed for whether it was real.
  if (!row || row.expires_at < Date.now()) throw notFound("no pairing is waiting on that code — it may have expired");
  return row;
}

/** `POST /connect/lookup` — what a person is about to approve. */
export async function lookupPairing(ctx, body) {
  requireHuman(ctx.caller);
  const row = await pairingByCode(ctx, body.user_code);
  return {
    user_code: row.user_code,
    status: row.status,
    machine_name: row.machine_name,
    os: row.os,
    arch: row.arch,
    cli_version: row.cli_version,
    expires_at: row.expires_at,
  };
}

/** `POST /connect/approve` — `{ user_code, name? }`. The machine becomes the approver's. */
export async function approvePairing(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const row = await pairingByCode(ctx, body.user_code);
  if (row.status !== "pending") throw conflict(`that pairing is already ${row.status}`);
  const owned = await ctx.store.countAtMost("machines", [{ field: "owner_uid", op: "=", value: caller.uid }], MAX_MACHINES);
  if (owned >= MAX_MACHINES) {
    throw badRequest(`you already have ${MAX_MACHINES} machines paired, which is the limit — revoke one first`);
  }
  const name = str(body.name, "name", { max: 60 }) || row.machine_name;
  await ctx.store.putOne("pairings", row.key, {
    ...stripMeta(row),
    status: "approved",
    machine_name: name,
    approved_by: caller.uid,
    approved_name: caller.name,
  });
  return { ok: true, user_code: row.user_code, machine_name: name };
}

/** `POST /connect/deny` — the daemon's next poll hears no, and the code stops working. */
export async function denyPairing(ctx, body) {
  requireHuman(ctx.caller);
  const row = await pairingByCode(ctx, body.user_code);
  if (row.status !== "pending") throw conflict(`that pairing is already ${row.status}`);
  await ctx.store.putOne("pairings", row.key, { ...stripMeta(row), status: "denied" });
  return { ok: true, user_code: row.user_code };
}

/** `POST /connect/poll` — no credential; the device code is the credential. */
export async function pollPairing(ctx, body) {
  const deviceCode = str(body.device_code, "device_code", { required: true, max: 100 });
  const key = sha256Hex(deviceCode);
  const row = await ctx.store.get("pairings", key);
  if (!row || row.expires_at < Date.now()) {
    if (row) await ctx.store.delete("pairings", [key]);
    throw notFound("no such pairing — it expired, or its key was already handed over; start again");
  }
  if (row.status === "pending") return { status: "pending", interval: PAIRING_POLL_SECONDS };
  if (row.status === "denied") {
    await ctx.store.delete("pairings", [key]);
    return { status: "denied" };
  }

  const now = Date.now();
  const id = machineId();
  const machineKey = mintMachineKey();
  const machine = {
    machine_id: id,
    owner_uid: row.approved_by,
    owner_name: row.approved_name || "",
    name: row.machine_name,
    agent_prefix: agentPrefixFor(row.machine_name, id),
    os: row.os || "",
    arch: row.arch || "",
    cli_version: row.cli_version || "",
    pairing_id: key,
    workspace_root: "",
    remote_setup: "auto",
    max_sessions: 3,
    paused: false,
    created_at: now,
    last_seen_at: now,
  };
  await ctx.store.ensureUniqueIndex("machines", ["pairing_id"]);
  try {
    await ctx.store.transaction([putOp("machines", sha256Hex(machineKey), machine), deleteOp("pairings", key)]);
  } catch (err) {
    if (/unique|ALREADY_EXISTS/i.test(String((err && (err.code || err.message)) || ""))) {
      throw conflict("this pairing's key was already handed to another poll");
    }
    throw err;
  }
  return {
    status: "approved",
    machine_key: machineKey,
    machine_id: id,
    name: machine.name,
    agent_prefix: machine.agent_prefix,
    owner_name: machine.owner_name,
  };
}

// --- a person's machines -----------------------------------------------------------------

async function linksOfMachines(ctx, ids) {
  if (!ids.length) return [];
  const { rows } = await ctx.store.query("machine_links", {
    where: [{ field: "machine_id", op: "in", value: ids }],
    limit: MAX_LINKS * ids.length,
  });
  return rows;
}

async function openRequests(ctx, machineIds) {
  if (!machineIds.length) return [];
  const { rows } = await ctx.store.query("machine_requests", {
    where: [
      { field: "machine_id", op: "in", value: machineIds },
      { field: "status", op: "in", value: ["pending", "running"] },
    ],
    limit: MAX_PENDING_REQUESTS * machineIds.length,
  });
  return rows;
}

/** A machine the calling person owns, by id. Someone else's reads as missing. */
async function ownMachine(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const id = str(body.machine_id, "machine_id", { required: true, max: 40 });
  const { rows } = await ctx.store.query("machines", { where: [{ field: "machine_id", op: "=", value: id }], limit: 1 });
  const row = rows[0];
  if (!row || row.owner_uid !== caller.uid) throw notFound(`machine '${id}' not found`);
  return row;
}

/** `POST /machines/list` — the caller's machines, whether each is online, and what each works. */
export async function listMachines(ctx) {
  const caller = requireHuman(ctx.caller);
  const { rows } = await ctx.store.query("machines", {
    where: [{ field: "owner_uid", op: "=", value: caller.uid }],
    order: [{ field: "created_at", dir: "desc" }],
    limit: MAX_MACHINES,
  });
  const ids = rows.map((m) => m.machine_id);
  const [links, requests, present] = await Promise.all([linksOfMachines(ctx, ids), openRequests(ctx, ids), machinesPresent(ctx, ids)]);
  const projects = await ctx.store.getMany("projects", [...new Set(links.map((l) => l.project_id))]);
  return {
    machines: rows.map((m) =>
      machineView(m, {
        online: present.get(m.machine_id),
        links: links
          .filter((l) => l.machine_id === m.machine_id)
          .map((l) => linkView({ ...l, problem: tooOldFor(projects.get(l.project_id), m.cli_version, m.name) || l.problem })),
        requests: requests.filter((r) => r.machine_id === m.machine_id).map(requestView),
      }),
    ),
    max_machines: MAX_MACHINES,
  };
}

/** `POST /machines/update` — `{ machine_id, name?, paused?, max_sessions?, remote_setup?, workspace_root? }`. */
export async function updateMachine(ctx, body) {
  const row = await ownMachine(ctx, body);
  const next = { ...stripMeta(row) };
  if (body.name != null) next.name = str(body.name, "name", { required: true, max: 60 });
  if (body.paused != null) next.paused = body.paused === true;
  if (body.max_sessions != null) next.max_sessions = intIn(body.max_sessions, "max_sessions", 1, 10, 3);
  if (body.remote_setup != null) next.remote_setup = oneOf(body.remote_setup, "remote_setup", REMOTE_SETUP);
  if (body.workspace_root != null) next.workspace_root = str(body.workspace_root, "workspace_root", { max: 300 });
  await ctx.store.putOne("machines", row.key, next);

  if (next.paused !== !!row.paused) await publishMachine(ctx, row.machine_id, { t: next.paused ? "pause" : "resume" });
  await publishMachine(ctx, row.machine_id, { t: "config" });
  return { ok: true, machine: machineView(next) };
}

/**
 * `POST /machines/revoke` — the key stops working, and every board forgets the machine.
 *
 * The row is deleted rather than marked: nothing about a revoked machine is worth keeping, and
 * the link rows that made it dangerous go with it. The daemon is told on its channel so it can
 * stop and forget the key rather than find out on its next 401.
 */
export async function revokeMachine(ctx, body) {
  const row = await ownMachine(ctx, body);
  const links = await sweep(ctx, "machine_links", [{ field: "machine_id", op: "=", value: row.machine_id }]);
  await sweep(ctx, "machine_requests", [{ field: "machine_id", op: "=", value: row.machine_id }]);
  await ctx.store.delete("machines", [row.key]);
  await publishMachine(ctx, row.machine_id, { t: "revoked" });
  for (const projectId of links) await ctx.publish(projectId, null, { t: "runner", machine_id: row.machine_id, state: "unlinked" });
  return { ok: true, machine_id: row.machine_id, unlinked: links.length };
}

/**
 * `POST /machines/retry` — `{ machine_id, project_id? }`. Has the machine check its boards again now —
 * clone, agent, keys — rather than at its next scheduled check, after a person fixed what it reported.
 * The machine's owner may ask, and so may the owner of a board it works, naming that board.
 */
export async function retryMachine(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const id = str(body.machine_id, "machine_id", { required: true, max: 40 });
  const { rows } = await ctx.store.query("machines", { where: [{ field: "machine_id", op: "=", value: id }], limit: 1 });
  const row = rows[0];
  if (!row) throw notFound(`machine '${id}' not found`);
  if (row.owner_uid !== caller.uid) {
    if (!body.project_id) throw notFound(`machine '${id}' not found`);
    const project = await resolveProject(caller, body.project_id, ctx.store, { ownerOnly: true });
    if (!(await ctx.store.get("machine_links", linkKey(project.key, id)))) throw notFound(`machine '${id}' not found`);
  }
  await publishMachine(ctx, id, { t: "retry", project_id: body.project_id ? String(body.project_id) : null });
  return { ok: true, online: (await machinesPresent(ctx, [id])).get(id) };
}

/**
 * `POST /machines/unlink` — `{ machine_id, project_id }`. Either the machine's owner, taking it off a
 * board, or the board's owner, taking someone's machine off their board.
 */
export async function unlinkMachineByPerson(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const id = str(body.machine_id, "machine_id", { required: true, max: 40 });
  const project = await resolveProject(caller, body.project_id, ctx.store);
  const link = await ctx.store.get("machine_links", linkKey(project.key, id));
  const isBoardOwner = project.owner_uid === caller.uid;
  if (!link) {
    if (!isBoardOwner) throw notFound(`machine '${id}' is not linked to '${project.key}'`);
    return { ok: true, removed: false };
  }
  if (!isBoardOwner && link.owner_uid !== caller.uid) throw forbidden("only the machine's owner or the board's owner can unlink it");
  await dropLink(ctx, link);
  return { ok: true, removed: true };
}

async function dropLink(ctx, link) {
  await ctx.store.delete("machine_links", [link.key]);
  await publishMachine(ctx, link.machine_id, { t: "links" });
  await ctx.publish(link.project_id, null, { t: "runner", machine_id: link.machine_id, state: "unlinked" });
}

/**
 * The machines working one board, whoever's they are — what the board's header and settings show.
 * Answers what each is doing there and whether it is online.
 */
export async function runnersOf(ctx, projectKey) {
  const { rows } = await ctx.store.query("machine_links", {
    where: [{ field: "project_id", op: "=", value: projectKey }],
    limit: MAX_LINKS_PER_BOARD,
  });
  const ids = rows.map((l) => l.machine_id);
  const [present, machines, project] = await Promise.all([machinesPresent(ctx, ids), machinesByIds(ctx, ids), ctx.store.get("projects", projectKey)]);
  return rows.map((l) => ({
    ...linkView({ ...l, problem: tooOldFor(project, (machines.get(l.machine_id) || {}).cli_version, l.machine_name) || l.problem }),
    owner_uid: l.owner_uid,
    online: present.get(l.machine_id),
    // What it is actually running. A board where one machine is three versions behind looks like a
    // board with a mystery, until this says which machine it is.
    cli_version: (machines.get(l.machine_id) || {}).cli_version || "",
  }));
}

/** The machine rows behind a set of ids, keyed by id. */
async function machinesByIds(ctx, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await ctx.store.query("machines", { where: [{ field: "machine_id", op: "in", value: ids }], limit: ids.length });
  for (const m of rows) out.set(m.machine_id, m);
  return out;
}

/** `POST /board/runners` — anyone on the board. */
export async function boardRunners(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const project = await resolveProject(caller, body.project_id, ctx.store);
  const [runners, repoRequest] = await Promise.all([
    runnersOf(ctx, project.key),
    project.owner_uid === caller.uid ? repoRequestOf(ctx, project.key) : null,
  ]);
  return {
    project_id: project.key,
    runners,
    // The repository it is having made, for its owner — and, once made, the board's repository.
    repo_request: repoRequest,
    repo_url: (project.profile && project.profile.repo_url) || "",
  };
}

// --- the machine's own routes ------------------------------------------------------------

async function myLinks(ctx) {
  const { rows } = await ctx.store.query("machine_links", {
    where: [{ field: "machine_id", op: "=", value: ctx.caller.machineId }],
    limit: MAX_LINKS,
  });
  return rows;
}

/** Whether `uid` may put a machine on this board: its owner, or a member the owner allowed. */
async function mayRunAgents(ctx, project, uid) {
  if (project.owner_uid === uid) return true;
  const member = await ctx.store.get("memberships", memberKey(project.key, uid));
  return !!(member && member.can_run_agents);
}

/** `POST /machine/me` — this machine's settings, the boards it works, and what it has been asked to set up. */
export async function machineMe(ctx) {
  const caller = requireMachine(ctx.caller);
  const links = await myLinks(ctx);
  const [projects, requests] = await Promise.all([
    ctx.store.getMany("projects", links.map((l) => l.project_id)),
    openRequests(ctx, [caller.machineId]),
  ]);
  return {
    machine: machineView(caller.machineRow),
    links: links.map((l) => {
      const p = projects.get(l.project_id);
      return {
        ...linkView(l),
        ...(p ? profileView(p) : { name: "", profile: null, runner: null, rules_version: 0 }),
        role: p && p.owner_uid === caller.ownerUid ? "owner" : "member",
      };
    }),
    requests: requests.map(requestView),
    live: liveConfigured(ctx),
  };
}

/**
 * `POST /machine/link` — `{ project_id, path_hint? }`. Idempotent: linking again updates the hint.
 *
 * A new link comes with a setup duty reserved for this machine, and — on a board with no rules and
 * none being written — a rules duty, so a freshly linked folder has something to do first.
 */
export async function linkMachine(ctx, body) {
  const caller = requireMachine(ctx.caller);
  const projectId = str(body.project_id, "project_id", { required: true, max: 60 });
  const project = await ctx.store.get("projects", projectId);
  // A board this machine's owner cannot see reads as missing, like everywhere else.
  if (!project) throw notFound(`project '${projectId}' not found`);
  if (!(await mayRunAgents(ctx, project, caller.ownerUid))) {
    const member = project.owner_uid !== caller.ownerUid && (await ctx.store.get("memberships", memberKey(project.key, caller.ownerUid)));
    if (!member) throw notFound(`project '${projectId}' not found`);
    throw forbidden("the board's owner has not let you run agents on it");
  }
  const files = isFilesBoard(project);
  const tooOld = runnerTooOld(ctx, project, caller.machineRow.name);
  if (tooOld) throw badRequest(tooOld);
  if (!files && !(project.profile && project.profile.repo_url)) {
    throw badRequest("this board has no repository URL — set one in its settings first: a machine works a board from its own clone of it");
  }
  const pathHint = str(body.path_hint, "path_hint", { max: 300 });
  const key = linkKey(project.key, caller.machineId);
  const now = Date.now();

  const existing = await ctx.store.get("machine_links", key);
  if (existing) {
    const next = { ...stripMeta(existing), path_hint: pathHint || existing.path_hint || "", updated_at: now };
    await ctx.store.putOne("machine_links", key, next);
    return { ok: true, created: false, link: linkView({ ...next, key }), setup_duty_id: null, rules_duty_id: null };
  }

  const [onMachine, onBoard] = await Promise.all([
    ctx.store.countAtMost("machine_links", [{ field: "machine_id", op: "=", value: caller.machineId }], MAX_LINKS),
    ctx.store.countAtMost("machine_links", [{ field: "project_id", op: "=", value: project.key }], MAX_LINKS_PER_BOARD),
  ]);
  if (onMachine >= MAX_LINKS) throw badRequest(`this machine already works ${MAX_LINKS} boards, which is the limit`);
  if (onBoard >= MAX_LINKS_PER_BOARD) throw badRequest(`this board already has ${MAX_LINKS_PER_BOARD} machines, which is the limit`);

  const link = {
    project_id: project.key,
    machine_id: caller.machineId,
    owner_uid: caller.ownerUid,
    board_owner_uid: project.owner_uid,
    machine_name: caller.machineRow.name,
    agent_prefix: caller.agentPrefix,
    path_hint: pathHint,
    runs: [],
    created_at: now,
    updated_at: now,
  };
  const ops = [putOp("machine_links", key, link)];

  // A board made before runners existed has no runner settings, and so no limit on how many duties
  // run at once — which a daemon would read as "as many as this machine allows". The first machine
  // to link it gives it the defaults, one duty at a time, and the owner raises it from there.
  let runnerSet = false;
  if (!project.runner) {
    ops.push(putOp("projects", project.key, { ...stripMeta(project), runner: mergeRunner(null, {}), updated_at: now }));
    runnerSet = true;
  }

  // A board of one-off tasks has no project to set a machine up for, or to write rules about: each
  // task installs what it needs, and registers it for the next.
  const setup =
    body.setup === false || files || (await hasUnfinished(ctx, project.key, [{ field: "reserved_for", op: "=", value: caller.agentPrefix }, { field: "kind", op: "=", value: "setup" }]))
      ? null
      : seedDuty(project, {
          title: `Set up ${caller.machineRow.name} for this project`,
          brief:
            "Make this machine ready to work on the project: find what the project needs (engine, SDKs, runtimes, test tools), " +
            "install whatever is missing into the dutyboard tools folder and register it, record the toolchain, how a worktree is " +
            "prepared and how the project deploys with board_profile_propose, and ask on the board for anything that needs admin " +
            "rights or a licence. Done when every tool the project needs runs on this machine. A repository with nothing in it yet " +
            "is a new project: build its first version from the board's description, then do the same.",
          kind: "setup",
          priority: "immediate_blocker",
          reservedFor: caller.agentPrefix,
          now,
        });
  if (setup) ops.push(setup.op);
  // Duties in progress wait for the setup: it can change what they land against.
  const paused = setup ? await blockBehindSetup(ctx, project, { id: setup.id, title: `Set up ${caller.machineRow.name} for this project` }, caller.machineRow.name, now) : { ops: [], events: [] };
  ops.push(...paused.ops);

  const rules =
    body.setup === false || files || project.rules_version || (await hasUnfinished(ctx, project.key, [{ field: "kind", op: "=", value: "rules" }]))
      ? null
      : rulesDuty(project, now);
  if (rules) ops.push(rules.op);

  await ctx.store.transaction(ops);
  if (setup) await ctx.publish(project.key, setup.id, { t: "duty", id: setup.id, status: "queued" });
  for (const e of paused.events) await ctx.publish(project.key, e.id, e.payload);
  if (rules) await ctx.publish(project.key, rules.id, { t: "duty", id: rules.id, status: "queued" });
  await ctx.publish(project.key, null, { t: "runner", machine_id: caller.machineId, state: "linked" });
  if (runnerSet) await ctx.publish(project.key, null, { t: "board", what: "profile" });
  return {
    ok: true,
    created: true,
    link: linkView({ ...link, key }),
    setup_duty_id: setup ? setup.id : null,
    rules_duty_id: rules ? rules.id : null,
  };
}

/** The duty every new project board starts with. Exported for `/projects/create`. */
export function rulesDuty(project, now = Date.now()) {
  return seedDuty(project, {
    title: "Write this project's rules",
    brief:
      "Read the repository, its profile and its toolchain, and write the rules every agent on this board will follow: security, " +
      "reuse instead of duplication, performance, how to test and verify (with the real commands), conventions, git and deploy. " +
      "Concrete and checkable for this project, not generic advice. Submit them with board_rules_submit; a person accepts them.",
    kind: "rules",
    priority: "next",
    now,
  });
}

async function hasUnfinished(ctx, projectKey, where) {
  const n = await ctx.store.countAtMost(
    "duties",
    [{ field: "project_id", op: "=", value: projectKey }, ...where, { field: "status", op: "in", value: UNFINISHED }],
    1,
  );
  return n > 0;
}

/** `POST /machine/unlink` — `{ project_id }`. The machine takes itself off a board. */
export async function unlinkMachine(ctx, body) {
  const caller = requireMachine(ctx.caller);
  const projectId = str(body.project_id, "project_id", { required: true, max: 60 });
  const link = await ctx.store.get("machine_links", linkKey(projectId, caller.machineId));
  if (!link) return { ok: true, removed: false };
  await dropLink(ctx, link);
  return { ok: true, removed: true };
}

/**
 * `POST /machine/state` — `{ project_id, runs: [{ duty_id, state, detail? }] }`.
 *
 * The whole list for one board, replacing the last one: a daemon reports what it is doing there
 * now, not a stream of changes the server would have to fold. Sent when something changes, never
 * on a timer — presence already says whether the machine is there.
 */
export async function reportState(ctx, body) {
  const caller = requireMachine(ctx.caller);
  const projectId = str(body.project_id ?? ctx.caller.projectId, "project_id", { required: true, max: 60 });
  const link = await ctx.store.get("machine_links", linkKey(projectId, caller.machineId));
  if (!link) throw forbidden(`this machine is not linked to board '${projectId}'`);
  if (!Array.isArray(body.runs)) throw badRequest("'runs' must be an array");
  if (body.runs.length > MAX_RUNS) throw badRequest(`'runs' may have at most ${MAX_RUNS} entries`);
  const now = Date.now();
  const runs = body.runs.map((r, i) => ({
    duty_id: str(r && r.duty_id, `runs[${i}].duty_id`, { required: true, max: 64 }),
    state: oneOf(r && r.state, `runs[${i}].state`, RUN_STATES),
    detail: str(r && r.detail, `runs[${i}].detail`, { max: 300 }),
  }));
  // What stops this machine working the board at all — a clone that failed, a pull-request board with
  // no GitHub CLI — as opposed to anything about one duty. Empty when nothing is wrong. A machine too
  // old for the board says something else, which is not the problem; it is told what is.
  const project = await ctx.store.get("projects", projectId);
  const problem = runnerTooOld(ctx, project, caller.machineRow.name) || str(body.problem, "problem", { max: 300 });
  await ctx.store.putOne("machine_links", link.key, { ...stripMeta(link), runs, problem, runs_at: now, updated_at: now });
  await ctx.publish(projectId, null, { t: "runner", machine_id: caller.machineId, runs: runs.length });
  return { ok: true, runs: runs.length };
}

/**
 * `POST /machine/poll` — everything a daemon decides on, for every board it works.
 *
 * Per board: how many duties may be active, which are, which of those this machine holds (so a
 * restarted daemon finds its sessions), and the top of the queue as this machine may claim it.
 */
export async function pollMachine(ctx, body) {
  const caller = requireMachine(ctx.caller);
  const limit = intIn(body.limit, "limit", 1, 10, 5);
  const links = await myLinks(ctx);
  const projects = await ctx.store.getMany("projects", links.map((l) => l.project_id));

  // Recurring duties, in case nothing else is watching the clock. The function's own cron is what
  // normally files these, and a deployment provisioned before recurring duties existed has none
  // until it is provisioned again — so a polling machine files what is due on the boards it works.
  // Firing twice is not a risk: the occurrence is written under a unique key, so whichever tick
  // gets there second writes nothing.
  for (const l of links) {
    if (!projects.has(l.project_id)) continue;
    await runDueSchedules(ctx, { projectKey: l.project_id }).catch(() => ({}));
  }

  const boards = await Promise.all(
    links.map(async (l) => {
      const project = projects.get(l.project_id);
      if (!project) return null;
      const [active, runnable, machines] = await Promise.all([
        activeDuties(ctx, project.key),
        runnableDuties(ctx, project.key, caller.agentPrefix, limit),
        // Whether anyone else could resume this machine's parked work — which decides whether that
        // work is worth snapshotting to the repository's remote when it parks.
        ctx.store.countAtMost("machine_links", [{ field: "project_id", op: "=", value: project.key }], MAX_LINKS_PER_BOARD),
      ]);
      const mine = (d) => d.assigned_agent_id === caller.agentPrefix || (d.assigned_agent_id || "").startsWith(caller.agentPrefix + "/");
      return {
        project_id: project.key,
        name: project.name,
        parallel: (project.runner && project.runner.parallel) || null,
        machines,
        rules_version: project.rules_version || 0,
        active: active.map((d) => ({ duty_id: d.key, agent_id: d.assigned_agent_id, kind: d.kind || "work", mine: mine(d) })),
        runnable: runnable.map((d) => ({
          duty_id: d.key,
          title: d.title,
          priority: d.priority,
          kind: d.kind || "work",
          reserved: !!d.reserved_for,
          resumes: !!(d.affinity && d.affinity.machine_id === caller.machineId),
        })),
      };
    }),
  );

  const requests = await openRequests(ctx, [caller.machineId]);
  return {
    machine_id: caller.machineId,
    paused: !!caller.machineRow.paused,
    boards: boards.filter(Boolean),
    requests: requests.map(requestView),
  };
}

/** `POST /machine/live` — the daemon's subscribe token: its own channel plus every linked board's. */
export async function machineLive(ctx) {
  const caller = requireMachine(ctx.caller);
  if (!liveConfigured(ctx)) throw badRequest("live updates are not configured for this deployment — poll instead");
  const links = await myLinks(ctx);
  return mintMachineLive(ctx, caller.machineId, links.map((l) => l.project_id));
}

/**
 * `POST /machine/boards` — the boards this machine could work: its owner's, and those shared with
 * its owner by someone who let them run agents. What a daemon offers when it is run in a folder
 * that is not linked yet.
 */
export async function machineBoards(ctx) {
  const caller = requireMachine(ctx.caller);
  const [owned, shared, links] = await Promise.all([
    ctx.store.query("projects", {
      where: [{ field: "owner_uid", op: "=", value: caller.ownerUid }],
      order: [{ field: "created_at", dir: "desc" }],
      limit: 100,
    }),
    ctx.store.query("memberships", { where: [{ field: "uid", op: "=", value: caller.ownerUid }], limit: 50 }),
    myLinks(ctx),
  ]);
  const allowed = shared.rows.filter((m) => m.can_run_agents).map((m) => m.project_id);
  const sharedProjects = await ctx.store.getMany("projects", allowed);
  const linked = new Set(links.map((l) => l.project_id));
  const view = (p, role) => ({ ...profileView(p), role, linked: linked.has(p.key) });
  return {
    boards: [
      ...owned.rows.map((p) => view(p, "owner")),
      ...allowed.map((id) => sharedProjects.get(id)).filter(Boolean).map((p) => view(p, "member")),
    ],
  };
}

/** `POST /machine/boards/create` — a board for this machine's owner, made from the terminal. */
export async function createMachineBoard(ctx, body) {
  const caller = requireMachine(ctx.caller);
  return createProjectFor(ctx, { uid: caller.ownerUid, name: caller.machineRow.owner_name || "" }, body);
}

// --- setup requests ----------------------------------------------------------------------

/** A daemon gives up on a request after 30 minutes; one still "running" well after that was dropped —
 *  its daemon stopped part way — and neither blocks another nor reads as under way. */
const REQUEST_STALE_MS = 35 * 60 * 1000;
const underWay = (r, now = Date.now()) => r.status === "pending" || (r.status === "running" && now - (r.updated_at || r.created_at) < REQUEST_STALE_MS);

const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** The GitHub repository a create_repo request makes: `{ name, owner?, private? }`. */
function newRepo(v, description) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw badRequest("'repo' must be an object with the repository's 'name'");
  const name = str(v.name, "repo.name", { required: true, max: 100 });
  if (!GH_REPO.test(name) || name === "." || name === "..") throw badRequest("'repo.name' must be letters, digits, '.', '-' and '_'");
  // Empty is the account the machine's GitHub CLI is signed in as.
  const owner = str(v.owner, "repo.owner", { max: 39 });
  if (owner && !GH_OWNER.test(owner)) throw badRequest("'repo.owner' is not a GitHub user or organization name");
  return { name, owner, private: v.private !== false, description: (description || "").replace(/\s+/g, " ").trim().slice(0, 300) };
}

/**
 * `POST /machine/request` — a person asks one of their machines to set a board up.
 * `{ machine_id, project_id, path?, kind?, repo? }`. `path` is relative to the machine's projects
 * folder; the daemon refuses anything outside it whatever this says, and so does this.
 *
 * `kind: "create_repo"` is for a board with no repository yet: the machine makes `repo` on GitHub with
 * its own GitHub CLI, reports its URL — which becomes the board's — and then sets the board up as
 * usual. The board's owner's alone: it decides where the board's code lives.
 */
export async function requestSetup(ctx, body) {
  const machine = await ownMachine(ctx, body);
  const kind = oneOf(body.kind, "kind", ["setup", "create_repo"], "setup");
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: kind === "create_repo" });
  if (!(await mayRunAgents(ctx, project, ctx.caller.uid))) throw forbidden("the board's owner has not let you run agents on it");
  const hasRepo = !!(project.profile && project.profile.repo_url);
  let repo = null;
  if (kind === "create_repo") {
    if (isFilesBoard(project)) throw conflict("this board works without a repository — change that in its settings first");
    if (hasRepo) throw conflict("this board already has a repository — change it in its settings instead");
    repo = newRepo(body.repo, project.profile && project.profile.description);
    const creating = await ctx.store.query("machine_requests", { where: [{ field: "project_id", op: "=", value: project.key }], limit: 50 });
    if (creating.rows.some((r) => r.kind === "create_repo" && underWay(r))) {
      throw conflict("a machine is already making this board's repository");
    }
  } else if (!hasRepo && !isFilesBoard(project)) {
    throw badRequest("this board has no repository URL — set one in its settings first: the machine clones it");
  }
  const path = str(body.path, "path", { max: 200 });
  if (path && (path.startsWith("/") || path.startsWith("~") || path.includes("\\") || path.split("/").includes(".."))) {
    throw badRequest("'path' must be a folder name inside the machine's projects folder");
  }
  const pending = await ctx.store.countAtMost(
    "machine_requests",
    [
      { field: "machine_id", op: "=", value: machine.machine_id },
      { field: "status", op: "in", value: ["pending", "running"] },
    ],
    MAX_PENDING_REQUESTS,
  );
  if (pending >= MAX_PENDING_REQUESTS) throw badRequest(`that machine already has ${MAX_PENDING_REQUESTS} setups waiting`);

  const now = Date.now();
  const id = requestId();
  const row = {
    machine_id: machine.machine_id,
    project_id: project.key,
    owner_uid: machine.owner_uid,
    kind,
    path: path || project.key,
    repo_url: (project.profile && project.profile.repo_url) || "",
    ...(repo ? { repo } : {}),
    status: "pending",
    result: "",
    requested_by: ctx.caller.uid,
    created_at: now,
    updated_at: now,
  };
  await ctx.store.putOne("machine_requests", id, row);
  await publishMachine(ctx, machine.machine_id, { t: "setup", request_id: id });
  return { ok: true, request: requestView({ ...row, key: id }) };
}

/**
 * `POST /machine/request/report` — `{ request_id, status: running|done|failed, result?, repo_url? }`.
 *
 * A create_repo request reports the repository it made in `repo_url`, and that becomes the board's —
 * unless the owner gave the board one meanwhile, which is theirs and stays.
 */
export async function reportRequest(ctx, body) {
  const caller = requireMachine(ctx.caller);
  const id = str(body.request_id, "request_id", { required: true, max: 40 });
  const row = await ctx.store.get("machine_requests", id);
  if (!row || row.machine_id !== caller.machineId) throw notFound(`request '${id}' not found`);
  const now = Date.now();
  const next = {
    ...stripMeta(row),
    status: oneOf(body.status, "status", ["running", "done", "failed"]),
    result: str(body.result, "result", { max: 2000 }),
    updated_at: now,
  };
  let adopted = false;
  if (body.repo_url != null) {
    if (row.kind !== "create_repo") throw badRequest("only a create_repo request reports a repository");
    if (!underWay(row)) throw conflict(`request '${id}' is ${row.status === "running" ? "too old" : row.status} — it can no longer give the board a repository`);
    next.repo_url = repoUrl(body.repo_url, "repo_url");
    const project = next.repo_url && (await ctx.store.get("projects", row.project_id));
    if (project && !(project.profile && project.profile.repo_url)) {
      const profile = { ...(project.profile || {}), repo_url: next.repo_url };
      // The first branch the machine pushes, in a repository that had none.
      if (!profile.default_branch) profile.default_branch = "main";
      await ctx.store.putOne("projects", project.key, { ...stripMeta(project), profile, updated_at: now });
      adopted = true;
    }
  }
  await ctx.store.putOne("machine_requests", id, next);
  if (adopted) await ctx.publish(row.project_id, null, { t: "board", what: "profile" });
  await ctx.publish(row.project_id, null, { t: "runner", machine_id: caller.machineId, request: next.status });
  return { ok: true, adopted, request: requestView({ ...next, key: id }) };
}

/** The latest create_repo request on a board, for its settings to say how making it went. */
async function repoRequestOf(ctx, projectKey) {
  const { rows } = await ctx.store.query("machine_requests", { where: [{ field: "project_id", op: "=", value: projectKey }], limit: 50 });
  const latest = rows.filter((r) => r.kind === "create_repo").sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return null;
  if (latest.status === "running" && !underWay(latest)) {
    return requestView({ ...latest, status: "failed", result: "the machine stopped part way through — ask again, or give the board a repository URL" });
  }
  return requestView(latest);
}

// --- bookkeeping -------------------------------------------------------------------------

/** Stamp `last_seen_at`, at most once a minute. `identify` already read the row. */
export async function noteMachineUse(ctx, caller, version = "") {
  const row = caller.machineRow;
  if (!row) return;
  const now = Date.now();
  // The version it is running NOW, not the one it first paired with. A machine is updated far more
  // often than it is paired, and "is this machine out of date?" is otherwise unanswerable — which
  // is exactly the question asked when a board misbehaves on one machine and not another.
  const moved = version && version !== (row.cli_version || "");
  if (!moved && row.last_seen_at && now - row.last_seen_at < TOUCH_EVERY_MS) return;
  await ctx.store.putOne("machines", caller.machineKey, {
    ...stripMeta(row),
    ...(moved ? { cli_version: version } : {}),
    last_seen_at: now,
  });
}

/** Delete every row matching `where`, a page at a time. Answers the distinct boards the rows named,
 *  so a caller can tell those boards' consoles something changed. */
async function sweep(ctx, collection, where) {
  const boards = new Set();
  for (;;) {
    const { rows } = await ctx.store.query(collection, { where, limit: 200 });
    if (!rows.length) break;
    for (const r of rows) boards.add(r.project_id);
    await ctx.store.delete(collection, rows.map((r) => r.key));
    if (rows.length < 200) break;
  }
  return [...boards];
}

/** Everything machine-shaped on a board that is being deleted. Each linked machine hears about it,
 *  so its daemon drops the board without waiting for a 403. */
export async function sweepBoardMachines(ctx, projectKey) {
  const { rows: links } = await ctx.store.query("machine_links", {
    where: [{ field: "project_id", op: "=", value: projectKey }],
    limit: MAX_LINKS_PER_BOARD,
  });
  if (links.length) await ctx.store.delete("machine_links", links.map((l) => l.key));
  for (const l of links) await publishMachine(ctx, l.machine_id, { t: "links" });
  await sweep(ctx, "machine_requests", [{ field: "project_id", op: "=", value: projectKey }]);
  await ctx.store.delete("rules", [projectKey]).catch(() => 0);
  return links.length;
}

/** One person's machines off one board — they left it, or lost permission to run agents on it. */
export async function unlinkPersonFromBoard(ctx, projectKey, uid) {
  const { rows } = await ctx.store.query("machine_links", {
    where: [
      { field: "project_id", op: "=", value: projectKey },
      { field: "owner_uid", op: "=", value: uid },
    ],
    limit: MAX_LINKS_PER_BOARD,
  });
  for (const link of rows) await dropLink(ctx, link);
  return rows.length;
}
