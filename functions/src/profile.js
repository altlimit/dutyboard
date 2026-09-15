// A board's profile, its runner settings, and its rules — what a `dutyboard` daemon needs to know
// about a project before it can work on it.
//
//   profile  what the project IS: its type, repository, toolchain, how it deploys, how a worktree
//            for it is prepared. Set by a person when the board is made; a setup duty fills in
//            what it finds on the machine (`board_profile_propose`).
//   runner   how agents run on it: which agent, model, effort, how many duties at once.
//   rules    the project's own rules — security, reuse, performance, testing — in markdown. A
//            rules duty writes a DRAFT; nothing an agent writes is in force until a person accepts
//            it, because every later session on the board is told to follow it.
//
// EDITING ANY OF IT IS THE OWNER'S. Some of these fields are commands a daemon runs on the
// machines linked to the board — `worktree.prep`, `test_command`, a deploy command — and a member
// who could edit them could run a command on someone else's computer. Members can read it all.
//
// Paths in the profile are checked here and not only in the daemon: a `worktree.copy` entry of
// `../../.ssh/id_ed25519` is a request to copy a private key into a folder an agent works in, and
// the place to refuse it is before it is stored where every linked machine will read it.

import { badRequest, conflict, forbidden, str, oneOf, intIn } from "./http.js";
import { resolveProject, projectOfDuty, requireHuman, checkAgentId } from "./identity.js";
import { loadDuty, stripMeta } from "./duties.js";
import { putOp } from "./store.js";

export const PROJECT_TYPES = ["game", "website", "webapp", "mobile", "desktop", "api", "cli-lib", "other"];
export const DEPLOY_METHODS = ["ci", "ci-dispatch", "altengine", "command", "none"];
export const GIT_MODES = ["push", "pr"];
export const RUNNER_AGENTS = ["claude-code"];
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Duties at once on one board. Above this the bottleneck is merges and plan limits, not lanes. */
export const MAX_PARALLEL = 10;

/** Rules are read into every session's system prompt, so they are held to what fits there well. */
const MAX_RULES_CHARS = 32000;

const RUNNER_DEFAULTS = Object.freeze({
  agent: "claude-code",
  model: "",
  effort: "",
  instructions: "",
  permission_mode: "acceptEdits",
  allowed_tools: [],
  session_minutes: 180,
  parallel: 1,
});

// --- validation -------------------------------------------------------------------------

function list(v, field, { max, item }) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw badRequest(`'${field}' must be an array`);
  if (v.length > max) throw badRequest(`'${field}' may have at most ${max} entries`);
  return v.map((x, i) => item(x, `${field}[${i}]`));
}

/**
 * A path inside the project, as a daemon will join it onto a worktree.
 *
 * Relative, forward slashes, no `..` segment, nothing that a shell or Windows would read as
 * somewhere else. Refused rather than normalised: a path that needed fixing was not written by
 * someone who meant a folder in this project.
 */
function projectPath(v, field) {
  const p = str(v, field, { required: true, max: 200 });
  const bad =
    p.startsWith("/") ||
    p.startsWith("~") ||
    p.includes("\\") ||
    /^[a-zA-Z]:/.test(p) ||
    p.split("/").some((seg) => seg === ".." || seg === "") ||
    /[\0\n\r]/.test(p);
  if (bad) throw badRequest(`'${field}' must be a relative path inside the project, like 'node_modules' or 'config/.env'`);
  return p;
}

const plain = (max) => (x, f) => str(x, f, { required: true, max });

/** A git branch name, loosely: enough to refuse something that is plainly not one. */
function branch(v, field) {
  const b = str(v, field, { max: 100 });
  if (b && !/^[A-Za-z0-9._/-]+$/.test(b)) throw badRequest(`'${field}' is not a branch name`);
  return b;
}

