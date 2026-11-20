#!/usr/bin/env node
// End to end: a real `dutyboard` daemon working a board that has a team, on the emulator, with a fake agent.
//
//   altengine dev && npm run setup      # in another terminal
//   npm run smoke:team
//
// What is asserted is the part no unit test reaches — a duty passing between roles on one machine:
//
//   - a new board that asks for a team has one, and its first duty goes to the role that reads duties first;
//   - each role is a session of its own, on the model its level picks from what the machine enabled,
//     told who it is and who it can hand to, in the SAME worktree the last role left;
//   - a builder cannot land or complete its own work, by tool list or by call, and nothing reaches
//     the main branch until the reviewer has passed it;
//   - a reviewer sends work back, the builder is told so, and the second attempt lands;
//   - the role that reads duties first finishes a trivial one itself;
//   - what a role writes in the team's memory is in the next session's prompt;
//   - an agent drafts a team, and nothing changes until its owner accepts;
//   - secrets typed in the console reach the machine's keyring, sealed, and are never stored readable;
//   - the team's record is there for the console to read;
//   - the machine runs the project's tests before waking a reviewer, refuses uncommitted or failing work,
//     and tells the reviewer what passed; a change to a sensitive path is reviewed as high risk;
//   - a builder whose work comes back picks up its own conversation;
//   - the role that reads duties first gets a slimmer prompt, and every prompt ends with where it works;
//   - the machine reports how long each session ran.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sealSecrets } from "../app/src/lib/seal.js";
import { roleRecord, roleRecordRequest, topRoles, buildingFloor, officeFeed } from "../app/src/lib/team.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const FN = process.env.DUTYBOARD_FN_INSTANCE || "dutyboard";
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const DS = process.env.DUTYBOARD_DATASTORE || FN;
const API = process.env.DUTYBOARD_API || `${BASE}/fn/${FN}/board`;

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

