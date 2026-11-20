// A board's roster: the roles its duties pass between, and the standards each works to.
//
//   role     a named member of the team — Duty Officer, Architect, Engineer, QA — with a charter
//            (its standing instructions) and a LEVEL that decides which model works it.
//   intake   exactly one role reads every new duty first and routes it. Nobody assigns a role by
//            hand: a person files the work, the intake role decides who does it.
//   reviewed a role whose work must pass a reviewer before the duty can finish. It cannot land or
//            complete its own work; it hands the SAME duty on, with its workspace, so nothing
//            merges until a role that `reviews` has verified it.
//   plans    a role whose handoff is a plan. With `plan_approval` on, a person approves it first.
//
// A board with no roster works as it always did: one agent per duty, start to finish.
//
// Like the rules, a roster an agent drafts is a DRAFT until the board's owner accepts it — every
// later session is told to follow it. The owner can also put a shipped preset in force directly.

import { badRequest, conflict, str, oneOf, intIn } from "./http.js";
import { resolveProject, requireHuman } from "./identity.js";
import { putOp } from "./store.js";
import { heldDutyOfKind, LEVELS } from "./profile.js";
import { seedDuty, UNFINISHED } from "./duties.js";
import { PRESETS, presetFor, DRAFTING_STANDARD } from "./charters.js";

/** How capable a role's model should be. A machine maps each to the combinations it has enabled. */
export { LEVELS };

export const MAX_ROLES = 8;
/** A charter is read into every session that role works, so it is held to what fits there well. */
export const MAX_CHARTER_CHARS = 6000;
/** Send-backs from a reviewer before a person is asked what should change. */
export const DEFAULT_MAX_BOUNCES = 3;
/** The first `dutyboard` whose sessions know their role, hand duties on and keep the team's memory. */
export const ROSTER_MIN_RELEASE = "2.36.0";

const ROLE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FLAGS = ["intake", "reviews", "reviewed", "plans"];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const withoutMeta = ({ key, _created, _updated, ...data }) => data;

// --- validation -------------------------------------------------------------------------

function roleFrom(v, f) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw badRequest(`'${f}' must be an object`);
  const id = str(v.id, `${f}.id`, { required: true, max: 32 });
  if (!ROLE_ID.test(id)) throw badRequest(`'${f}.id' must be lowercase letters, digits and dashes`);
  const role = {
    id,
    name: str(v.name, `${f}.name`, { required: true, max: 40 }),
    summary: str(v.summary, `${f}.summary`, { required: true, max: 240 }),
    level: oneOf(v.level, `${f}.level`, LEVELS, "standard"),
    charter: str(v.charter, `${f}.charter`, { required: true, max: MAX_CHARTER_CHARS }),
  };
  for (const flag of FLAGS) {
    if (v[flag] != null && typeof v[flag] !== "boolean") throw badRequest(`'${f}.${flag}' must be a boolean`);
    if (v[flag] === true) role[flag] = true;
  }
  if (role.reviewed && role.reviews) throw badRequest(`'${f}' cannot both need review and be the reviewer`);
  if (role.intake && role.reviewed) throw badRequest(`'${f}' reads every new duty first, so it must be able to finish the trivial ones itself — it cannot also need review`);
  return role;
}

/** A whole roster, checked as a team: one intake role, and a reviewer for anyone who needs one. */
export function rolesFrom(value, field = "roles") {
  if (!Array.isArray(value)) throw badRequest(`'${field}' must be an array`);
  if (value.length < 2) throw badRequest(`a roster needs at least two roles: one that reads new duties first, and one to hand them to`);
  if (value.length > MAX_ROLES) throw badRequest(`a roster may have at most ${MAX_ROLES} roles`);
  const roles = value.map((v, i) => roleFrom(v, `${field}[${i}]`));
  const ids = new Set(roles.map((r) => r.id));
  if (ids.size !== roles.length) throw badRequest(`two roles in '${field}' share an id`);
  const intake = roles.filter((r) => r.intake);
  if (intake.length !== 1) throw badRequest(`exactly one role must have 'intake: true' — the one that reads every new duty first (found ${intake.length})`);
  if (roles.some((r) => r.reviewed) && !roles.some((r) => r.reviews)) {
    throw badRequest("a role is marked 'reviewed' but no role has 'reviews: true' — its work could never be finished");
  }
  return roles;
}

