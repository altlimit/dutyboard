// What the console shows about projects and the machines that work them.
//
// Values match the function's (functions/src/profile.js, machines.js); labels are what a person
// reads. Kept in one place so the board wizard, the settings page and the runners page cannot
// describe the same thing three ways.

export const PROJECT_TYPES = [
  { key: "game", label: "Game" },
  { key: "website", label: "Website" },
  { key: "webapp", label: "Web app" },
  { key: "mobile", label: "Mobile app" },
  { key: "desktop", label: "Desktop app" },
  { key: "api", label: "API / backend" },
  { key: "cli-lib", label: "CLI or library" },
  { key: "other", label: "Other" },
];

export const DEPLOY_METHODS = [
  { key: "none", label: "Nothing deploys" },
  { key: "ci", label: "CI deploys on push" },
  { key: "ci-dispatch", label: "CI deploys when triggered" },
  { key: "command", label: "A deploy command" },
  { key: "altengine", label: "Deployed to altengine" },
];

export const GIT_MODES = [
  { key: "push", label: "Push to the main branch", hint: "Rebased, tested with the test command, and pushed." },
  { key: "pr", label: "Open a pull request", hint: "Pushed to its own branch, for a person to merge." },
];

export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
export const PERMISSION_MODES = [
  { key: "acceptEdits", label: "Accept edits (recommended)" },
  { key: "default", label: "Ask for everything (nothing will run unattended)" },
  { key: "plan", label: "Plan only" },
  { key: "bypassPermissions", label: "Bypass all permission checks (sandboxed machines only)" },
];

const RUN_STATES = {
  working: "working",
  integrating: "integrating",
  parked: "parked",
  limited: "waiting for its plan limit",
  waiting: "retrying",
  error: "stuck",
};
export const runStateLabel = (s) => RUN_STATES[s] || s;

export const typeLabel = (key) => (PROJECT_TYPES.find((t) => t.key === key) || { label: key || "—" }).label;

/**
 * What each machine says it is doing, by duty: `{ [duty_id]: { machine, state, detail } }`. Built
 * from `/board/runners`, which a runner event says to re-read.
 */
export function activityByDuty(runners) {
  const out = {};
  for (const r of runners || []) {
    for (const x of r.runs || []) out[x.duty_id] = { machine: r.machine_name, online: r.online, state: x.state, detail: x.detail || "" };
  }
  return out;
}

/** The line a card or a duty page shows: the detail when there is one, else the state. */
export const activityLine = (a) => (a ? a.detail || runStateLabel(a.state) : "");

/** A one-line summary of a board's runners, for its header. */
export function runnerSummary(runners) {
  if (!runners || !runners.length) return { tone: "off", text: "No runner" };
  const online = runners.filter((r) => r.online !== false);
  const working = runners.reduce((n, r) => n + (r.runs || []).filter((x) => x.state === "working" || x.state === "integrating").length, 0);
  const limited = runners.some((r) => (r.runs || []).some((x) => x.state === "limited"));
  if (runners.some((r) => r.problem)) return { tone: "warn", text: "Runner needs attention" };
  if (!online.length) return { tone: "off", text: runners.length === 1 ? "Runner offline" : `${runners.length} runners offline` };
  if (limited) return { tone: "warn", text: "Runner at its plan limit" };
  if (working) return { tone: "live", text: `${working} ${working === 1 ? "duty" : "duties"} running` };
  return { tone: "live", text: online.length === 1 ? "Runner idle" : `${online.length} runners idle` };
}

/** A profile as the form edits it, from what the function stores. */
/** One MCP server as the form edits it: lists as one entry per line, env as KEY=value lines. */
export function mcpServerDraft(s = {}) {
  return {
    name: s.name || "",
    kind: s.url ? "url" : "command",
    command: s.command || "",
    args: (s.args || []).join("\n"),
    url: s.url || "",
    env: Object.entries(s.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    secrets: (s.secrets || []).join("\n"),
    tools: (s.tools || []).join("\n"),
    note: s.note || "",
  };
}

const lines = (text) =>
  String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

function mcpServerPayload(d) {
  const out = { name: d.name.trim(), secrets: lines(d.secrets), tools: lines(d.tools), note: d.note.trim() };
  if (d.kind === "url") return { ...out, url: d.url.trim() };
  const env = {};
  for (const line of lines(d.env)) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { ...out, command: d.command.trim(), args: lines(d.args), env };
}

export function profileDraft(profile, runner) {
  const p = profile || {};
  const r = runner || {};
  return {
    mcp_servers: (p.mcp_servers || []).map(mcpServerDraft),
    type: p.type || "webapp",
    type_other: p.type_other || "",
    description: p.description || "",
    repo_url: p.repo_url || "",
    default_branch: p.default_branch || "",
    stack: (p.stack || []).join(", "),
    test_command: p.test_command || "",
    deploy_method: (p.deploy && p.deploy.method) || "none",
    deploy_workflow: (p.deploy && p.deploy.workflow) || "",
    deploy_command: (p.deploy && p.deploy.command) || "",
    deploy_instances: ((p.deploy && p.deploy.altengine_instances) || []).join(", "),
    git_mode: (p.git && p.git.mode) || "push",
    git_author_name: (p.git && p.git.author_name) || "",
    git_author_email: (p.git && p.git.author_email) || "",
    git_ssh_command: (p.git && p.git.ssh_command) || "",
    parallel: r.parallel || 1,
    model: r.model || "",
    effort: r.effort || "",
    permission_mode: r.permission_mode || "acceptEdits",
    session_minutes: r.session_minutes || 180,
    instructions: r.instructions || "",
  };
}

/** What the function takes back. Only fields the form edits — setup's discoveries are left alone. */
export function profilePayload(d) {
  const deploy = { method: d.deploy_method };
  if (d.deploy_method === "ci" || d.deploy_method === "ci-dispatch") deploy.workflow = d.deploy_workflow.trim();
  if (d.deploy_method === "command") deploy.command = d.deploy_command.trim();
  // Sent whatever the method, because the function replaces `deploy` whole: leaving a field out
  // would erase what setup recorded there.
  deploy.altengine_instances = d.deploy_instances
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    profile: {
      type: d.type,
      type_other: d.type === "other" ? d.type_other.trim() : "",
      description: d.description.trim(),
      repo_url: d.repo_url.trim(),
      default_branch: d.default_branch.trim(),
      stack: d.stack
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      test_command: d.test_command.trim(),
      deploy,
      // Replaced whole on the function, so always the complete list.
      mcp_servers: (d.mcp_servers || []).map(mcpServerPayload),
      git: {
        mode: d.git_mode,
        author_name: d.git_author_name.trim(),
        author_email: d.git_author_email.trim(),
        ssh_command: d.git_ssh_command.trim(),
      },
    },
    runner: {
      agent: "claude-code",
      parallel: Number(d.parallel) || 1,
      model: d.model.trim(),
      effort: d.effort,
      permission_mode: d.permission_mode,
      session_minutes: Number(d.session_minutes) || 180,
      instructions: d.instructions.trim(),
    },
  };
}