function repoUrl(v, field) {
  const u = str(v, field, { max: 500 });
  // file:// is for a repository on the machine itself — a local bare repo, or a test.
  if (u && !/^(https:\/\/|ssh:\/\/|git@|file:\/\/)[^\s]+$/.test(u)) {
    throw badRequest(`'${field}' must be an https://, ssh://, git@ or file:// repository URL`);
  }
  return u;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** MCP servers a board's sessions are connected to, beyond DutyBoard's own. */
export const MAX_MCP_SERVERS = 8;
const MCP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * One MCP server: a command each machine starts, or a URL it connects to — never both.
 *
 * NOTHING HERE IS SECRET, and nothing here may be. Every member reads the profile, so a token
 * pasted into `env` would be handed to all of them. A server's credentials are named in `secrets`
 * — environment variables for a command, headers for a URL — and each machine keeps their values
 * itself (`dutyboard --mcp-secrets`). A value that looks like a credential in `env` is refused.
 */
function mcpServer(v, f) {
  const o = obj(v, f);
  const name = str(o.name, `${f}.name`, { required: true, max: 32 });
  if (!MCP_NAME.test(name)) throw badRequest(`'${f}.name' must be lowercase letters, digits and dashes`);
  if (name === "dutyboard") throw badRequest(`'${f}.name' cannot be 'dutyboard' — that server is the runner's own`);
  const command = str(o.command, `${f}.command`, { max: 200 });
  const url = str(o.url, `${f}.url`, { max: 500 });
  if (!!command === !!url) throw badRequest(`'${f}' needs a 'command' to start or a 'url' to connect to, not both`);
  if (command && /[\0\n\r]/.test(command)) throw badRequest(`'${f}.command' must be one line`);
  if (url && !/^(https:\/\/[^\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?)$/.test(url)) {
    throw badRequest(`'${f}.url' must be https://, or http:// on localhost`);
  }
  const env = {};
  for (const [k, val] of Object.entries(obj(o.env, `${f}.env`))) {
    if (!ENV_NAME.test(k)) throw badRequest(`'${f}.env' has a name that is not an environment variable: '${k}'`);
    const s = str(val, `${f}.env.${k}`, { max: 500 });
    if (/(token|secret|password|passwd|api[_-]?key|private[_-]?key)/i.test(k) || /^(sk-|ghp_|github_pat_|xox[bp]-|ak_|db_|dbm_)/.test(s)) {
      throw badRequest(`'${f}.env.${k}' looks like a credential — list it in '${f}.secrets' and set it on each machine instead`);
    }
    env[k] = s;
  }
  if (Object.keys(env).length > 20) throw badRequest(`'${f}.env' may have at most 20 entries`);
  const secrets = list(o.secrets, `${f}.secrets`, {
    max: 10,
    item: (x, g) => {
      const s = str(x, g, { required: true, max: 64 });
      if (!(url ? HEADER_NAME : ENV_NAME).test(s)) {
        throw badRequest(`'${g}' must be ${url ? "a header name, like 'Authorization'" : "an environment variable name, like 'GITHUB_TOKEN'"}`);
      }
      return s;
    },
  });
  return {
    name,
    ...(command ? { command, args: list(o.args, `${f}.args`, { max: 30, item: plain(500) }) } : { url }),
    env: command ? env : {},
    secrets,
    tools: list(o.tools, `${f}.tools`, {
      max: 50,
      item: (x, g) => {
        const t = str(x, g, { required: true, max: 64 });
        if (!TOOL_NAME.test(t)) throw badRequest(`'${g}' is not a tool name`);
        return t;
      },
    }),
    note: str(o.note, `${f}.note`, { max: 300 }),
  };
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const obj = (v, field) => {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw badRequest(`'${field}' must be an object`);
  return v;
};

/**
 * Merge a partial profile onto the one stored. Only the fields present are touched, so the console
 * can save one section and a setup duty can propose one part without either erasing the rest.
 */
export function mergeProfile(stored, input) {
  const next = { ...(stored || {}) };
  const p = obj(input, "profile");
  if (has(p, "type")) next.type = oneOf(p.type, "profile.type", PROJECT_TYPES);
  if (has(p, "type_other")) next.type_other = str(p.type_other, "profile.type_other", { max: 60 });
  if (has(p, "description")) next.description = str(p.description, "profile.description", { max: 2000 });
  if (has(p, "repo_url")) next.repo_url = repoUrl(p.repo_url, "profile.repo_url");
  if (has(p, "default_branch")) next.default_branch = branch(p.default_branch, "profile.default_branch");
  if (has(p, "stack")) next.stack = list(p.stack, "profile.stack", { max: 30, item: plain(40) });
  if (has(p, "test_command")) next.test_command = str(p.test_command, "profile.test_command", { max: 500 });
  if (has(p, "toolchain")) {
    next.toolchain = list(p.toolchain, "profile.toolchain", {
      max: 30,
      item: (t, f) => {
        const o = obj(t, f);
        return {
          name: str(o.name, `${f}.name`, { required: true, max: 60 }),
          version: str(o.version, `${f}.version`, { max: 40 }),
          why: str(o.why, `${f}.why`, { max: 300 }),
        };
      },
    });
  }
  if (has(p, "deploy")) {
    const d = obj(p.deploy, "profile.deploy");
    next.deploy = {
      method: oneOf(d.method, "profile.deploy.method", DEPLOY_METHODS, "none"),
      workflow: str(d.workflow, "profile.deploy.workflow", { max: 200 }),
      branch: branch(d.branch, "profile.deploy.branch"),
      command: str(d.command, "profile.deploy.command", { max: 500 }),
      altengine_instances: list(d.altengine_instances, "profile.deploy.altengine_instances", { max: 10, item: plain(60) }),
    };
  }
  if (has(p, "git")) {
    // Merged field by field: the console saves the mode without re-sending the author, and neither
    // should erase the other.
    const g = obj(p.git, "profile.git");
    const git = { mode: "push", ...(next.git || {}) };
    if (has(g, "mode")) git.mode = oneOf(g.mode, "profile.git.mode", GIT_MODES, "push");
    // Who commits are made as, in the machine's clone of this board — not in anyone's global git
    // config. Empty means the machine user's own identity.
    if (has(g, "author_name")) git.author_name = str(g.author_name, "profile.git.author_name", { max: 80 });
    if (has(g, "author_email")) {
      git.author_email = str(g.author_email, "profile.git.author_email", { max: 254 });
      if (git.author_email && !EMAIL.test(git.author_email)) throw badRequest("'profile.git.author_email' is not an email address");
    }
    // How the clone reaches the remote, for a board that needs a different key or account than the
    // machine user's default — e.g. `ssh -i ~/.ssh/work_ed25519`. A command a machine runs, which is
    // why the profile is the owner's to edit.
    if (has(g, "ssh_command")) git.ssh_command = str(g.ssh_command, "profile.git.ssh_command", { max: 300 });
    next.git = git;
  }
  if (has(p, "mcp_servers")) {
    // Replaced whole: a list edited in one form, where a merge could not tell removed from unsent.
    const servers = list(p.mcp_servers, "profile.mcp_servers", { max: MAX_MCP_SERVERS, item: mcpServer });
    const names = new Set();
    for (const s of servers) {
      if (names.has(s.name)) throw badRequest(`two MCP servers are named '${s.name}'`);
      names.add(s.name);
    }
    next.mcp_servers = servers;
  }
  if (has(p, "worktree")) {
    const w = obj(p.worktree, "profile.worktree");
    next.worktree = {
      prep: str(w.prep, "profile.worktree.prep", { max: 1000 }),
      prep_inputs: list(w.prep_inputs, "profile.worktree.prep_inputs", { max: 20, item: projectPath }),
      cache: list(w.cache, "profile.worktree.cache", { max: 20, item: projectPath }),
      copy: list(w.copy, "profile.worktree.copy", { max: 50, item: projectPath }),
    };
  }
  return next;
}

export function mergeRunner(stored, input) {
  const next = { ...RUNNER_DEFAULTS, ...(stored || {}) };
  const r = obj(input, "runner");
  if (has(r, "agent")) next.agent = oneOf(r.agent, "runner.agent", RUNNER_AGENTS);
  if (has(r, "model")) next.model = str(r.model, "runner.model", { max: 80 });
  if (has(r, "effort")) next.effort = r.effort ? oneOf(r.effort, "runner.effort", EFFORTS) : "";
  if (has(r, "instructions")) next.instructions = str(r.instructions, "runner.instructions", { max: 4000 });
  if (has(r, "permission_mode")) next.permission_mode = oneOf(r.permission_mode, "runner.permission_mode", PERMISSION_MODES);
  if (has(r, "allowed_tools")) next.allowed_tools = list(r.allowed_tools, "runner.allowed_tools", { max: 50, item: plain(200) });
  if (has(r, "session_minutes")) next.session_minutes = intIn(r.session_minutes, "runner.session_minutes", 5, 600, 180);
  if (has(r, "parallel")) next.parallel = intIn(r.parallel, "runner.parallel", 1, MAX_PARALLEL, 1);
  return next;
}

export const profileView = (project) => ({
  project_id: project.key,
  name: project.name,
  profile: project.profile || null,
  runner: project.runner || null,
  rules_version: project.rules_version || 0,
});

// --- profile -----------------------------------------------------------------------------

/** `POST /board/profile` — what the board is and how it is run. Anyone on it, and its agents. */
export async function getProfile(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  return profileView(project);
}

/** `POST /projects/profile` — owner only. `{ project_id, profile?, runner? }`, each partial. */
export async function updateProfile(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  if (body.profile == null && body.runner == null) throw badRequest("send 'profile', 'runner', or both");
  const next = {
    ...stripMeta(project),
    profile: body.profile != null ? mergeProfile(project.profile, body.profile) : project.profile || null,
    runner: body.runner != null ? mergeRunner(project.runner, body.runner) : project.runner || null,
    updated_at: Date.now(),
  };
  await ctx.store.putOne("projects", project.key, next);
  await ctx.publish(project.key, null, { t: "board", what: "profile" });
  return profileView({ ...next, key: project.key });
}

/**
 * `POST /board/profile/propose` — a setup duty writes down what it found.
 *
 * Only the parts a machine can discover — the toolchain, how the project deploys, how a worktree
 * is prepared, the test command — and only by the agent holding an active setup duty on this
 * board. What it writes is in effect immediately; the owner sees it and can change any of it.
 */
export async function proposeProfile(ctx, body) {
  const { duty, project } = await heldDutyOfKind(ctx, body, "setup");
  const input = {};
  for (const k of ["toolchain", "deploy", "worktree", "test_command"]) if (has(body, k)) input[k] = body[k];
  if (!Object.keys(input).length) throw badRequest("send at least one of 'toolchain', 'deploy', 'worktree', 'test_command'");

  const board = await ctx.store.get("projects", project.key);
  const now = Date.now();
  const next = {
    ...stripMeta(board),
    profile: { ...mergeProfile(board.profile, input), proposed_by: { duty_id: duty.key, agent_id: duty.assigned_agent_id, at: now } },
    updated_at: now,
  };
  await ctx.store.putOne("projects", project.key, next);
  await ctx.publish(project.key, null, { t: "board", what: "profile" });
  return profileView({ ...next, key: project.key });
}

// --- rules -------------------------------------------------------------------------------

const rulesView = (row, { withDraft }) => ({
  version: (row && row.version) || 0,
  body: (row && row.body) || "",
  updated_at: (row && row.updated_at) || null,
  // An agent is told what is in force, and only whether something is waiting — a draft nobody has
  // accepted is not a rule, and a session that followed one would be following an agent.
  ...(withDraft ? { draft: (row && row.draft) || null } : { has_draft: !!(row && row.draft) }),
});

/** `POST /board/rules` — the rules in force; people also see a pending draft. */
export async function getRules(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const row = await ctx.store.get("rules", project.key);
  return { project_id: project.key, ...rulesView(row, { withDraft: ctx.caller.kind === "human" }) };
}

/** `POST /board/rules/set` — owner writes the rules by hand. The draft, if any, is left alone. */
export async function setRules(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const text = str(body.body, "body", { required: true, max: MAX_RULES_CHARS });
  const row = await ctx.store.get("rules", project.key);
  return writeRules(ctx, project, row, { body: text, draft: row ? row.draft || null : null, source: "owner" });
}

/** `POST /board/rules/accept` — owner puts the draft in force. */
export async function acceptRules(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const row = await ctx.store.get("rules", project.key);
  if (!row || !row.draft) throw conflict("there is no draft to accept");
  return writeRules(ctx, project, row, { body: row.draft.body, draft: null, source: "draft" });
}

/**
 * `POST /board/rules/submit` — a rules duty hands in its draft. The agent must be holding an active
 * rules duty on this board; a second submission replaces the first.
 */
export async function submitRules(ctx, body) {
  const { duty, project } = await heldDutyOfKind(ctx, body, "rules");
  const text = str(body.body, "body", { required: true, max: MAX_RULES_CHARS });
  const row = await ctx.store.get("rules", project.key);
  const now = Date.now();
  const draft = { body: text, duty_id: duty.key, agent_id: duty.assigned_agent_id, based_on: (row && row.version) || 0, created_at: now };
  await ctx.store.putOne("rules", project.key, {
    ...(row ? stripMeta(row) : { project_id: project.key, owner_uid: project.owner_uid, version: 0, body: "" }),
    draft,
    updated_at: now,
  });
  await ctx.publish(project.key, null, { t: "board", what: "rules" });
  return { ok: true, project_id: project.key, draft_for_version: draft.based_on + 1 };
}

/** The rules row and the board's `rules_version` move together, so a claim — which reads only the
 *  board — always names the version that is actually in force. */
async function writeRules(ctx, project, row, { body, draft, source }) {
  const now = Date.now();
  const version = ((row && row.version) || 0) + 1;
  const board = await ctx.store.get("projects", project.key);
  await ctx.store.transaction([
    putOp("rules", project.key, {
      project_id: project.key,
      owner_uid: project.owner_uid,
      version,
      body,
      draft,
      source,
      updated_by: ctx.caller.uid,
      updated_at: now,
    }),
    putOp("projects", project.key, { ...stripMeta(board), rules_version: version, updated_at: now }),
  ]);
  await ctx.publish(project.key, null, { t: "board", what: "rules" });
  return { ok: true, project_id: project.key, version };
}

/** The duty in `body.duty_id`, which must be an active duty of `kind` held by the calling agent. */
async function heldDutyOfKind(ctx, body, kind) {
  if (ctx.caller.kind !== "agent") throw forbidden(`only the agent holding a ${kind} duty can do this`);
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  if ((duty.kind || "work") !== kind || duty.status !== "active") {
    throw conflict(`duty '${duty.key}' is not an active ${kind} duty`, { kind: duty.kind || "work", status: duty.status });
  }
  // A machine's session names its own lane; a call that names none is the machine, and any of its
  // lanes holding the duty will do. A project token is held to the id it names or defaults to.
  const holder = duty.assigned_agent_id || "";
  const named = checkAgentId(ctx.caller, str(body.agent_id, "agent_id", { max: 64 }));
  const heldByCaller = named
    ? holder === named
    : ctx.caller.machineId
      ? holder === ctx.caller.agentPrefix || holder.startsWith(ctx.caller.agentPrefix + "/")
      : !ctx.defaultAgentId || holder === ctx.defaultAgentId;
  if (!heldByCaller) throw forbidden(`duty '${duty.key}' is held by '${holder}', not by you`);
  return { duty, project };
}