export function settingsFrom(stored, input) {
  const next = { plan_approval: false, max_bounces: DEFAULT_MAX_BOUNCES, ...(stored || {}) };
  if (input == null) return next;
  if (typeof input !== "object" || Array.isArray(input)) throw badRequest("'settings' must be an object");
  if (has(input, "plan_approval")) {
    if (typeof input.plan_approval !== "boolean") throw badRequest("'settings.plan_approval' must be a boolean");
    next.plan_approval = input.plan_approval;
  }
  if (has(input, "max_bounces")) next.max_bounces = intIn(input.max_bounces, "settings.max_bounces", 1, 10, DEFAULT_MAX_BOUNCES);
  return next;
}

// --- reading ----------------------------------------------------------------------------

/** The roster in force on a board, or null when it has none. */
export async function rosterInForce(ctx, projectKey) {
  const row = await ctx.store.get("rosters", projectKey);
  return row && Array.isArray(row.roles) && row.roles.length ? row : null;
}

/** Whether a board's row says it has a roster — a claim and a poll decide on this without a second read. */
export const hasRoster = (project) => !!(project && project.roster && project.roster.intake);

export const intakeOf = (roster) => roster.roles.find((r) => r.intake) || roster.roles[0];

/**
 * The role a duty is with. Only work has one: setup, rules and reviews of notes are the board's own
 * housekeeping. A duty naming a role the roster no longer has goes back to intake to be routed again.
 */
export function roleFor(roster, duty) {
  if (!roster || (duty.kind || "work") !== "work") return null;
  return roster.roles.find((r) => r.id === duty.role) || intakeOf(roster);
}

/** A role as other roles see it: enough to decide whether to hand a duty to it, and no charter. */
export const roleCard = (r) => ({
  id: r.id,
  name: r.name,
  summary: r.summary,
  level: r.level,
  ...Object.fromEntries(FLAGS.filter((f) => r[f]).map((f) => [f, true])),
});

/**
 * What a session is told about the team when it takes a duty: its own role in full, everyone else
 * as a card, how the last role left the duty, and what the board has decided about handoffs.
 */
export function roleContext(roster, duty) {
  const role = roleFor(roster, duty);
  if (!role) return null;
  return {
    version: roster.version || 0,
    role: { ...roleCard(role), charter: role.charter },
    team: roster.roles.filter((r) => r.id !== role.id).map(roleCard),
    settings: settingsFrom(roster.settings),
    handoff: duty.handoff || null,
    bounces: duty.bounces || 0,
  };
}

// --- levels -----------------------------------------------------------------------------

const EFFORT_RANK = { none: 0, minimal: 0, low: 0, medium: 1, high: 2, xhigh: 3, max: 3 };

/** The effort a combination runs at: its own, or the one its model's name carries (Cursor's do). */
function effortRank(option) {
  if (option.effort) return EFFORT_RANK[option.effort] ?? 2;
  const named = /(xhigh|max|high|medium|low|minimal)/.exec((option.model || "").toLowerCase());
  return named ? EFFORT_RANK[named[1]] : 2;
}

/**
 * The level one agent/model/effort combination works at. The machine's owner can say; left unsaid it
 * is read from the model family and the effort — small models are light, the largest at high effort
 * is principal, and for everything between, effort decides.
 */
export function levelOf(option) {
  if (LEVELS.includes(option.level)) return option.level;
  const model = (option.model || "").toLowerCase();
  const effort = effortRank(option);
  if (/(haiku|mini|nano|flash|lite|small|fast)/.test(model)) return effort >= 3 ? "standard" : "light";
  if (/fable/.test(model)) return effort >= 2 ? "principal" : effort === 1 ? "senior" : "standard";
  if (effort === 0) return "light";
  if (effort === 3) return "senior";
  return "standard";
}

/**
 * A machine's enabled combinations in the order a role at `level` should try them: those at the
 * level, then the next ones up, then down — so a machine with nothing at a level still works the
 * duty rather than leaving it queued for ever. Null for a machine that has never chosen its
 * combinations: it has no list to order, and runs the board's own setting.
 */
export function optionsForLevel(machineOptions, level) {
  if (!Array.isArray(machineOptions)) return null;
  const want = LEVELS.indexOf(level);
  const distance = (o) => {
    const at = LEVELS.indexOf(levelOf(o));
    return at === want ? 0 : at > want ? at - want : LEVELS.length + (want - at);
  };
  return machineOptions
    .filter((o) => !o.disabled)
    .map((o, i) => ({ o, i, d: distance(o) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ o }) => ({ agent: o.agent, model: o.model || "", effort: o.effort || "" }));
}

