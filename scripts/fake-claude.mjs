#!/usr/bin/env node
// A stand-in for `claude -p` — and, started as `… exec`, for `codex exec --json` — for
// scripts/smoke-runner.mjs.
//
// It is started by the dutyboard daemon exactly as Claude Code would be — same arguments, same MCP
// config — and does what a well-behaved session does: starts the `dutyboard mcp` server named in the
// config, reads its duty from the prompt, does the work in its worktree, integrates and completes.
// On the way it also tries what the bridge must refuse, and writes everything it saw to
// $FAKE_CLAUDE_LOG so the smoke test can assert on it.
//
// What it does is steered by the duty: the setup and rules prompts are recognised by their wording,
// and a work duty's title can carry [park], [crash] or [slow].

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const codex = args[0] === "exec";
// Cursor: `-p --output-format stream-json --trust --workspace <dir> … <prompt>`, MCP servers read from the
// workspace's .cursor/mcp.json, the instructions at the top of the prompt.
const cursor = !codex && args.includes("--trust") && args.includes("--workspace");
if (args[0] === "status" && args.includes("--format")) {
  console.log(JSON.stringify({ status: "authenticated", isAuthenticated: true }));
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}

// Codex: `-c key=value` pairs, the values TOML as the daemon writes them — JSON, except that an inline
// table says `"k" = "v"`.
const config = {};
if (codex) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c") continue;
    const [key, ...rest] = args[++i].split("=");
    const raw = rest.join("=");
    config[key] = JSON.parse(raw.startsWith("{") ? raw.replace(/"\s=\s"/g, '":"') : raw);
  }
}
const codexResume = codex && args[1] === "resume";
const cursorPrompt = cursor ? args[args.length - 1] : "";
const cursorSplit = cursorPrompt.lastIndexOf("\n\n---\n\n");
const prompt = codex ? args[args.length - 1] : cursor ? (cursorSplit >= 0 ? cursorPrompt.slice(cursorSplit + 7) : cursorPrompt) : opt("-p") || "";
const session = codex ? (codexResume ? args[args.length - 2] : randomUUID()) : cursor ? opt("--resume") || randomUUID() : opt("--resume") || opt("--session-id");
const resumed = codex ? codexResume : !!opt("--resume");
const record = (entry) =>
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ ...entry, agent: codex ? "codex" : cursor ? "cursor" : "claude", at: Date.now() }) + "\n");
const say = (event) => {
  if (codex) {
    // The same moments, as Codex reports them.
    if (event.type === "system") event = { type: "thread.started", thread_id: session };
    else if (event.type === "assistant") event = { type: "item.started", item: { type: "command_execution", command: `bash -lc '${event.message.content[0].input.command}'`, status: "in_progress" } };
    else if (event.type === "result") event = event.is_error ? { type: "turn.failed", error: { message: event.result } } : { type: "turn.completed", usage: {} };
  }
  if (cursor && event.type === "assistant") {
    event = { type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: event.message.content[0].input.command } } }, session_id: session };
  }
  process.stdout.write(JSON.stringify(event) + "\n");
};

say({ type: "system", subtype: "init", session_id: session, cwd: process.cwd() });

