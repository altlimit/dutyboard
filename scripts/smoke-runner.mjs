#!/usr/bin/env node
// End to end: a real `dutyboard` daemon working a real board on the emulator, with a fake agent.
//
//   altengine dev && npm run setup      # in another terminal
//   npm run smoke:runner
//
// It builds the binary, pairs it as a person would, links a git repository that has a real (bare)
// remote, and files duties. The daemon claims them, prepares a worktree per duty, starts
// scripts/fake-claude.mjs as the agent, and checks the board afterwards — so what is asserted here
// is the daemon's loop, not the agent's judgement:
//
//   - a linked board's setup and rules duties run first, alone, and record what they found;
//   - a work duty is done on its own branch in its own folder, lands on the remote's main branch,
//     and its worktree is gone afterwards; the bridge refused claiming, touching another duty, and
//     completing before integrating;
//   - a duty parked on a question keeps its folder; answered, it resumes the same conversation in
//     the same place, uncommitted file and all;
//   - a session that keeps stopping is retried, then parked with its log attached;
//   - deleting a duty stops its session and removes its worktree.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const API = process.env.DUTYBOARD_API || `${BASE}/fn/${process.env.DUTYBOARD_FN_INSTANCE || "dutyboard"}/board`;

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail === undefined ? "" : `\n      got: ${JSON.stringify(detail)}`}`);
  }
}

async function call(path, body, token, { board } = {}) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(board ? { "x-dutyboard-board": board } : {}) },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, probe, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      console.log(`      (gave up waiting: ${label})`);
      return null;
    }
    await sleep(500);
  }
}

const events = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function main() {
  console.log(`DutyBoard runner smoke test → ${API}\n`);
  const work = mkdtempSync(join(tmpdir(), "dutyboard-runner-"));
  const home = join(work, "home");
  const bin = join(work, "dutyboard");
  sh("go", ["build", "-o", bin, "./cmd/dutyboard"], join(root, "cli"));
  check("the binary builds", existsSync(bin));

  // A person, and a board made the way the terminal makes one.
  const email = `runner_${Date.now()}@example.test`;
  const signup = await fetch(`${BASE}/v1/auth/${AUTH}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name: "Runner Tester", password: "correct-horse-battery-staple" }),
  }).then((r) => r.json());
  const human = signup.id_token;
  const boardId = `runner-${Date.now().toString(36)}`;
  const created = await call("/projects/create", { name: "Runner", project_id: boardId, profile: { type: "webapp", default_branch: "main" }, runner: { parallel: 1 } }, human);

  // Pair a machine, as `dutyboard` does on first run.
  const started = await call("/connect/start", { name: "runner-smoke", os: "linux", arch: "amd64", cli_version: "smoke" });
  await call("/connect/approve", { user_code: started.user_code }, human);
  const paired = await call("/connect/poll", { device_code: started.device_code });
  execFileSync("mkdir", ["-p", home]);
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: API, machine_id: paired.machine_id, machine_name: paired.name, agent_prefix: paired.agent_prefix, projects_root: join(work, "projects") }));
  writeFileSync(join(home, "credentials.json"), JSON.stringify({ "machine-key": paired.machine_key }));

  // A repository with a remote, linked the way `dutyboard` links the folder it is run in.
  const remote = join(work, "remote.git");
  const linked = join(work, "linked");
  sh("git", ["init", "--quiet", "--bare", "-b", "main", remote], work);
  sh("git", ["clone", "--quiet", remote, linked], work);
  writeFileSync(join(linked, "README.md"), "# runner smoke\n");
  sh("git", ["add", "."], linked);
  sh("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "start"], linked);
  sh("git", ["push", "--quiet", "origin", "HEAD:main"], linked);
  const link = await call("/machine/link", { project_id: boardId, path_hint: linked }, paired.machine_key);
  writeFileSync(join(home, "workspaces.json"), JSON.stringify([{ board: boardId, path: linked, linked_at: Date.now() }]));

  const hello = await call("/duty/enqueue", { project_id: boardId, title: "Add a hello file", brief: "Anything will do." }, human);
  const park = await call("/duty/enqueue", { project_id: boardId, title: "[park] Pick a colour", brief: "Ask which colour, then do it." }, human);

  const fake = join(work, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "scripts", "fake-claude.mjs"))} "$@"\n`);
  chmodSync(fake, 0o755);
  const log = join(work, "fake-claude.log");
  const daemon = spawn(bin, ["--no-service"], {
    env: { ...process.env, DUTYBOARD_HOME: home, DUTYBOARD_NO_KEYRING: "1", DUTYBOARD_CLAUDE: fake, FAKE_CLAUDE_LOG: log, DUTYBOARD_RETRY_SECONDS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonOut = "";
  daemon.stdout.on("data", (d) => (daemonOut += d));
  daemon.stderr.on("data", (d) => (daemonOut += d));
  const get = (id) => call("/duty/get", { duty_id: id }, human).then((r) => r.duty);

  try {
    // --- setup and rules, before anything else ---------------------------------
    const setup = await until("setup done", async () => (await get(link.setup_duty_id)).status === "done" && (await get(link.setup_duty_id)));
    check("the daemon runs the machine's setup duty first", !!setup, setup);
    const setupEvent = events(log).find((e) => e.event === "setup");
    check(
      "setup records the toolchain and registers a tool, over the bridge",
      setupEvent && !setupEvent.proposeError && !setupEvent.registerError && setupEvent.integrate?.no_op && !setupEvent.completeError,
      setupEvent,
    );
    const profile = await call("/board/profile", { project_id: boardId }, human);
    check("and the board now knows the project's test command", profile.profile.test_command === "test -f README.md", profile.profile);
    const registry = JSON.parse(readFileSync(join(home, "tools", "registry.json"), "utf8"));
    check("the machine remembers the tool it registered", registry.tools.some((t) => t.name === "fakenode"), registry);

    const rules = await until("rules drafted", async () => (await get(created.rules_duty_id)).status === "done");
    check("then the rules duty", !!rules);
    const drafted = await call("/board/rules", { project_id: boardId }, human);
    check("which leaves a draft for a person", /README/.test(drafted.draft?.body || ""), drafted);

    // --- a work duty -------------------------------------------------------------
    const done = await until("hello done", async () => {
      const d = await get(hello.duty_id);
      return d.status === "done" && d;
    });
    check("a work duty is finished", !!done, done);
    const doneEvent = events(log).find((e) => e.event === "done" && e.dutyId === hello.duty_id);
    const startEvent = events(log).find((e) => e.event === "start" && e.dutyId === hello.duty_id);
    check("on its own branch, in its own folder", startEvent?.branch === `duty/${hello.duty_id}` && startEvent.cwd.includes(join("worktrees", boardId, hello.duty_id)), startEvent);
    check("with the machine's tools first on its PATH", startEvent?.path === dirname(process.execPath), startEvent?.path);
    check("the session is not offered duty_claim, and is offered duty_integrate", startEvent && !startEvent.tools.includes("duty_claim") && startEvent.tools.includes("duty_integrate"), startEvent?.tools);
    check(
      "and the bridge refused claiming, another duty, and completing before integrating",
      doneEvent && doneEvent.guards.claim && doneEvent.guards.notMine && doneEvent.guards.early,
      doneEvent?.guards,
    );
    check("its work landed on the remote's main branch", sh("git", ["--git-dir", remote, "show", `main:work-${hello.duty_id}.txt`]).includes(hello.duty_id));
    check("and the outcome names the commit", done && done.outcome_summary.includes(doneEvent?.integrate?.commit || "missing"), done?.outcome_summary);
    const worktrees = () => (existsSync(join(home, "worktrees", boardId)) ? readdirSync(join(home, "worktrees", boardId)).filter((n) => !n.startsWith(".")) : []);
    await until("worktree removed", () => !worktrees().includes(hello.duty_id), 10_000);
    check("its worktree is gone once it is done", !worktrees().includes(hello.duty_id), worktrees());

    // --- parked, answered, resumed ----------------------------------------------
    const parked = await until("parked", async () => {
      const d = await get(park.duty_id);
      return d.status === "needs_decision" && d;
    });
    check("a session parks its duty on a question", !!parked, parked);
    check("and the duty is kept for this machine", parked?.affinity?.machine_id === paired.machine_id, parked?.affinity);
    check("its worktree waits, with the uncommitted file in it", existsSync(join(home, "worktrees", boardId, park.duty_id, "half-done.txt")));
    const firstSession = events(log).find((e) => e.event === "start" && e.dutyId === park.duty_id)?.session;
    await call("/duty/resolve", { duty_id: park.duty_id, resolution_text: "Green." }, human);
    const resumedDone = await until("resumed and done", async () => (await get(park.duty_id)).status === "done", 60_000);
    const resumedStart = events(log).find((e) => e.event === "start" && e.dutyId === park.duty_id && e.resumed);
    check("answered, it is resumed and finished", !!resumedDone);
    check("in the same conversation", resumedStart?.session === firstSession, { first: firstSession, resumed: resumedStart?.session });
    check("and the same folder: the file it left there landed too", sh("git", ["--git-dir", remote, "show", "main:half-done.txt"]).includes("colour"));

    // --- keeps stopping ---------------------------------------------------------
    const crash = await call("/duty/enqueue", { project_id: boardId, title: "[crash] Fall over", brief: "Every session dies." }, human);
    const gaveUp = await until("crash parked", async () => {
      const d = await get(crash.duty_id);
      return d.status === "needs_decision" && d;
    });
    check(`a session that keeps stopping is tried ${3} times`, events(log).filter((e) => e.event === "crash" && e.dutyId === crash.duty_id).length === 3);
    check("then put to a person, with its log attached", !!gaveUp && gaveUp.attachment_count === 1 && /stopped before finishing/.test(gaveUp.last_question || ""), gaveUp);
    await call("/duty/delete", { duty_id: crash.duty_id, confirm: crash.duty_id }, human);

    // --- deleted mid-session ----------------------------------------------------
    const slow = await call("/duty/enqueue", { project_id: boardId, title: "[slow] Take forever", brief: "Sleeps." }, human);
    await until("slow started", () => events(log).some((e) => e.event === "slow-start" && e.dutyId === slow.duty_id));
    await call("/duty/delete", { duty_id: slow.duty_id, confirm: slow.duty_id }, human);
    const removed = await until("slow worktree removed", () => !worktrees().includes(slow.duty_id), 20_000);
    check("deleting a duty stops its session and removes its worktree", !!removed && !events(log).some((e) => e.event === "slow-end"), worktrees());

    const machines = await call("/machines/list", {}, human);
    check("the console sees the machine online", machines.machines[0]?.online === true, machines.machines[0]);
  } finally {
    daemon.kill("SIGTERM");
    await sleep(500);
  }

  if (failures.length) console.log("\n--- daemon output ---\n" + daemonOut.split("\n").slice(-60).join("\n"));
  await call("/machines/revoke", { machine_id: paired.machine_id }, human).catch(() => {});
  await call("/projects/delete", { project_id: boardId, confirm: boardId }, human).catch(() => {});
  console.log(`\n${failures.length ? "✖" : "✔"} ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