/**
 * The combinations a duty runs with on the calling machine. A duty a person pinned keeps its own
 * list; otherwise its role's level picks from what the machine has enabled.
 */
export function dutyOptions(ctx, roster, duty) {
  if (duty.agent_options != null) return duty.agent_options;
  const role = ctx.caller && ctx.caller.machineId ? roleFor(roster, duty) : null;
  if (!role) return null;
  return optionsForLevel(ctx.caller.machineRow && ctx.caller.machineRow.agent_options, role.level);
}

// --- routes -----------------------------------------------------------------------------

const presetCards = () => Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, about: p.about, roles: p.roles.map((r) => r.name) }));

/**
 * `POST /board/roster` — the team in force. People also see a draft waiting for them, and the
 * presets they can choose. An agent sees the roles as cards; `role` names one to read its charter.
 */
export async function getRoster(ctx, body) {
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  const row = await ctx.store.get("rosters", project.key);
  const roles = (row && row.roles) || [];
  const base = {
    project_id: project.key,
    version: (row && row.version) || 0,
    in_force: roles.length > 0,
    settings: settingsFrom(row && row.settings),
    updated_at: (row && row.updated_at) || null,
  };
  if (ctx.caller.kind === "human") {
    return { ...base, roles, source: (row && row.source) || null, draft: (row && row.draft) || null, presets: presetCards(), suggested_preset: presetFor(project.profile) };
  }
  const wanted = str(body.role, "role", { max: 32 });
  const one = wanted && roles.find((r) => r.id === wanted);
  if (wanted && !one) throw badRequest(`this board has no role '${wanted}' — its roles are: ${roles.map((r) => r.id).join(", ") || "none"}`);
  return { ...base, roles: roles.map(roleCard), ...(one ? { role: { ...roleCard(one), charter: one.charter } } : {}), has_draft: !!(row && row.draft) };
}

/**
 * `POST /board/roster/set` — the owner's. One of:
 *   `{ preset }`           put a shipped team in force
 *   `{ roles, settings? }` put an edited team in force
 *   `{ settings }`         change how handoffs are handled, keeping the roles
 *   `{ off: true }`        no team: one agent per duty, as before
 *   `{ discard_draft: true }`
 */
export async function setRoster(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const row = await ctx.store.get("rosters", project.key);
  const draft = body.discard_draft === true ? null : (row && row.draft) || null;
  if (body.off === true) return writeRoster(ctx, project, row, { roles: [], settings: row && row.settings, draft, source: "off" });
  if (body.preset != null) {
    const id = oneOf(body.preset, "preset", Object.keys(PRESETS));
    return writeRoster(ctx, project, row, { roles: rolesFrom(PRESETS[id].roles), settings: settingsFrom(row && row.settings, body.settings), draft, source: `preset:${id}` });
  }
  if (body.roles != null) {
    return writeRoster(ctx, project, row, { roles: rolesFrom(body.roles), settings: settingsFrom(row && row.settings, body.settings), draft, source: "owner" });
  }
  if (body.settings != null || body.discard_draft === true) {
    return writeRoster(ctx, project, row, { roles: (row && row.roles) || [], settings: settingsFrom(row && row.settings, body.settings), draft, source: (row && row.source) || "owner" });
  }
  throw badRequest("send 'preset', 'roles', 'settings', 'off' or 'discard_draft'");
}

/** `POST /board/roster/accept` — the owner puts the drafted team in force. */
export async function acceptRoster(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const row = await ctx.store.get("rosters", project.key);
  if (!row || !row.draft) throw conflict("there is no drafted team to accept");
  return writeRoster(ctx, project, row, { roles: rolesFrom(row.draft.roles), settings: settingsFrom(row.settings), draft: null, source: "draft" });
}

/**
 * `POST /board/roster/submit` — a roster duty hands in the team it drafted. A second submission
 * replaces the first. Nothing changes on the board until its owner accepts.
 */