function codexServers() {
  const servers = {};
  for (const [key, value] of Object.entries(config)) {
    const m = key.match(/^mcp_servers\.([^.]+)\.(.+)$/);
    if (!m) continue;
    servers[m[1]] ||= {};
    servers[m[1]][m[2]] = value;
  }
  for (const s of Object.values(servers)) {
    // env_vars are passed through from Codex's own environment, which is where the daemon put them.
    s.env = { ...(s.env || {}) };
    for (const name of s.env_vars || []) s.env[name] = process.env[name];
  }
  return servers;
}
function cursorServers() {
  const servers = JSON.parse(readFileSync(".cursor/mcp.json", "utf8")).mcpServers;
  for (const s of Object.values(servers)) {
    if (!s.envFile) continue;
    s.env = { ...(s.env || {}) };
    for (const line of readFileSync(s.envFile, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) s.env[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return servers;
}
const mcpServers = codex ? codexServers() : cursor ? cursorServers() : JSON.parse(readFileSync(opt("--mcp-config"), "utf8")).mcpServers;
const server = mcpServers.dutyboard;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const waiting = new Map();
let nextId = 1;
mcp.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const tool = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return { isError: true, text: r.error.message };
  return { isError: !!r.result.isError, text: r.result.content?.[0]?.text || "", data: r.result.structuredContent };
};
const git = (...a) => execFileSync("git", a, { cwd: process.cwd(), encoding: "utf8" }).trim();
const finish = (text, code = 0) => {
  say({ type: "result", subtype: code ? "error" : "success", is_error: !!code, result: text, session_id: session });
  mcp.kill();
  process.exit(code);
};

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
const dutyId = (prompt.match(/`(duty_[0-9A-Z]+)`/) || [])[1];
const title = (prompt.match(/^# (?!The project|Working|Tools|From)(.+)$/m) || [])[1] || "";
record({
  event: "start", dutyId, title, resumed, session, tools, cwd: process.cwd(), branch: git("rev-parse", "--abbrev-ref", "HEAD"), path: process.env.PATH.split(":")[0],
  mcp: mcpServers, strictMCP: args.includes("--strict-mcp-config"), allowedTools: (opt("--allowedTools") || "").split(","),
  instructions: (codex ? config.developer_instructions : cursor ? cursorPrompt.slice(0, Math.max(cursorSplit, 0)) : opt("--append-system-prompt")) || "",
  sandbox: codex ? { mode: config.sandbox_mode, writable: config["sandbox_workspace_write.writable_roots"] } : null,
});

if (/make this machine ready/.test(prompt)) {
  const proposed = await tool("board_profile_propose", { duty_id: dutyId, toolchain: [{ name: "node", version: process.versions.node }], test_command: "test -f README.md" });
  const registered = await tool("tools_register", { name: "fakenode", version: "1", path: process.execPath.replace(/\/node$/, ""), verify: "node --version" });
  const integrated = await tool("duty_integrate");
  const completed = await tool("duty_complete", { duty_id: dutyId, outcome_summary: "Node is installed; recorded the toolchain." });
  record({ event: "setup", proposeError: proposed.isError ? proposed.text : null, registerError: registered.isError ? registered.text : null, integrate: integrated.data, completeError: completed.isError ? completed.text : null });
  finish("set up");
}

if (/write this project's rules/.test(prompt)) {
  const submitted = await tool("board_rules_submit", { duty_id: dutyId, body: "# Rules\n\n- Every change keeps README.md." });
  const integrated = await tool("duty_integrate");
  const completed = await tool("duty_complete", { duty_id: dutyId, outcome_summary: "Drafted the rules." });
  record({ event: "rules", submitError: submitted.isError ? submitted.text : null, integrate: integrated.data, completeError: completed.isError ? completed.text : null });
  finish("rules");
}

if (title.includes("[crash]")) {
  record({ event: "crash", dutyId });
  finish("the process fell over", 1);
}
if (title.includes("[slow]")) {
  // What Claude Code emits when it starts a command — the daemon turns it into the duty's "now" line.
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "tools/run_tests.sh --all" } }] } });
  record({ event: "slow-start", dutyId });
  await new Promise((r) => setTimeout(r, 120_000));
  record({ event: "slow-end", dutyId });
  finish("slow");
}
if (title.includes("[park]") && !resumed) {
  const parked = await tool("duty_checkpoint", { duty_id: dutyId, kind: "question", message: "Blue or green?", suggested_options: ["blue", "green"], set_status: "needs_decision" });
  writeFileSync("half-done.txt", "started, waiting on a colour\n");
  record({ event: "parked", dutyId, error: parked.isError ? parked.text : null });
  finish("parked");
}

if (title.includes("[multi]")) {
  // Work across the board's two repositories: open the other one, commit in both, land them together.
  const opened = await tool("duty_repo_open", { name: "tools" });
  const where = opened.data?.path;
  writeFileSync(`multi-${dutyId}.txt`, "main side\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "main side");
  let otherBranch = null;
  if (where) {
    writeFileSync(`${where}/multi-${dutyId}.txt`, "tools side\n");
    execFileSync("git", ["-C", where, "add", "-A"]);
    execFileSync("git", ["-C", where, "commit", "--quiet", "-m", "tools side"]);
    otherBranch = execFileSync("git", ["-C", where, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  }
  const integrated = await tool("duty_integrate");
  const completed = await tool("duty_complete", { duty_id: dutyId, outcome_summary: "Changed both repositories." });
  record({ event: "multi", dutyId, opened: opened.data, openError: opened.isError ? opened.text : null, otherBranch, integrate: integrated.data, integrateError: integrated.isError ? integrated.text : null, completeError: completed.isError ? completed.text : null });
  finish("multi");
}

if (title.includes("[deploy]")) {
  writeFileSync("fn.js", 'export default { async fetch() { return new Response("deployed by a session"); } };\n');
  git("add", "-A");
  git("commit", "--quiet", "-m", "a function");
  const integrated = await tool("duty_integrate");
  const refused = await tool("altengine_deploy_function", { file: "fn.js", instance: "not-allowed", name: "hello" });
  const escaped = await tool("altengine_deploy_function", { file: "../../../../etc/passwd", instance: "runner-fns", name: "hello" });
  const deployed = await tool("altengine_deploy_function", { file: "fn.js", instance: "runner-fns", name: "hello" });
  const completed = await tool("duty_complete", { duty_id: dutyId, outcome_summary: `Deployed hello v${deployed.data?.version}` });
  record({ event: "deploy", dutyId, offered: tools.includes("altengine_deploy_function"), integrate: integrated.data, refused: refused.isError, escaped: escaped.isError, deployed: deployed.data, deployError: deployed.isError ? deployed.text : null, completeError: completed.isError ? completed.text : null });
  finish("deployed");
}

const claim = await tool("duty_claim", { duty_id: dutyId });
const notMine = await tool("duty_complete", { duty_id: "duty_NOTMINE", outcome_summary: "not mine" });
const early = await tool("duty_complete", { duty_id: dutyId, outcome_summary: "too early" });
const file = `work-${dutyId}.txt`;
writeFileSync(file, `done for ${dutyId}\n`);
git("add", "-A");
git("commit", "--quiet", "-m", `work for ${dutyId}`);
const integrated = await tool("duty_integrate");
const completed = await tool("duty_complete", { duty_id: dutyId, outcome_summary: `Added ${file} in ${integrated.data?.commit}` });
record({
  event: "done",
  dutyId,
  guards: { claim: claim.isError, notMine: notMine.isError, early: early.isError },
  integrate: integrated.data,
  completeError: completed.isError ? completed.text : null,
});
finish("done");