/** A read straight from the datastore, as the console makes it: row rules decide what comes back. */
async function ds(collection, verb, req, token) {
  const res = await fetch(`${BASE}/v1/datastore/${encodeURIComponent(DS)}/ns/_default/col/${collection}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, probe, ms = 120_000) {
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
  console.log(`DutyBoard team smoke test → ${API}\n`);
  const work = mkdtempSync(join(tmpdir(), "dutyboard-team-"));
  const home = join(work, "home");
  const bin = join(work, "dutyboard");
  sh("go", ["build", "-o", bin, "./cmd/dutyboard"], join(root, "cli"));

  const signUp = (label) =>
    fetch(`${BASE}/v1/auth/${AUTH}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${label}_${Date.now()}@example.test`, name: label, password: "correct-horse-battery-staple" }),
    }).then((r) => r.json());
  // Before its first direct read, the console asks the function to put the `boards` claim on the
  // account and refreshes its token: a read rule that names a claim the token lacks refuses everything.
  const withAccess = async (tokens) => {
    const res = await call("/me/access", {}, tokens.id_token);
    if (!res.refresh) return tokens.id_token;
    const fresh = await fetch(`${BASE}/v1/auth/${AUTH}/token/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }).then((r) => r.json());
    return fresh.id_token;
  };
  const human = await withAccess(await signUp("team_owner"));
  const stranger = await withAccess(await signUp("team_stranger"));

  const boardId = `team-${Date.now().toString(36)}`;
  const remote = join(work, "remote.git");
  const created = await call(
    "/projects/create",
    {
      name: "Team",
      project_id: boardId,
      roster: "auto",
      profile: {
        type: "webapp",
        default_branch: "main",
        test_command: "test ! -e broken.txt",
        repo_url: `file://${remote}`,
        git: { author_name: "Team Bot", author_email: "team-bot@example.com" },
        mcp_servers: [{ name: "helper", command: "node", args: ["-e", "0"], secrets: ["HELPER_TOKEN"], note: "A helper for the smoke test" }],
      },
      runner: { parallel: 1 },
    },
    human,
  );
  check("a board that asks for a team starts with the one that fits it", created.roster === "software", created);
  const team = await call("/board/roster", { project_id: boardId }, human);
  check("in force from the start, with a role that reads duties first", team.in_force && team.roles.filter((r) => r.intake).length === 1 && team.roles.length === 5, team.roles?.map((r) => r.id));
  await call("/board/roster/set", { project_id: boardId, settings: { sensitive_paths: ["secure/**"] } }, human);

  const started = await call("/connect/start", { name: "team-smoke", os: "linux", arch: "amd64", cli_version: "smoke" });
  await call("/connect/approve", { user_code: started.user_code }, human);
  const paired = await call("/connect/poll", { device_code: started.device_code });
  execFileSync("mkdir", ["-p", home]);
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: API, altengine: BASE, machine_id: paired.machine_id, machine_name: paired.name, agent_prefix: paired.agent_prefix, projects_root: join(work, "projects") }));
  const credentials = join(home, "credentials.json");
  writeFileSync(credentials, JSON.stringify({ "machine-key": paired.machine_key }));

  const seedRepo = join(work, "seed");
  sh("git", ["init", "--quiet", "--bare", "-b", "main", remote], work);
  sh("git", ["clone", "--quiet", remote, seedRepo], work);
  writeFileSync(join(seedRepo, "README.md"), "# team smoke\n");
  sh("git", ["add", "."], seedRepo);
  sh("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "start"], seedRepo);
  sh("git", ["push", "--quiet", "origin", "HEAD:main"], seedRepo);
  await call("/machine/link", { project_id: boardId, setup: false }, paired.machine_key);

  const fake = join(work, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "scripts", "fake-claude.mjs"))} "$@"\n`);
  chmodSync(fake, 0o755);
  const fakeCodex = join(work, "fake-codex");
  copyFileSync(fake, fakeCodex);
  chmodSync(fakeCodex, 0o755);
  const log = join(work, "fake-claude.log");
  const daemon = spawn(bin, ["--no-service"], {
    env: { ...process.env, DUTYBOARD_HOME: home, DUTYBOARD_NO_KEYRING: "1", DUTYBOARD_CLAUDE: fake, DUTYBOARD_CODEX: fakeCodex, DUTYBOARD_CURSOR: join(work, "no-cursor"), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_AUTH: join(work, "claude-auth"), DUTYBOARD_RETRY_SECONDS: "1", DUTYBOARD_ACTIVITY_SECONDS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonOut = "";
  daemon.stdout.on("data", (d) => (daemonOut += d));
  daemon.stderr.on("data", (d) => (daemonOut += d));
  const get = (id) => call("/duty/get", { duty_id: id }, human).then((r) => r.duty);
  const teamEvents = (id) => events(log).filter((e) => e.dutyId === id && (e.event || "").startsWith("team"));
  const onMain = (file) => sh("git", ["--git-dir", remote, "ls-tree", "--name-only", "main"]).split("\n").includes(file);

  try {
    // --- the machine says what it has, and its owner says what level each combination works at ---
    const me = await until("the machine's checklist", async () => {
      const m = (await call("/machines/list", {}, human)).machines.find((x) => x.machine_id === paired.machine_id);
      const items = (m && m.readiness && m.readiness.items) || [];
      const ready = (key) => (items.find((it) => it.key === key) || {}).models?.length;
      return ready("claude-code") && ready("codex") && m.seal_key ? m : null;
    });
    check("the machine reports its agents' models and publishes a key to encrypt to", !!me, me);
    const secretsItem = me && me.readiness.items.find((it) => it.key === "mcp_secrets");
    check(
      "and names the MCP secret it is missing, without a value",
      secretsItem && secretsItem.state === "todo" && secretsItem.secrets.length === 1 && Object.entries({ board: boardId, server: "helper", name: "HELPER_TOKEN", header: false, note: "A helper for the smoke test" }).every(([k, v]) => secretsItem.secrets[0][k] === v) && !JSON.stringify(secretsItem).includes("s3cret"),
      secretsItem,
    );

    const light = { agent: "claude-code", model: "backup-model", effort: "low", level: "light" };
    const standard = { agent: "codex", model: "backup-model", effort: "low", level: "standard" };
    const senior = { agent: "codex", model: "quota-model", effort: "high", level: "senior" };
    const saved = await call("/machines/update", { machine_id: paired.machine_id, agent_options: [light, standard, senior] }, human);
    check("its owner tags each combination with a level", saved.machine.agent_options.map((o) => o.level).join() === "light,standard,senior", saved.machine.agent_options);

    // --- a secret typed in the console reaches the machine sealed -------------------------------
    const sealed = await sealSecrets(me.seal_key, [{ board: boardId, server: "helper", name: "HELPER_TOKEN", value: "s3cret-from-the-console" }]);
    check("what leaves the browser does not contain the secret", !sealed.includes("s3cret") && /^v1\./.test(sealed), sealed.slice(0, 20));
    const strangerTry = await fetch(API + "/machine/request", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${stranger}` },
      body: JSON.stringify({ machine_id: paired.machine_id, kind: "mcp_secrets", sealed, seal_key: me.seal_key }),
    });
    check("someone else cannot send a machine secrets", strangerTry.status >= 400, strangerTry.status);
    const asked = await call("/machine/request", { machine_id: paired.machine_id, kind: "mcp_secrets", sealed, seal_key: me.seal_key }, human);
    const stored = await until("the secret stored", async () => {
      const r = (await call("/machine/request/get", { request_id: asked.request.request_id }, human)).request;
      return r.status === "done" || r.status === "failed" ? r : null;
    }, 60_000);
    check("the machine stores it and says so, naming no value", stored && stored.status === "done" && stored.result === `stored 1 MCP secret for ${boardId}`, stored);
    check("it is in the machine's own credential store", JSON.parse(readFileSync(credentials, "utf8"))[`mcp:${boardId}:helper:HELPER_TOKEN`] === "s3cret-from-the-console");
    const afterSecrets = await until("the checklist catches up", async () => {
      const m = (await call("/machines/list", {}, human)).machines.find((x) => x.machine_id === paired.machine_id);
      const it = m.readiness.items.find((x) => x.key === "mcp_secrets");
      return it && it.state === "ok" ? it : null;
    }, 60_000);
    check("and the checklist no longer asks for it", !!afterSecrets);

    // --- the board's own first duty still comes first ------------------------------------------
    const rules = await until("rules drafted", async () => (await get(created.rules_duty_id)).status === "done");
    check("the rules duty runs first, as on any board", !!rules, daemonOut.slice(-600));

    // --- one duty, three roles, one worktree ----------------------------------------------------
    const greeting = await call("/duty/enqueue", { project_id: boardId, title: "Add a greeting", brief: "A file that says hello." }, human);
    const done = await until("the greeting done", async () => (await get(greeting.duty_id)).status === "done" && (await get(greeting.duty_id)));
    check("a duty filed by a person is finished by the team", !!done, { status: (await get(greeting.duty_id)).status, daemon: daemonOut.slice(-800) });
    await until("the reviewer's record", () => teamEvents(greeting.duty_id).some((e) => e.event === "team-review" && e.verdict === "passed"), 10_000);
    const seen = teamEvents(greeting.duty_id).filter((e) => e.event !== "team" || e.handedTo || e.didItself);
    const [officer, build, built, review] = [seen[0], seen.find((e) => e.event === "team-build"), seen.find((e) => e.role === "Engineer" && e.handedTo), seen.find((e) => e.event === "team-review")];
    check("it went to the role that reads duties first, then a builder, then the reviewer", seen.map((e) => e.role).join(" > ") === "Duty Officer > Engineer > Engineer > QA", seen.map((e) => `${e.role}:${e.event}`));
    check("the Duty Officer routed it rather than doing it", officer && officer.handedTo === "engineer" && !officer.handoffError, officer);
    check(
      "each role was told who it is, in its prompt, its MCP instructions and the handoff tool itself",
      [officer, built, review].every((e) => e && e.hasCharter && e.mcpSaysRole && e.handoffSaysWho && e.hasMemory),
      [officer, built, review].map((e) => e && { role: e.role, hasCharter: e.hasCharter, mcpSaysRole: e.mcpSaysRole, handoffSaysWho: e.handoffSaysWho, hasMemory: e.hasMemory }),
    );
    check("and exactly who it can hand to", built && built.canHandTo.join() === "duty-officer,architect,senior-engineer,qa", built?.canHandTo);
    check("the builder is not offered landing or completing", built && !built.offered.complete && !built.offered.integrate && built.offered.handoff && built.offered.memory, built?.offered);
    check("and is refused both when it tries anyway, and told to hand on", build && build.refused.integrate && build.refused.complete, build?.refused);
    check("the reviewer is offered both", review && review.offered.complete && review.offered.integrate, review?.offered);
    check("no role is offered handing in a team", [officer, built, review].every((e) => e && !e.offered.rosterSubmit));
    check("the builder's note reached the reviewer as its brief", review && review.handedBy === "Engineer" && built.handedBy === "Duty Officer", { review: review?.handedBy, built: built?.handedBy });
    check("the reviewer worked in the worktree the builder left", review && build && review.cwd === build.cwd && review.built && /build for/.test(review.ahead), review);
    check("three roles, three conversations: none resumed another's", new Set([officer, built, review].map((e) => e && e.session)).size === 3 && [officer, built, review].every((e) => e && !e.resumed), [officer, built, review].map((e) => e && [e.session, e.resumed]));
    check(
      "each on the model its level picks from what the machine enabled",
      officer.agent === "claude" && officer.model === "backup-model" && built.agent === "codex" && built.model === "backup-model" && review.agent === "codex" && review.model === "quota-model",
      [officer, built, review].map((e) => `${e.role}: ${e.agent} ${e.model}`),
    );
    check("the reviewer landed it", review.verdict === "passed" && review.integrate?.ok && !review.completeError, review);
    check("the machine ran the tests before waking the reviewer, and told it so", review.checksPassed && !built.handoffError, { checksPassed: review.checksPassed, handoffError: built.handoffError });
    check("the Duty Officer's prompt is the slim one; the others are not", officer.slim && !built.slim && !review.slim, [officer, built, review].map((e) => [e.role, e.slim]));
    check("every prompt ends with where the session works", [officer, built, review].every((e) => e.endsWithWhere));
    check("and a normal-risk duty gets a normal review", !review.riskHigh);
    const timed = await get(greeting.duty_id);
    check("the machine reported how long its sessions ran", timed.usage && timed.usage.sessions >= 3 && timed.usage.ms > 0, timed.usage);
    const usageRow = await ds("duty_usage", "documents/get", { keys: [greeting.duty_id] }, human);
    const usageTheirs = await ds("duty_usage", "documents/get", { keys: [greeting.duty_id] }, stranger);
    check(
      "the console reads it directly, and nobody else can",
      usageRow.json.documents?.[0]?.data?.ms === timed.usage.ms && !(usageTheirs.json.documents || []).some((d) => d && d.data),
      { mine: usageRow, theirs: usageTheirs },
    );
    const handed = (await call("/duty/thread", { duty_id: greeting.duty_id }, human)).entries.find((t) => t.metadata?.handoff?.to === "qa");
    check("the handoff to review records the tests and the model, as the machine saw them", handed?.metadata.handoff.checks?.command === "test ! -e broken.txt" && handed.metadata.handoff.worked_with?.model === "backup-model", handed?.metadata);
    check("and only then was it on the main branch", onMain(`built-${greeting.duty_id}.txt`));
    const row = (await ds("duties", "documents/get", { keys: [greeting.duty_id] }, human)).json.documents?.[0]?.data || {};
    check("the duty remembers the roles it passed through", JSON.stringify(row.role_trail) === JSON.stringify(["duty-officer", "engineer", "qa"]) && row.handoffs === 2 && !row.bounces, { trail: row.role_trail, handoffs: row.handoffs, bounces: row.bounces });
    const thread = (await call("/duty/thread", { duty_id: greeting.duty_id }, human)).entries;
    const handoffs = thread.filter((t) => t.metadata && t.metadata.handoff).map((t) => `${t.metadata.handoff.from_name}>${t.metadata.handoff.to_name}`).sort();
    check("and the handoffs are on its record", handoffs.join() === "Duty Officer>Engineer,Engineer>QA", handoffs);
    check("its worktree is gone once it is done", done && !existsSync(build.cwd), build.cwd);

    const notes = (await call("/note/list", { project_id: boardId }, human)).notes;
    const left = notes.find((n) => n.id === build.noteId);
    check(
      "what the builder noticed on the way is a note, said to be from it, not a duty in the queue",
      !build.noteError && left && left.from?.duty_id === greeting.duty_id && left.from?.name === "Engineer" && left.kind === "note",
      { noteError: build.noteError, left },
    );
    const memory = await call("/board/memory", { project_id: boardId }, human);
    check("what the builder wrote down is the team's memory", memory.body.includes(`Engineer worked ${greeting.duty_id}`) && memory.version === 1, memory);

    // --- sent back once, then passed ------------------------------------------------------------
    const footer = await call("/duty/enqueue", { project_id: boardId, title: "[bounce] Fix the footer", brief: "It is wrong." }, human);
    const fixed = await until("the footer done", async () => (await get(footer.duty_id)).status === "done");
    check("work the reviewer sends back is fixed and lands", !!fixed, { status: (await get(footer.duty_id)).status, daemon: daemonOut.slice(-800) });
    await until("the reviewer's second record", () => teamEvents(footer.duty_id).some((e) => e.event === "team-review" && e.verdict === "passed"), 10_000);
    const footerSeen = teamEvents(footer.duty_id);
    const reviews = footerSeen.filter((e) => e.event === "team-review");
    const builds = footerSeen.filter((e) => e.event === "team-build");
    check("the reviewer sent it back, then passed it", reviews.map((e) => e.verdict).join() === "sent back,passed", reviews.map((e) => e.verdict));
    check("the builder was told it came back, and by whom", builds.length === 2 && !builds[0].sentBack && builds[1].sentBack && builds[1].handedBy === "QA", builds.map((e) => [e.sentBack, e.handedBy]));
    check("nothing was on the main branch while it was being sent back", reviews[0] && !reviews[0].integrate && onMain(`fix-${footer.duty_id}.txt`) && onMain(`built-${footer.duty_id}.txt`));
    check("the same worktree, start to finish", new Set(footerSeen.map((e) => e.cwd)).size === 1, footerSeen.map((e) => e.cwd));
    check("the builder picked up its own conversation when the work came back", builds[1].resumed && builds[1].session === builds[0].session, builds.map((e) => [e.session, e.resumed]));
    check("and the reviewer's second look is a conversation of its own", reviews.length === 2 && reviews[1].session !== builds[1].session, reviews.map((e) => [e.session, e.resumed]));
    check("the next session's prompt carried what the last one wrote down", builds[0].hasMemory && events(log).some((e) => e.event === "start" && e.dutyId === footer.duty_id && e.instructions.includes(`Engineer worked ${greeting.duty_id}`)));
    const footerRow = (await ds("duties", "documents/get", { keys: [footer.duty_id] }, human)).json.documents?.[0]?.data || {};
    check("the duty counts the send-back", footerRow.bounces === 1 && footerRow.handoffs === 4, { bounces: footerRow.bounces, handoffs: footerRow.handoffs });

    // --- work that fails the tests never reaches the reviewer -----------------------------------
    const red = await call("/duty/enqueue", { project_id: boardId, title: "[red] Add a flaky feature", brief: "It breaks the tests at first." }, human);
    const redDone = await until("the red duty done", async () => (await get(red.duty_id)).status === "done");
    await until("the red reviewer's record", () => teamEvents(red.duty_id).some((e) => e.event === "team-review"), 10_000);
    const redEvent = teamEvents(red.duty_id).find((e) => e.event === "team-red");
    check("uncommitted work is refused before review", redEvent && redEvent.dirtyRefused, redEvent);
    check("so is work the tests fail on, with their output", redEvent && redEvent.redRefused, redEvent?.redText);
    check("fixed in the same session, it is reviewed once and lands", !!redDone && teamEvents(red.duty_id).filter((e) => e.event === "team-review").length === 1 && !onMain("broken.txt"));

    // --- a change to a sensitive path is reviewed as high risk ----------------------------------
    const secure = await call("/duty/enqueue", { project_id: boardId, title: "[secure] Rotate the session key", brief: "Under secure/." }, human);
    const secureDone = await until("the secure duty done", async () => (await get(secure.duty_id)).status === "done");
    await until("the secure reviewer's record", () => teamEvents(secure.duty_id).some((e) => e.event === "team-review"), 10_000);
    const secureReview = teamEvents(secure.duty_id).find((e) => e.event === "team-review");
    const secureRow = await get(secure.duty_id);
    check("the machine saw the sensitive path, and the duty became high risk", !!secureDone && secureRow.risk === "high", secureRow.risk);
    check("its reviewer was told to review it line by line", secureReview && secureReview.riskHigh, secureReview);

    // --- a trivial duty is finished by the role that read it ------------------------------------
    const typo = await call("/duty/enqueue", { project_id: boardId, title: "[trivial] Fix a typo", brief: "'recieve' in the README." }, human);
    const typoDone = await until("the typo done", async () => (await get(typo.duty_id)).status === "done");
    await until("the Duty Officer's record", () => teamEvents(typo.duty_id).some((e) => e.didItself), 10_000);
    const typoSeen = teamEvents(typo.duty_id).filter((e) => e.didItself || e.handedTo);
    check("the Duty Officer finishes a trivial duty itself", !!typoDone && typoSeen.length === 1 && typoSeen[0].role === "Duty Officer" && typoSeen[0].didItself && !typoSeen[0].completeError && onMain(`trivial-${typo.duty_id}.txt`), typoSeen);

    // --- the team's record, as the console reads it ---------------------------------------------
    const agg = await ds("role_events", "aggregate", roleRecordRequest(), human);
    const record = roleRecord(agg.json.groups);
    const of = (id) => record.find((r) => r.role === id) || {};
    check("the console can read the team's record", agg.status === 200 && record.length >= 3, agg);
    check(
      "which says what each role did and how it held up",
      of("engineer").passed === 4 && of("engineer").first_pass === 3 && of("engineer").sent_back === 1 && of("qa").done === 4 && of("duty-officer").done === 1 && of("duty-officer").handoffs === 4,
      record.map(({ role, stints, handoffs, done, passed, first_pass, sent_back }) => ({ role, stints, handoffs, done, passed, first_pass, sent_back })),
    );
    check(
      "and ranks a role only on enough duties",
      topRoles(record).every((r) => r.ranked === r.judged >= 3) && of("engineer").ranked && !of("duty-officer").ranked && topRoles(record)[0].ranked,
      topRoles(record).map((r) => [r.role, r.judged, r.ranked]),
    );
    const theirs = await ds("role_events", "aggregate", roleRecordRequest(), stranger);
    check("someone else reads none of it", theirs.status === 200 && (theirs.json.groups || []).length === 0, theirs);

    // --- the office draws from the same rows ----------------------------------------------------
    const waiting = await call("/duty/enqueue", { project_id: boardId, title: "Something in flight", brief: "Watched from the office." }, human);
    const busy = await until("the duty in flight", async () => (await get(waiting.duty_id)).status === "active");
    const liveRows = ((await ds("duties", "query", { where: [{ field: "project_id", op: "=", value: boardId }, { field: "status", op: "in", value: ["queued", "active", "needs_decision", "blocked"] }], limit: 50 }, human)).json.documents || []).map((d) => ({ ...d.data, key: String(d.key) }));
    const doneRows = ((await ds("duties", "query", { where: [{ field: "project_id", op: "=", value: boardId }, { field: "status", op: "=", value: "done" }], limit: 10 }, human)).json.documents || []).map((d) => ({ ...d.data, key: String(d.key) }));
    const board = (await call("/board/open", { project_id: boardId }, human)).project;
    const rosters = (await call("/projects/rosters", { project_ids: [boardId] }, human)).rosters;
    const floor = buildingFloor({ boards: [{ project_id: boardId, name: board.name, roster: rosters[boardId] }], duties: liveRows });
    // It is at one desk or another for the few seconds three roles take: being worked, or in a tray.
    const atDesk = floor.rooms[0].desks.find((d) => d.working.some((w) => w.duty.key === waiting.duty_id) || d.tray.some((w) => w.key === waiting.duty_id));
    check("the office puts a duty in flight at the cubicle of the role that has it", !!busy && floor.rooms[0].teamed && floor.rooms[0].desks.length === 5 && !!atDesk, floor.rooms[0].desks.map((d) => [d.role.id, d.working.length, d.tray.length]));
    check("and names the latest handoffs", officeFeed(doneRows, {}).some((e) => e.duty_id === footer.duty_id), officeFeed(doneRows, {}));
    await until("the duty in flight finished", async () => (await get(waiting.duty_id)).status === "done", 60_000);

    // --- a team an agent drafts waits for its owner ---------------------------------------------
    const drafting = await call("/board/roster/draft", { project_id: boardId, note: "Keep it small." }, human);
    const drafted = await until("the team drafted", async () => (await get(drafting.duty_id)).status === "done");
    // The agent records what it saw after its last call returns, which can be just after the board says done.
    const rosterEvent = await until("the roster event", () => events(log).find((e) => e.event === "roster"), 10_000);
    check("a roster duty drafts a team and hands it in", !!drafted && rosterEvent && rosterEvent.offered && !rosterEvent.submitError && !rosterEvent.completeError && rosterEvent.sawTeam === 5, rosterEvent);
    const pending = await call("/board/roster", { project_id: boardId }, human);
    check("which changes nothing until its owner accepts", pending.roles.length === 5 && pending.draft && pending.draft.roles.length === 3 && pending.draft.note === "A desk, a doer and a lead.", { roles: pending.roles.length, draft: pending.draft });
    const accepted = await call("/board/roster/accept", { project_id: boardId }, human);
    check("and is the team once they do", accepted.in_force && accepted.roles.map((r) => r.id).join() === "desk,doer,lead", accepted);
  } finally {
    daemon.kill("SIGTERM");
    await sleep(1500);
    await call("/machines/revoke", { machine_id: paired.machine_id }, human).catch(() => {});
    await call("/projects/delete", { project_id: boardId, confirm: boardId }, human).catch(() => {});
    if (failures.length) console.log(`\n--- daemon ---\n${daemonOut.slice(-3000)}`);
  }

  console.log(failures.length ? `\n✖ ${passed} passed, ${failures.length} failed:\n  - ${failures.join("\n  - ")}` : `\n✔ ${passed} passed, 0 failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n✖ ${err.stack || err.message}`);
  process.exit(1);
});