export async function submitRoster(ctx, body) {
  const { duty, project } = await heldDutyOfKind(ctx, body, "roster");
  const roles = rolesFrom(body.roles);
  const row = await ctx.store.get("rosters", project.key);
  const now = Date.now();
  const draft = {
    roles,
    note: str(body.note, "note", { max: 1000 }),
    duty_id: duty.key,
    agent_id: duty.assigned_agent_id,
    based_on: (row && row.version) || 0,
    created_at: now,
  };
  await ctx.store.putOne("rosters", project.key, {
    ...(row ? withoutMeta(row) : { project_id: project.key, owner_uid: project.owner_uid, version: 0, roles: [], settings: settingsFrom(null) }),
    draft,
    updated_at: now,
  });
  await ctx.publish(project.key, null, { t: "board", what: "roster" });
  return { ok: true, project_id: project.key, roles: roles.length, draft_for_version: draft.based_on + 1 };
}

/**
 * The roster row and the board's pointer to it move together, so filing a duty and polling the
 * queue — which read only the board — always know whether there is a team and who reads duties first.
 */
async function writeRoster(ctx, project, row, { roles, settings, draft, source }) {
  const now = Date.now();
  const version = ((row && row.version) || 0) + 1;
  const board = await ctx.store.get("projects", project.key);
  const next = {
    project_id: project.key,
    owner_uid: project.owner_uid,
    version,
    roles,
    settings: settingsFrom(settings),
    draft,
    source,
    updated_by: ctx.caller.uid,
    updated_at: now,
  };
  await ctx.store.transaction([
    putOp("rosters", project.key, next),
    putOp("projects", project.key, { ...withoutMeta(board), roster: rosterPointer(next), updated_at: now }),
  ]);
  await ctx.publish(project.key, null, { t: "board", what: "roster" });
  return { ok: true, project_id: project.key, version, in_force: roles.length > 0, roles: roles.map(roleCard) };
}

/** What a board's own row says about its team: enough to file and queue duties without reading it. */
export const rosterPointer = (roster) => ({ version: roster.version, intake: roster.roles.length ? intakeOf(roster).id : null });

/** The rows a new board's preset team is made of, as ops for the transaction that makes the board. */
export function presetOps(project, presetId, now = Date.now()) {
  const preset = PRESETS[presetId];
  if (!preset) throw badRequest(`'roster' must be one of ${Object.keys(PRESETS).join(", ")}, or 'none'`);
  const roster = {
    project_id: project.key,
    owner_uid: project.owner_uid,
    version: 1,
    roles: rolesFrom(preset.roles),
    settings: settingsFrom(null),
    draft: null,
    source: `preset:${presetId}`,
    updated_by: project.owner_uid,
    updated_at: now,
  };
  return { op: putOp("rosters", project.key, roster), pointer: rosterPointer(roster) };
}

/**
 * Which team a new board starts with. `auto` is the one that fits what the board is for, which is
 * what the console and the terminal ask for; a caller that says nothing gets none, as before teams
 * existed, so a script that makes a board still gets the board it expects.
 */
export function startingPreset(value, profile) {
  if (value == null || value === "none" || value === false) return null;
  if (value === "auto") return presetFor(profile);
  return oneOf(value, "roster", Object.keys(PRESETS));
}

/** What a roster duty is asked to do. Seeded by `/board/roster/draft`; the daemon's prompt carries the rest. */
export const ROSTER_DUTY = {
  title: "Draft this board's team",
  brief:
    "Read what this board is for — its profile, description, rules and the work already on it — and draft the team that should work its duties: " +
    "the roles, what each is for, the level of model each needs, and each one's charter. " +
    DRAFTING_STANDARD +
    " Exactly one role reads every new duty first and routes it. Submit the team with board_roster_submit; a person accepts it before it takes effect.",
};

/**
 * `POST /board/roster/draft` — the owner asks for a team drafted for this board. Files a roster
 * duty; what it hands in waits as a draft. One at a time: a second ask answers the one under way.
 */
export async function draftRoster(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const { rows } = await ctx.store.query("duties", {
    where: [
      { field: "project_id", op: "=", value: project.key },
      { field: "kind", op: "=", value: "roster" },
      { field: "status", op: "in", value: UNFINISHED },
    ],
    limit: 1,
  });
  if (rows.length) return { ok: true, project_id: project.key, duty_id: rows[0].key, existing: true };
  const wanted = str(body.note, "note", { max: 1000 });
  const { id, op } = seedDuty(project, {
    ...ROSTER_DUTY,
    brief: wanted ? `${ROSTER_DUTY.brief}\n\nThe board's owner asks: ${wanted}` : ROSTER_DUTY.brief,
    kind: "roster",
  });
  await ctx.store.transaction([op]);
  await ctx.publish(project.key, id, { t: "duty", id, status: "queued" });
  return { ok: true, project_id: project.key, duty_id: id, existing: false };
}
