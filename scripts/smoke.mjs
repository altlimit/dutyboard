#!/usr/bin/env node
// End-to-end exercise of the state machine against a running deployment.
//
//   altengine dev && npm run setup      # in another terminal
//   npm run smoke
//
// This walks the whole spec: the queue's ordering, the single-active invariant, the
// non-blocking checkpoint, the interrupt that blocks a parent behind a child it spawned,
// the resolution that puts a parked duty back at the front with its answer attached, and
// the MCP surface. It asserts, so a regression fails here rather than in an agent's loop.
//
// It creates a throwaway project and deletes it at the end.
//
// It also creates THREE end-user accounts and does not delete them — nothing in this API
// can, and deleting a user is a control-plane action needing a key this script has no
// business holding. On a laptop they vanish with the emulator's data directory. Anywhere
// else they are real accounts that accumulate one set per run, so `npm run smoke` is a
// development tool and the warning below says so at the moment it would matter.
//
// It will usually refuse to run against a properly configured deployment anyway: sign-up
// should be off there (see README), and these accounts are made through the public
// sign-up route.

import { readFileSync } from "node:fs";
import { ROUTE_PATHS } from "../functions/src/index.js";

const PKG_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const FN = process.env.DUTYBOARD_FN_INSTANCE || "dutyboard";
const DS = process.env.DUTYBOARD_DATASTORE || "dutyboard";
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const FN_NAME = process.env.DUTYBOARD_FN_NAME || "board";
const API = process.env.DUTYBOARD_API || (BASE.includes("altengine.net") ? `https://${FN}-fn.altengine.app/${FN_NAME}` : `${BASE}/fn/${FN}/${FN_NAME}`);

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
if (!LOCAL) {
  console.log(`!  ${BASE} is not a local emulator.`);
  console.log(`   This run will leave three end-user accounts behind on '${AUTH}' that it cannot delete.\n`);
}

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

async function call(path, body, token, { expectStatus, board } = {}) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // How a machine key says which of its boards a call is about.
      ...(board ? { "x-dutyboard-board": board } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (expectStatus !== undefined) return { status: res.status, json };
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function authCall(path, body) {
  const res = await fetch(`${BASE}/v1/auth/${encodeURIComponent(AUTH)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`auth ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const titles = (poll) => poll.runnable_duties.map((d) => d.title);

/** One document, read the way the console reads it. */
async function dsGet(collection, key, token) {
  const res = await fetch(
    `${BASE}/v1/datastore/${encodeURIComponent(DS)}/ns/_default/col/${collection}/documents/get`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ keys: [key] }),
    },
  );
  const json = await res.json().catch(() => ({}));
  const doc = (json.documents || [])[0];
  return doc ? { ...doc.data, key: String(doc.key) } : {};
}

/** A datastore query, read the way the console reads it. A query that matches nothing may omit
 *  `documents` rather than sending an empty array, so it is defaulted here as the console does. */
async function dsQuery(collection, req, token) {
  const res = await fetch(`${BASE}/v1/datastore/${encodeURIComponent(DS)}/ns/_default/col/${collection}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, docs: json.documents || [] };
}

/**
 * What the console does before its first direct read: ask the function whether this token can
 * read what the person is allowed to, and refresh it if not. Returns the token to use.
 *
 * Reads are scoped by a rule with two branches — rows you own, or rows on a board in your
 * `boards` claim — and a rule naming a claim the account does not have refuses the WHOLE read.
 * A fresh account has no such claim until the function writes it.
 */
async function withAccess(tokens) {
  const res = await call("/me/access", {}, tokens.id_token);
  if (!res.refresh) return tokens.id_token;
  const t = await authCall("/token/refresh", { refresh_token: tokens.refresh_token });
  tokens.refresh_token = t.refresh_token;
  return (tokens.id_token = t.id_token);
}

/** Pair a machine the way a daemon does, approved by `humanToken`. */
async function pair(humanToken, name) {
  const started = await call("/connect/start", { name, os: "linux", arch: "amd64", cli_version: "smoke" });
  await call("/connect/approve", { user_code: started.user_code }, humanToken);
  return call("/connect/poll", { device_code: started.device_code });
}

/** One MCP call, as a daemon's local proxy makes it: the machine key, and the board named. */
async function machineTool(key, board, name, args) {
  const res = await fetch(`${API}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-dutyboard-board": board },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

/**
 * A daemon's socket: connect with a minted token, subscribe, and collect every delivery so a test
 * can wait for the one it expects. Resolves once the platform acknowledges the subscription —
 * before that, presence would not show the machine and a test would race it.
 */
function openSocket(minted) {
  const base = BASE.replace(/^http/, "ws");
  const from = minted.ws_url ? new URL(minted.ws_url, base) : null;
  const u = new URL(from ? from.pathname + from.search : `/v1/channel/dutyboard-live/subscribe`, base);
  if (!u.searchParams.has("token")) u.searchParams.set("token", minted.token);
  const frames = [];
  const ws = new WebSocket(u.toString());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not subscribe within 5s")), 5000);
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (frame.type === "subscribed") {
        clearTimeout(timer);
        resolve(socket);
      } else if (frame.channel) frames.push(frame);
    };
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", channels: minted.channels }));
    const socket = {
      async next(pred, ms = 3000) {
        const until = Date.now() + ms;
        for (;;) {
          const hit = frames.find(pred);
          if (hit || Date.now() > until) return hit || null;
          await new Promise((r) => setTimeout(r, 50));
        }
      },
      close: () => ws.close(),
    };
  });
}

/** Retry `probe` until it returns true or `ms` passes. For state that settles asynchronously —
 *  presence after a socket closes — where asserting on the first read would make a flaky test. */
async function eventually(probe, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  console.log(`DutyBoard smoke test → ${API}\n`);

  const health = await fetch(`${API}/health`).then((r) => r.json());
  check("health responds", health.ok === true, health);
  // A version that lies is worse than no version: it is the first thing anyone reads when
  // deciding whether a bug is already fixed. It was written out three times, twice as
  // copies nobody would think to update at release.
  check(`and reports the package version (${PKG_VERSION})`, health.version === PKG_VERSION, health);
  // If this is false the claim race below still passes on a quiet machine and fails in
  // production, which is the worst way to find out.
  check("the single-holder constraint is in place", health.single_holder === true, health);
  // The provisioner records where the console is; a machine being paired reads it here.
  check("it says where the console is", /^https?:\/\//.test(health.console_url || ""), health);

  // --- a person, a board, and a token for an agent ------------------------
  const email = `smoke_${Date.now()}@example.test`;
  const signup = await authCall("/signup", { email, name: "Smoke Tester", password: "correct-horse-battery-staple" });
  check("signed up a human", !!signup.id_token);

  // The hazard sharing introduced, pinned: a token issued before the account has a `boards`
  // claim cannot read even its own rows, because the rule's member branch names that claim and
  // a missing claim denies the whole rule. This is why the console syncs before reading.
  const bare = await dsQuery("projects", { where: [{ field: "owner_uid", op: "=", value: "x" }], limit: 1 }, signup.id_token);
  check("a token without the boards claim is refused a direct read", bare.status === 403, bare.status);
  const human = await withAccess(signup);
  const synced = await dsQuery("projects", { where: [{ field: "owner_uid", op: "=", value: "x" }], limit: 1 }, human);
  check("and the same account reads once the function has given it the claim", synced.status === 200, synced.json);

  const projectId = `smoke-${Date.now().toString(36)}`;
  const bystanderEmail = `bystander_${Date.now()}@example.test`;
  const other0 = await authCall("/signup", {
    email: bystanderEmail,
    name: "Bystander",
    password: "correct-horse-battery-staple",
  });

  const project = await call("/projects/create", { name: "Smoke Board", project_id: projectId }, human);
  check("created a board", project.project_id === projectId, project);

  // One call for what the console needs before it can draw anything.
  const opened = await call("/board/open", { project_id: projectId }, human);
  check("opening a board returns the board", opened.project && opened.project.name === "Smoke Board", opened.project);
  check("with its agents", Array.isArray(opened.agents), opened);
  check("and a channel token to subscribe with", !!(opened.live && opened.live.token), Object.keys(opened.live || {}));
  const strangerOpen = await call("/board/open", { project_id: projectId }, other0.id_token, { expectStatus: true });
  check("but not to someone who does not own it", strangerOpen.status === 403, strangerOpen);

  const minted = await call("/tokens/mint", { project_id: projectId, name: "smoke agent", default_agent_id: "alpha" }, human);
  const agent = minted.token;
  check("minted an agent token", typeof agent === "string" && agent.startsWith("db_"));
  check("the token is scoped to the board", minted.project_id === projectId, minted);

  // An agent token must never reach a board it was not minted for.
  const wrongBoard = await call("/duty/poll", { project_id: "some-other-board" }, agent, { expectStatus: true });
  check("agent token refuses another board", wrongBoard.status === 403, wrongBoard);

  // --- an empty board -----------------------------------------------------
  let poll = await call("/duty/poll", { agent_id: "alpha" }, agent);
  check("empty board polls clean", poll.active_duty === null && poll.runnable_duties.length === 0, poll);

  // --- the human fills the roadmap ---------------------------------------
  const later = await call(
    "/duty/enqueue",
    { project_id: projectId, title: "Write the docs", brief: "Document the deploy flow.", priority: "backlog" },
    human,
  );
  const soon = await call(
    "/duty/enqueue",
    { project_id: projectId, title: "Configure auth provider", brief: "Implement authentication for user endpoints.", priority: "next" },
    human,
  );
  check("enqueued two duties", !!later.duty_id && !!soon.duty_id);

  poll = await call("/duty/poll", { agent_id: "alpha" }, agent);
  check("queue is ordered by priority", titles(poll)[0] === "Configure auth provider", titles(poll));
  check("both duties are runnable", poll.runnable_duties.length === 2, titles(poll));
  check("origin is recorded as human", poll.runnable_duties[0].origin === "human", poll.runnable_duties[0]);

  // --- claim, and the single-active invariant ----------------------------
  const claim = await call("/duty/claim", { duty_id: soon.duty_id, agent_id: "alpha" }, agent);
  check("claimed the top duty", claim.status === "active", claim);
  check("claim returns the full brief", claim.duty.brief.endsWith("user endpoints."), claim.duty);

  const second = await call("/duty/claim", { duty_id: later.duty_id, agent_id: "alpha" }, agent, { expectStatus: true });
  check("a second claim is refused", second.status === 409, second);

  // Two agents reaching for the SAME duty at the same instant.
  //
  // On its OWN board, because a contended claim leaves agent rows and a held duty behind
  // and every count later in this file would quietly absorb them — which is how a suite
  // starts asserting whatever it happens to produce.
  //
  // This is the invariant the product rests on, and it did not hold. The original guard
  // was a compare-after-write: claim, then re-read and check you are the one named. Both
  // claimers wrote, then both read, and whoever read before the other wrote saw itself.
  // Two in ten claims were won twice. It is now a unique index on agents.active_duty_id,
  // so the datastore refuses the second write and the losing transaction never lands.
  const racePid = `smoke-race-${Date.now()}`;
  await call("/projects/create", { name: "Race", project_id: racePid }, human);
  const raceAgent = (await call("/tokens/mint", { project_id: racePid, name: "racers" }, human)).token;
  let soleWinner = 0;
  const ROUNDS = 5;
  for (let i = 0; i < ROUNDS; i++) {
    const target = await call("/duty/enqueue", { project_id: racePid, title: `contended ${i}`, brief: "two agents want this" }, human);
    const results = await Promise.all(
      ["one", "two", "three"].map((who) =>
        call("/duty/claim", { duty_id: target.duty_id, agent_id: `${who}-${i}` }, raceAgent, { expectStatus: true }),
      ),
    );
    const wins = results.filter((r) => r.status === 200);
    if (wins.length === 1) soleWinner++;
    else console.log(`      round ${i}: ${wins.length} winners — ${results.map((r) => r.status).join("/")}`);
    if (wins.length) {
      const row = await dsGet("duties", target.duty_id, human);
      if (row.assigned_agent_id !== wins[0].json.duty.assigned_agent_id) soleWinner = -1;
    }
  }
  check(`three agents race for one duty, ${ROUNDS} times, and exactly one wins each`, soleWinner === ROUNDS, soleWinner);

  // The mirror, which was far worse: ONE agent claiming TWO duties at the same instant.
  // The unique index on agents.active_duty_id does not catch it — two different duty ids
  // are two different values — so it needs its own constraint on duties.holder. Before
  // that, fourteen rounds in fifteen left one agent holding two duties.
  let heldTwo = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const [x, y] = await Promise.all([
      call("/duty/enqueue", { project_id: racePid, title: `X${i}`, brief: "one" }, human),
      call("/duty/enqueue", { project_id: racePid, title: `Y${i}`, brief: "two" }, human),
    ]);
    const both = await Promise.all([
      call("/duty/claim", { duty_id: x.duty_id, agent_id: "greedy" }, raceAgent, { expectStatus: true }),
      call("/duty/claim", { duty_id: y.duty_id, agent_id: "greedy" }, raceAgent, { expectStatus: true }),
    ]);
    if (both.filter((r) => r.status === 200).length > 1) heldTwo++;
    for (const d of [x, y]) await call("/duty/update", { duty_id: d.duty_id, status: "queued" }, human);
  }
  check("one agent cannot win two duties at once", heldTwo === 0, `${heldTwo}/${ROUNDS} rounds held two`);

  await call("/projects/delete", { project_id: racePid, confirm: racePid }, human);

  poll = await call("/duty/poll", { agent_id: "alpha" }, agent);
  check("poll reports the held duty", poll.active_duty && poll.active_duty.id === soon.duty_id, poll.active_duty);
  check("a held duty is not also runnable", !titles(poll).includes("Configure auth provider"), titles(poll));

  // --- being told a duty needs you ----------------------------------------
  const myChannel = await call("/live/me", {}, human);
  check("a person gets a channel of their own", myChannel.channels.length === 1 && /^user\./.test(myChannel.channels[0]), myChannel.channels);
  const agentMe = await call("/live/me", {}, agent, { expectStatus: true });
  check("and an agent token does not", agentMe.status === 403, agentMe);
  const mySocket = await openSocket(myChannel);
  const pushKeyA = await call("/push/key", {}, human, { expectStatus: true });
  if (pushKeyA.status === 501) {
    // The emulator implements only digest of Web Crypto. scripts/webpush-check.mjs proves the crypto;
    // a hosted deployment is where a push is actually made.
    check("without Web Crypto, push says it is unavailable rather than failing", /Web Crypto/.test(JSON.stringify(pushKeyA.json)), pushKeyA.json);
  } else {
    const pushKeyB = await call("/push/key", {}, human);
    check(
      "the deployment has one VAPID key, made on first use",
      pushKeyA.json.public_key === pushKeyB.public_key && Buffer.from(pushKeyB.public_key, "base64url").length === 65,
      pushKeyA,
    );
  }
  const device = {
    endpoint: `https://fcm.googleapis.com/fcm/send/smoke-${Date.now()}`,
    keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") },
  };
  const notAPushService = await call("/push/subscribe", { subscription: { ...device, endpoint: "https://evil.example/push" } }, human, { expectStatus: true });
  check("a subscription must point at a real push service", notAPushService.status === 400, notAPushService);
  check("a device can be subscribed", (await call("/push/subscribe", { subscription: device, label: "smoke" }, human)).ok === true);
  const strangerRemoves = await call("/push/unsubscribe", { endpoint: device.endpoint }, other0.id_token);
  check("nobody else can turn it off", strangerRemoves.removed === false, strangerRemoves);
  // Turned off again before the duty below parks: a push to a made-up endpoint would reach the internet.
  check("and its owner can", (await call("/push/unsubscribe", { endpoint: device.endpoint }, human)).removed === true);

  // --- the non-blocking checkpoint ---------------------------------------
  const parked = await call(
    "/duty/checkpoint",
    {
      duty_id: soon.duty_id,
      agent_id: "alpha",
      kind: "question",
      message: "Which provider should we use?",
      suggested_options: ["Custom JWT", "GitHub OAuth"],
      set_status: "needs_decision",
    },
    agent,
  );
  check("checkpoint parks the duty", parked.state === "needs_decision", parked);
  const told = await mySocket.next((f) => f.channel === myChannel.channels[0] && f.data && f.data.t === "needs_you" && f.data.duty_id === soon.duty_id);
  check(
    "the board's owner is told, on their own channel, with the question and where to answer it",
    told && /Which provider should we use\?/.test(told.data.body) && told.data.url === `#/b/${projectId}/d/${soon.duty_id}`,
    told,
  );
  mySocket.close();

  poll = await call("/duty/poll", { agent_id: "alpha" }, agent);
  check("parking frees the agent", poll.active_duty === null, poll.active_duty);
  check("the parked duty leaves the queue", !titles(poll).includes("Configure auth provider"), titles(poll));

  // --- an agent interrupts itself ----------------------------------------
  await call("/duty/claim", { duty_id: later.duty_id, agent_id: "alpha" }, agent);
  const blocker = await call(
    "/duty/enqueue",
    {
      title: "Add index to users.oauth_id",
      brief: "Discovered a slow lookup while writing the docs.",
      priority: "immediate_blocker",
      spawned_by: later.duty_id,
      agent_id: "alpha",
    },
    agent,
  );
  check("an immediate blocker blocks its parent", blocker.blocked_duty_id === later.duty_id, blocker);
  check("the new duty is queued", blocker.status === "queued", blocker);

  poll = await call("/duty/poll", { agent_id: "alpha" }, agent);
  check("the interrupt frees the agent", poll.active_duty === null, poll.active_duty);
  check("the blocker is now top of the queue", titles(poll)[0] === "Add index to users.oauth_id", titles(poll));
  check("agent-created work is marked as such", poll.runnable_duties[0].origin === "agent", poll.runnable_duties[0]);

  // --- finishing the child releases the parent ----------------------------
  await call("/duty/claim", { duty_id: blocker.duty_id, agent_id: "alpha" }, agent);
  const done = await call(
    "/duty/complete",
    { duty_id: blocker.duty_id, agent_id: "alpha", outcome_summary: "Added a composite index on (oauth_id, created)." },
    agent,
  );
  check("completing the child unblocks the parent", done.unblocked_duty_id === later.duty_id, done);

  const noSummary = await call("/duty/complete", { duty_id: later.duty_id, agent_id: "alpha" }, agent, { expectStatus: true });
  check("completing without a summary is refused", noSummary.status === 400, noSummary);

  // --- done was wrong -----------------------------------------------------
  //
  // `done` is an agent's claim, not a fact. The transition back exists because the
  // alternatives are worse: editing the status by hand says nothing about what went wrong
  // and leaves the duty in the finished index, and a new duty starts a second history for
  // the same job. What is asserted here is that the REASON survives — on the thread, on the
  // row, and in what the next agent to claim it is handed.
  const shipped = await call(
    "/duty/enqueue",
    { project_id: projectId, title: "Ship the CSV export", brief: "A button on the board that downloads every duty." },
    human,
  );
  await call("/duty/claim", { duty_id: shipped.duty_id, agent_id: "alpha" }, agent);
  await call(
    "/duty/complete",
    { duty_id: shipped.duty_id, agent_id: "alpha", outcome_summary: "Added GET /export.csv and a button on the board." },
    agent,
  );

  const agentReopen = await call("/duty/reopen", { duty_id: shipped.duty_id, note: "mine now" }, agent, { expectStatus: true });
  check("an agent cannot send a duty back", agentReopen.status === 403, agentReopen);

  const noNote = await call("/duty/reopen", { duty_id: shipped.duty_id }, human, { expectStatus: true });
  check("and a person cannot send one back without saying why", noNote.status === 400, noNote);

  const sentBack = await call(
    "/duty/reopen",
    { duty_id: shipped.duty_id, note: "The button 500s on a board with no duties." },
    human,
  );
  check("a finished duty can be sent back", sentBack.status === "queued", sentBack);
  check("it goes to the front of the queue", sentBack.priority === "immediate_blocker", sentBack);
  check("and it remembers which way it had finished", sentBack.reopened_from === "done", sentBack);

  const backRow = await dsGet("duties", shipped.duty_id, human);
  check("the outcome it claimed is no longer presented as one", backRow.outcome_summary === null, backRow.outcome_summary);
  check("but it is kept", /export\.csv/.test(backRow.previous_outcome || ""), backRow.previous_outcome);

  const backThread = await call("/duty/thread", { duty_id: shipped.duty_id }, human);
  const reopenEntry = (backThread.entries || []).find((e) => e.kind === "reopen");
  check("the reason is on the record", !!reopenEntry && /500s/.test(reopenEntry.message), reopenEntry);
  check("attributed to the person who sent it back", reopenEntry && reopenEntry.author_type === "human", reopenEntry);

  // The part that matters most: an agent that claims this must not read an outcome summary
  // saying the work is done and nothing saying otherwise.
  poll = await call("/duty/poll", { agent_id: "alpha" }, agent);
  const backInQueue = poll.runnable_duties.find((d) => d.id === shipped.duty_id);
  check("it is runnable again", !!backInQueue, titles(poll));
  check("and it carries why it came back", backInQueue && /500s/.test(backInQueue.reopened?.note || ""), backInQueue);
  check(
    "along with what the last attempt claimed",
    backInQueue && /export\.csv/.test(backInQueue.reopened?.previous_outcome || ""),
    backInQueue && backInQueue.reopened,
  );

  // Deleting a duty an agent holds frees the agent: before, the agent row kept naming the deleted
  // duty and every later claim by that agent was refused as a second active duty.
  const doomed = await call("/duty/enqueue", { project_id: projectId, title: "Deleted mid-work", brief: "gone soon" }, human);
  await call("/duty/claim", { duty_id: doomed.duty_id, agent_id: "alpha" }, agent);
  await call("/duty/delete", { duty_id: doomed.duty_id, confirm: doomed.duty_id }, human);
  const afterDelete = await call("/duty/enqueue", { project_id: projectId, title: "Next for the same agent", brief: "claimable" }, human);
  const freed = await call("/duty/claim", { duty_id: afterDelete.duty_id, agent_id: "alpha" }, agent, { expectStatus: true });
  check("deleting a held duty frees its agent to claim the next", freed.status === 200, freed.json);
  await call("/duty/update", { duty_id: afterDelete.duty_id, status: "queued" }, human);
  await call("/duty/delete", { duty_id: afterDelete.duty_id, confirm: afterDelete.duty_id }, human);

  const twice = await call("/duty/reopen", { duty_id: shipped.duty_id, note: "again" }, human, { expectStatus: true });
  check("a duty that is already queued cannot be sent back", twice.status === 409, twice);

  // Round two, because the count is the only way to see a duty that keeps coming back.
  await call("/duty/claim", { duty_id: shipped.duty_id, agent_id: "alpha" }, agent);
  await call("/duty/complete", { duty_id: shipped.duty_id, agent_id: "alpha", outcome_summary: "Fixed the empty case." }, agent);
  const again = await call("/duty/reopen", { duty_id: shipped.duty_id, note: "Still 500s, now on a board with one duty." }, human);
  check("sending it back a second time is counted", again.reopen_count === 2, again);

  // The write answers with what it wrote, so a caller never has to re-read the thread to
  // find out what it just said.
  const noted = await call("/duty/checkpoint", { duty_id: later.duty_id, agent_id: "alpha", kind: "note", message: "a note" }, agent);
  check("a checkpoint returns the entry it created", noted.entry && noted.entry.id && noted.entry.message === "a note", noted);
  check("attributed to its author", noted.entry.author_type === "agent" && noted.entry.author_id === "alpha", noted.entry);

  // --- files on a duty ----------------------------------------------------
  //
  // The whole point is that the bytes never touch the function: it signs a URL, the caller
  // PUTs to it, and a reader gets a short-lived URL back. So this test does the PUT.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const mint = await call(
    "/duty/attach",
    { duty_id: later.duty_id, agent_id: "alpha", name: "evidence.png", size: png.length, content_type: "image/png" },
    agent,
  );
  check("an agent can reserve an attachment", !!mint.upload_url && !!mint.attachment_id, mint);

  const tooBig = await call(
    "/duty/attach",
    { duty_id: later.duty_id, agent_id: "alpha", name: "huge.bin", size: 60 * 1024 * 1024 },
    agent,
    { expectStatus: true },
  );
  check("and is refused one that is too big, before uploading it", tooBig.status === 400, tooBig.status);

  const put = await fetch(mint.upload_url, { method: "PUT", headers: mint.required_headers, body: png });
  check("the bytes go straight to storage", put.status === 200 || put.status === 204, put.status);

  const files = await call("/duty/attachments", { duty_id: later.duty_id }, human);
  const file = (files.attachments || [])[0] || {};
  check("the owner sees the file", file.name === "evidence.png" && file.size === png.length, files);
  check("attributed to the agent that added it", file.author_type === "agent" && file.author_id === "alpha", file);
  check("with a URL that is not the public one", !!file.url && !file.pending, file);

  const fetched = await fetch(file.url);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  check("and the bytes come back byte for byte", fetched.status === 200 && bytes.equals(png), `${fetched.status} ${bytes.length}B`);

  const counted = await dsGet("duties", later.duty_id, human);
  check("the duty counts it, so a poll need not ask", counted.attachment_count === 1, counted.attachment_count);

  // An agent whose only transport is MCP cannot make a PUT — it holds a list of tools, not
  // an HTTP client — so telling it to attach a screenshot was telling it to do something it
  // could not do. `content_base64` stores the bytes in the call itself.
  //
  // The round trip is compared BYTE FOR BYTE against a payload with every value 0-255 in it,
  // because the first version of this looked perfect: right length, right count, and every
  // byte above 0x7F silently replaced with 253. `atob` was the culprit; a file of the right
  // size full of the wrong bytes is the worst shape a corruption can take.
  const ladder = Uint8Array.from({ length: 256 }, (_, i) => i);
  const asB64 = btoa(String.fromCharCode(...ladder));
  const inlined = await call(
    "/duty/attach",
    { duty_id: soon.duty_id, name: "ladder.bin", content_type: "application/octet-stream", content_base64: asB64 },
    human,
  );
  check("an inline attachment needs no second request", inlined.uploaded === true && inlined.size === 256, inlined);
  const inlineList = await call("/duty/attachments", { duty_id: soon.duty_id }, human);
  const stored = (inlineList.attachments || []).find((a) => a.name === "ladder.bin");
  const ladderBack = new Uint8Array(await (await fetch(stored.url)).arrayBuffer());
  check(
    "and every byte of it survives, including the ones above 0x7F",
    ladderBack.length === 256 && ladderBack.every((b, i) => b === i),
    { length: ladderBack.length, firstBad: [...ladderBack].findIndex((b, i) => b !== i) },
  );

  const tooBigInline = await call(
    "/duty/attach",
    { duty_id: soon.duty_id, name: "huge.bin", content_base64: "A".repeat(3_000_000) },
    human,
    { expectStatus: true },
  );
  check(
    "an oversized inline upload is refused, and named the other path",
    tooBigInline.status === 400 && /upload_url/.test(JSON.stringify(tooBigInline.json)),
    tooBigInline.json,
  );

  // Concurrent uploads all read the same count and all write the same +1, so the cached
  // number under-counts. The rows are the truth and a read reconciles to them — a paperclip
  // saying 1 next to three files is small, but it is the kind of small that never gets fixed
  // unless something asserts it.
  const beforeConcurrent = (await call("/duty/attachments", { duty_id: soon.duty_id }, human)).attachments.length;
  const three = await Promise.all(
    [1, 2, 3].map((n) =>
      call("/duty/attach", { duty_id: soon.duty_id, name: `c${n}.txt`, size: 5, content_type: "text/plain" }, human),
    ),
  );
  for (const m of three) await fetch(m.upload_url, { method: "PUT", headers: m.required_headers, body: "hello" });
  const drifted = await dsGet("duties", soon.duty_id, human);
  const reconciled = await call("/duty/attachments", { duty_id: soon.duty_id }, human);
  const expectedFiles = beforeConcurrent + 3;
  check(
    `three concurrent uploads all land (${beforeConcurrent} → ${expectedFiles})`,
    (reconciled.attachments || []).length === expectedFiles,
    reconciled.attachments && reconciled.attachments.length,
  );
  const healed = await dsGet("duties", soon.duty_id, human);
  check(
    `and reading the duty reconciles its count (${drifted.attachment_count} → ${healed.attachment_count})`,
    healed.attachment_count === expectedFiles,
    { before: drifted.attachment_count, after: healed.attachment_count },
  );

  const unattached = await call("/duty/attachment/delete", { attachment_id: mint.attachment_id }, human);
  check("removing it answers ok", unattached.ok === true, unattached);
  check("and the object is gone from storage", (await fetch(file.url)).status === 404, "still there");
  const afterRemoval = await dsGet("duties", later.duty_id, human);
  check("and the count comes back down", (afterRemoval.attachment_count || 0) === 0, afterRemoval.attachment_count);

  // --- the human answers --------------------------------------------------
  const resolved = await call(
    "/duty/resolve",
    { duty_id: soon.duty_id, resolution_text: "Go with GitHub OAuth." },
    human,
  );
  check("resolving re-queues the duty", resolved.status === "queued", resolved);

  poll = await call("/duty/poll", { agent_id: "alpha", limit: 5 }, agent);
  const resumed = poll.runnable_duties.find((d) => d.id === soon.duty_id);
  check("a resolved duty is runnable again", !!resumed, titles(poll));
  check("and is raised to immediate_blocker", resumed && resumed.priority === "immediate_blocker", resumed);
  // Both duties are immediate_blocker by now (the unblocked parent too), so the tie is
  // broken by age: within a priority the queue is FIFO, which is what makes it predictable.
  check("equal priorities are served oldest first", titles(poll)[0] === "Write the docs", titles(poll));
  check("the resolution rides along", resumed && resumed.unblocked_context.human_resolution === "Go with GitHub OAuth.", resumed);
  check("so does the question that prompted it", resumed && /Custom JWT/.test(resumed.unblocked_context.last_question), resumed && resumed.unblocked_context);

  // An agent may not answer its own question.
  const selfAnswer = await call(
    "/duty/checkpoint",
    { duty_id: soon.duty_id, agent_id: "alpha", kind: "resolution", message: "I'll decide myself." },
    agent,
    { expectStatus: true },
  );
  check("an agent cannot post a resolution", selfAnswer.status === 403, selfAnswer);

  // --- the decision log ---------------------------------------------------
  const thread = await call("/duty/thread", { duty_id: soon.duty_id }, agent);
  const kinds = thread.entries.map((e) => e.kind);
  check("the thread records the question", kinds.includes("question"), kinds);
  check("and the resolution", kinds.includes("resolution"), kinds);
  check("options were kept with the question", !!thread.entries.find((e) => e.metadata && e.metadata.suggested_options), thread.entries);

  // --- MCP ----------------------------------------------------------------
  const rpc = async (method, params, id = 1) => {
    const res = await fetch(`${API}/mcp?agent=alpha`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agent}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return res.status === 202 ? null : res.json();
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  check("MCP initializes", init.result.serverInfo.name === "dutyboard", init);
  const tools = await rpc("tools/list", {});
  check("MCP lists the duty tools", tools.result.tools.some((t) => t.name === "duty_poll"), tools.result.tools.map((t) => t.name));

  const mcpPoll = await rpc("tools/call", { name: "duty_poll", arguments: {} });
  check("MCP duty_poll works without repeating the agent id", !mcpPoll.result.isError, mcpPoll.result);
  check("MCP returns structured content", Array.isArray(mcpPoll.result.structuredContent.runnable_duties), mcpPoll.result);

  const mcpBad = await rpc("tools/call", { name: "duty_claim", arguments: { duty_id: "duty_nope" } });
  check("a failing tool answers isError, not a protocol error", mcpBad.result.isError === true, mcpBad);
  check("and says what went wrong", /NOT_FOUND/.test(mcpBad.result.content[0].text), mcpBad.result.content);

  // --- the console's own read path ---------------------------------------
  // The browser reads the datastore DIRECTLY with its identity token; row rules on the
  // auth instance AND `owner_uid = you` into every query. This is the half of the design
  // the function never exercises, and getting it wrong shows up as either an empty board
  // or, far worse, someone else's.
  // A query that matches nothing may omit `documents` rather than sending an empty array,
  // so every reader of a query result has to default it — the console does too.
  const mine = await dsQuery("duties", { where: [{ field: "project_id", op: "=", value: projectId }], limit: 50 }, human);
  check("the console can read its own duties", mine.status === 200 && mine.docs.length === 4, mine);

  // The board must show what the agent will take. These are two different queries against
  // two different orderings — the console reads the datastore directly, the scheduler runs
  // in the function — and for a while they disagreed: the column was newest-first while the
  // agent took highest-priority-oldest, under a hint that said "highest priority first".
  const nextForAgent = await call("/duty/poll", { agent_id: "alpha", limit: 1 }, agent);
  const queuedColumn = await dsQuery(
    "duties",
    {
      where: [
        { field: "project_id", op: "=", value: projectId },
        { field: "status", op: "=", value: "queued" },
      ],
      order: [
        { field: "prio_rank", dir: "asc" },
        { field: "created_at", dir: "asc" },
      ],
      limit: 1,
    },
    human,
  );
  const topOfColumn = (queuedColumn.docs[0] || {}).key;
  const agentsNext = (nextForAgent.runnable_duties[0] || {}).id;
  check(
    "the top of the Queued column is the duty an agent claims next",
    !!agentsNext && topOfColumn === agentsNext,
    { column: topOfColumn, agent: agentsNext },
  );

  const myThreads = await dsQuery(
    "threads",
    { where: [{ field: "duty_id", op: "=", value: soon.duty_id }], order: [{ field: "created_at", dir: "asc" }], limit: 50 },
    human,
  );
  check("and the thread on a duty", myThreads.status === 200 && myThreads.docs.length > 0, myThreads.status);

  const myAgents = await dsQuery("agents", { where: [{ field: "project_id", op: "=", value: projectId }], limit: 10 }, human);
  check("and which agents are on the board", myAgents.status === 200 && myAgents.docs.length === 1, myAgents);

  // Agent credentials must be invisible to a browser: `tokens` is not in the rules at all.
  const peek = await dsQuery("tokens", { limit: 10 }, human);
  check("but never the tokens collection", peek.status === 403, peek);

  const noWrite = await fetch(`${BASE}/v1/datastore/${encodeURIComponent(DS)}/ns/_default/col/duties/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${human}` },
    body: JSON.stringify({ documents: [{ key: soon.duty_id, data: { status: "done" } }] }),
  });
  check("and cannot write a duty behind the state machine", noWrite.status === 403, noWrite.status);

  // A second person must not see any of it.
  const other = await authCall("/signup", {
    email: `other_${Date.now()}@example.test`,
    name: "Someone Else",
    password: "correct-horse-battery-staple",
  });
  const theirs = await dsQuery("duties", { where: [{ field: "project_id", op: "=", value: projectId }], limit: 50 }, await withAccess(other));
  check("another person sees none of this board", theirs.status === 200 && theirs.docs.length === 0, theirs.json);

  const theirApi = await call("/duty/poll", { project_id: projectId }, other.id_token, { expectStatus: true });
  check("and cannot reach it through the function either", theirApi.status === 403, theirApi);

  // Naming a duty directly, with no project id to check against. `/duty/thread` used to
  // answer this: it loaded the duty and read its log without ever asking whose it was.
  const theirThread = await call("/duty/thread", { duty_id: soon.duty_id }, other.id_token, { expectStatus: true });
  check("nor read a duty's log by naming its id", theirThread.status === 404, theirThread);
  const theirCheckpoint = await call(
    "/duty/checkpoint",
    { duty_id: soon.duty_id, kind: "note", message: "should not land" },
    other.id_token,
    { expectStatus: true },
  );
  check("nor write to its thread", theirCheckpoint.status === 404, theirCheckpoint);

  // --- a board shared with someone -----------------------------------------
  //
  // A member does the work on a board; the owner keeps what can hurt it or reach outside it.
  // Membership lives in rows the function checks on every write, and is copied into a claim
  // the datastore rules check on every read — so both halves are exercised, and so is the moment
  // they disagree.
  const beforeAdd = await call("/board/members/add", { project_id: projectId, email: bystanderEmail }, other0.id_token, { expectStatus: true });
  check("a stranger cannot add themselves to a board", beforeAdd.status === 403, beforeAdd);

  const noAccount = await call("/board/members/add", { project_id: projectId, email: "nobody-here@example.test" }, human, { expectStatus: true });
  check("adding an email with no account says so", noAccount.status === 404 && /account/.test(JSON.stringify(noAccount.json)), noAccount);

  const added = await call("/board/members/add", { project_id: projectId, email: bystanderEmail.toUpperCase() }, human);
  check("the owner adds someone by email, whatever its case", added.ok === true && added.member.identifier === bystanderEmail, added);

  const roster = await call("/board/members/list", { project_id: projectId }, human);
  check("and they are on the member list", roster.members.some((m) => m.identifier === bystanderEmail) && roster.you === "owner", roster);

  const theirList = await call("/projects/list", {}, other0.id_token);
  check("the board shows up for them as shared", theirList.shared.some((b) => b.project_id === projectId), theirList.shared);
  check("and the list says their token is behind", theirList.refresh === true, theirList.refresh);

  const memberToken = await withAccess(other0);
  const memberRead = await dsQuery("duties", { where: [{ field: "project_id", op: "=", value: projectId }], limit: 50 }, memberToken);
  check("with a refreshed token they read the board's duties directly", memberRead.status === 200 && memberRead.docs.length === 4, memberRead.status);
  const memberColumn = await dsQuery(
    "duties",
    {
      where: [
        { field: "project_id", op: "=", value: projectId },
        { field: "status", op: "=", value: "queued" },
      ],
      order: [
        { field: "prio_rank", dir: "asc" },
        { field: "created_at", dir: "asc" },
      ],
      limit: 1,
    },
    memberToken,
  );
  check("including an ordered column, as the board reads it", memberColumn.status === 200 && (memberColumn.docs[0] || {}).key === topOfColumn, memberColumn.status);
  const memberThread = await dsQuery(
    "threads",
    { where: [{ field: "duty_id", op: "=", value: soon.duty_id }], order: [{ field: "created_at", dir: "asc" }], limit: 50 },
    memberToken,
  );
  check("and a duty's decision log", memberThread.status === 200 && memberThread.docs.length === myThreads.docs.length, memberThread.status);

  const memberOpen = await call("/board/open", { project_id: projectId }, memberToken);
  check("the board tells them they are a member", memberOpen.role === "member", memberOpen.role);

  const memberDuty = await call("/duty/enqueue", { project_id: projectId, title: "Filed by a member", brief: "Work from someone the owner added." }, memberToken);
  check("a member adds work to the board", !!memberDuty.duty_id, memberDuty);
  const memberDutyRow = await dsGet("duties", memberDuty.duty_id, human);
  check("and the owner sees it, because the row still names the board's owner", memberDutyRow.owner_uid && memberDutyRow.title === "Filed by a member", memberDutyRow);
  check(
    "the duty records which person filed it, not just that a person did",
    memberDutyRow.created_by === other0.user.uid && memberDutyRow.created_by_name === "Bystander",
    { created_by: memberDutyRow.created_by, created_by_name: memberDutyRow.created_by_name },
  );

  const memberNote = await call("/duty/checkpoint", { duty_id: soon.duty_id, kind: "note", message: "a member's note" }, memberToken);
  check("a member writes on a duty's thread, as themselves", memberNote.entry && memberNote.entry.author_id === other0.user.uid, memberNote.entry);

  const ownerOnly = [
    ["/duty/delete", { duty_id: memberDuty.duty_id, confirm: memberDuty.duty_id }],
    ["/tokens/mint", { project_id: projectId, name: "member's token" }],
    ["/tokens/list", { project_id: projectId }],
    ["/projects/rename", { project_id: projectId, name: "renamed by a member" }],
    ["/projects/delete", { project_id: projectId, confirm: projectId }],
    ["/board/members/add", { project_id: projectId, email }],
    ["/board/members/remove", { project_id: projectId, uid: signup.user.uid }],
    ["/board/members/agents", { project_id: projectId, uid: other0.user.uid, can_run_agents: true }],
    ["/projects/profile", { project_id: projectId, runner: { parallel: 5 } }],
    ["/board/rules/set", { project_id: projectId, body: "rules by a member" }],
    ["/board/rules/accept", { project_id: projectId }],
  ];
  const allowed = [];
  for (const [path, body] of ownerOnly) {
    const res = await call(path, body, memberToken, { expectStatus: true });
    if (res.status < 400) allowed.push(`${path} ${res.status}`);
  }
  check(`a member is refused everything that is the owner's (${ownerOnly.length} tried)${allowed.length ? `: ${allowed.join(", ")}` : ""}`, allowed.length === 0);

  await call("/duty/delete", { duty_id: memberDuty.duty_id, confirm: memberDuty.duty_id }, human);
  check("the owner can delete what a member filed", (await dsGet("duties", memberDuty.duty_id, human)).title === undefined);

  const unshared = await call("/board/members/remove", { project_id: projectId, uid: other0.user.uid }, human);
  check("the owner removes them", unshared.removed === true, unshared);
  const writeAfterRemoval = await call("/duty/enqueue", { project_id: projectId, title: "too late", brief: "no" }, memberToken, { expectStatus: true });
  check("and their next write is refused at once, whatever their token says", writeAfterRemoval.status === 403, writeAfterRemoval);
  const refreshedAfterRemoval = await withAccess(other0);
  const afterHeal = await dsQuery("duties", { where: [{ field: "project_id", op: "=", value: projectId }], limit: 50 }, refreshedAfterRemoval);
  check("and once their token is refreshed they read nothing", afterHeal.status === 200 && afterHeal.docs.length === 0, afterHeal.status);


  // --- a machine: pairing, links, and a board run by a daemon ---------------
  //
  // One `dutyboard` daemon holds one key for every board it works, and the link row for a board is
  // what lets that key act there. Everything a daemon relies on is walked here with a real key: the
  // pairing that makes one, the setup and rules duties a linked board starts with, the lanes that
  // bound parallel work, a parked duty kept for the machine holding its worktree — proven with a
  // real socket, because presence is what decides it — and the permission a member needs.
  check("health says machines can pair", health.machines === true, health);
  check("a board made the old way does not start with duties it never asked for", project.rules_duty_id === null, project);

  const started = await call("/connect/start", { name: "Smoke WSL", os: "linux", arch: "amd64", cli_version: "smoke" });
  check("a daemon starts pairing with no credential", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(started.user_code) && !!started.device_code, started);
  const waiting = await call("/connect/poll", { device_code: started.device_code });
  check("and hears 'pending' until someone approves it", waiting.status === "pending", waiting);
  const agentApproves = await call("/connect/approve", { user_code: started.user_code }, agent, { expectStatus: true });
  check("an agent token cannot approve a machine", agentApproves.status === 403, agentApproves);
  const looked = await call("/connect/lookup", { user_code: started.user_code.toLowerCase().replace("-", "") }, human);
  check("a person looks the code up however they typed it", looked.machine_name === "Smoke WSL" && looked.status === "pending", looked);
  await call("/connect/approve", { user_code: started.user_code }, human);
  const paired = await call("/connect/poll", { device_code: started.device_code });
  check("once approved, the next poll hands over a machine key", paired.status === "approved" && /^dbm_/.test(paired.machine_key || ""), { ...paired, machine_key: !!paired.machine_key });
  const handedTwice = await call("/connect/poll", { device_code: started.device_code }, null, { expectStatus: true });
  check("exactly once", handedTwice.status === 404, handedTwice);
  const mkey = paired.machine_key;
  const prefix = paired.agent_prefix;

  const refused = await call("/connect/start", { name: "Not this one" });
  await call("/connect/deny", { user_code: refused.user_code }, human);
  const heardNo = await call("/connect/poll", { device_code: refused.device_code });
  check("a denied pairing tells the daemon no, and hands over nothing", heardNo.status === "denied" && !heardNo.machine_key, heardNo);

  const mBoard = `smoke-machines-${Date.now().toString(36)}`;
  const mCreated = await call(
    "/projects/create",
    {
      name: "Machines",
      project_id: mBoard,
      profile: { type: "game", repo_url: "https://github.com/example/cadence.git", default_branch: "main", stack: ["godot"] },
      runner: { parallel: 1 },
    },
    human,
  );
  check("a board made with a profile starts with its rules to write", !!mCreated.rules_duty_id, mCreated);
  const escape = await call("/projects/profile", { project_id: mBoard, profile: { worktree: { copy: ["../../.ssh/id_ed25519"] } } }, human, { expectStatus: true });
  await call("/projects/profile", { project_id: mBoard, profile: { git: { author_name: "Cadence Bot", author_email: "bot@example.com" } } }, human);
  await call("/projects/profile", { project_id: mBoard, profile: { git: { mode: "squash" } } }, human);
  check("a board can land its work as squashed commits", (await call("/board/profile", { project_id: mBoard }, human)).profile.git.mode === "squash");
  await call("/projects/profile", { project_id: mBoard, profile: { git: { mode: "push" } } }, human);
  const gitKept = (await call("/board/profile", { project_id: mBoard }, human)).profile.git;
  check("saving the git mode keeps the commit author already set", gitKept.author_email === "bot@example.com" && gitKept.mode === "push", gitKept);

  // MCP servers: a command or a URL, secrets named but never valued.
  const serverRefused = async (server) =>
    (await call("/projects/profile", { project_id: mBoard, profile: { mcp_servers: [server] } }, human, { expectStatus: true })).status;
  check(
    "an MCP server needs a command or a URL, and not both",
    (await serverRefused({ name: "x" })) === 400 && (await serverRefused({ name: "x", command: "npx", url: "https://a.example/mcp" })) === 400,
  );
  check("an MCP server cannot take the runner's own name", (await serverRefused({ name: "dutyboard", command: "npx" })) === 400);
  check(
    "a credential pasted into an MCP server's settings is refused",
    (await serverRefused({ name: "gh", command: "npx", env: { GITHUB_TOKEN: "ghp_abc" } })) === 400 && (await serverRefused({ name: "gh", command: "npx", env: { OWNER: "ghp_abc" } })) === 400,
  );
  check("an MCP URL must be https", (await serverRefused({ name: "docs", url: "http://docs.example/mcp" })) === 400);
  await call(
    "/projects/profile",
    { project_id: mBoard, profile: { mcp_servers: [{ name: "playwright", command: "npx", args: ["@playwright/mcp"], secrets: ["BROWSER_TOKEN"], tools: ["browser_take_screenshot"], note: "screenshots" }] } },
    human,
  );
  const mcpSaved = (await call("/board/profile", { project_id: mBoard }, human)).profile.mcp_servers;
  check(
    "a valid MCP server is kept, with its secrets named and no values",
    mcpSaved?.length === 1 && mcpSaved[0].name === "playwright" && mcpSaved[0].secrets[0] === "BROWSER_TOKEN" && !("url" in mcpSaved[0]),
    mcpSaved,
  );
  await call("/projects/profile", { project_id: mBoard, profile: { mcp_servers: [] } }, human);
  const badEmail = await call("/projects/profile", { project_id: mBoard, profile: { git: { author_email: "not an email" } } }, human, { expectStatus: true });
  check("and a commit author email has to be one", badEmail.status === 400, badEmail.json);
  check("a profile path that leaves the project is refused", escape.status === 400, escape.json);

  const unnamed = await call("/duty/poll", {}, mkey, { expectStatus: true });
  check("a machine key has to name the board it means", unnamed.status === 403 && /x-dutyboard-board/.test(JSON.stringify(unnamed.json)), unnamed.json);
  const notLinked = await call("/duty/poll", {}, mkey, { expectStatus: true, board: mBoard });
  check("and cannot act on a board it is not linked to", notLinked.status === 403, notLinked.json);

  const bystanderToken = await withAccess(other0);
  const theirBoard = `smoke-theirs-${Date.now().toString(36)}`;
  await call("/projects/create", { name: "Theirs", project_id: theirBoard }, bystanderToken);
  const strangersBoard = await call("/machine/link", { project_id: theirBoard }, mkey, { expectStatus: true });
  check("a machine cannot link a board its owner is not on", strangersBoard.status === 404, strangersBoard.json);

  // A board from before runners, linked: it gains runner settings, one duty at a time.
  const legacyBoard = `smoke-legacy-${Date.now().toString(36)}`;
  await call("/projects/create", { name: "Legacy", project_id: legacyBoard }, human);
  const noRepo = await call("/machine/link", { project_id: legacyBoard, setup: false }, mkey, { expectStatus: true });
  check("a machine cannot work a board that names no repository", noRepo.status === 400 && /repository/.test(JSON.stringify(noRepo.json)), noRepo.json);
  await call("/projects/profile", { project_id: legacyBoard, profile: { repo_url: "https://github.com/example/legacy.git" } }, human);
  await call("/machine/link", { project_id: legacyBoard, setup: false }, mkey);
  const legacyProfile = await call("/board/profile", { project_id: legacyBoard }, human);
  check("linking a board made before runners gives it one duty at a time", legacyProfile.runner && legacyProfile.runner.parallel === 1, legacyProfile.runner);
  await call("/projects/delete", { project_id: legacyBoard, confirm: legacyBoard }, human);

  const linked = await call("/machine/link", { project_id: mBoard, path_hint: "~/dutyboard/machines" }, mkey);
  check("linking a board gives the machine a setup duty of its own", linked.created && !!linked.setup_duty_id, linked);
  check("and no second rules duty, since the board has one already", linked.rules_duty_id === null, linked);
  const relinked = await call("/machine/link", { project_id: mBoard }, mkey);
  check("linking again changes nothing", relinked.created === false && relinked.setup_duty_id === null, relinked);

  const me = await call("/machine/me", {}, mkey);
  check("the machine reads its board and the profile with it", me.links.length === 1 && me.links[0].profile.type === "game", me.links);
  const linkable = await call("/machine/boards", {}, mkey);
  check(
    "it can list the boards it may link, and says which it already works",
    linkable.boards.some((b) => b.project_id === mBoard && b.linked) && linkable.boards.some((b) => b.project_id === projectId && !b.linked),
    linkable.boards.map((b) => [b.project_id, b.linked]),
  );
  const madeHere = `smoke-from-terminal-${Date.now().toString(36)}`;
  const terminalBoard = await call("/machine/boards/create", { name: "From the terminal", project_id: madeHere, profile: { type: "cli-lib" } }, mkey);
  check("and make one for its owner from the terminal", terminalBoard.project_id === madeHere && !!terminalBoard.rules_duty_id, terminalBoard);
  const ownersList = await call("/projects/list", {}, human);
  check("which is the owner's board like any other", ownersList.projects.some((p) => p.project_id === madeHere), ownersList.projects.length);
  await call("/projects/delete", { project_id: madeHere, confirm: madeHere }, human);

  // A board with urgent work already waiting: the machine still sets itself up, then writes the rules.
  const busyBoard = `smoke-busy-${Date.now().toString(36)}`;
  await call("/projects/create", { name: "Busy", project_id: busyBoard, profile: { type: "webapp", repo_url: "https://github.com/example/busy.git" } }, human);
  await call("/duty/enqueue", { project_id: busyBoard, title: "Fix the outage", brief: "urgent", priority: "immediate_blocker" }, human);
  const busyLink = await call("/machine/link", { project_id: busyBoard }, mkey);
  const busyPoll = await call("/duty/poll", { agent_id: `${prefix}/1`, limit: 5 }, mkey, { board: busyBoard });
  check(
    "setup and then rules come before urgent work queued earlier",
    busyPoll.runnable_duties.map((d) => d.kind).join(",").startsWith("setup,rules,") && busyPoll.runnable_duties[0].id === busyLink.setup_duty_id,
    busyPoll.runnable_duties.map((d) => [d.kind, d.priority, d.title]),
  );
  await call("/projects/delete", { project_id: busyBoard, confirm: busyBoard }, human);

  const lane1 = `${prefix}/1`;
  const lane2 = `${prefix}/2`;
  const signsAsAlpha = await call("/duty/poll", { agent_id: "alpha" }, mkey, { expectStatus: true, board: mBoard });
  check("a machine cannot sign as someone else's agent", signsAsAlpha.status === 403, signsAsAlpha.json);

  const machinePoll = await call("/duty/poll", { agent_id: lane1 }, mkey, { board: mBoard });
  check(
    "its setup duty is first in its queue",
    machinePoll.runnable_duties[0] && machinePoll.runnable_duties[0].id === linked.setup_duty_id && machinePoll.runnable_duties[0].kind === "setup",
    machinePoll.runnable_duties,
  );
  const rawAgent = (await call("/tokens/mint", { project_id: mBoard, name: "raw agent", default_agent_id: "raw" }, human)).token;
  const rawPoll = await call("/duty/poll", { limit: 10 }, rawAgent);
  check("an agent that is not that machine is not offered it", !rawPoll.runnable_duties.some((d) => d.id === linked.setup_duty_id), rawPoll.runnable_duties);
  const rawSetup = await call("/duty/claim", { duty_id: linked.setup_duty_id }, rawAgent, { expectStatus: true });
  check("and cannot claim it", rawSetup.status === 409 && /reserved/.test(JSON.stringify(rawSetup.json)), rawSetup.json);

  const setupClaim = await call("/duty/claim", { duty_id: linked.setup_duty_id, agent_id: lane1 }, mkey, { board: mBoard });
  check("the machine claims its setup duty", setupClaim.status === "active" && setupClaim.duty.kind === "setup", setupClaim);
  const pauseMenu = await call("/duty/enqueue", { project_id: mBoard, title: "Add a pause menu", brief: "Esc opens it." }, human);
  const duringSetup = await call("/duty/claim", { duty_id: pauseMenu.duty_id }, rawAgent, { expectStatus: true });
  check("nothing else is claimed while setup has the board to itself", duringSetup.status === 409 && /to itself/.test(JSON.stringify(duringSetup.json)), duringSetup.json);

  const rawProposes = await call("/board/profile/propose", { duty_id: linked.setup_duty_id, test_command: "rm -rf /" }, rawAgent, { expectStatus: true });
  check("only the agent holding the setup duty records what setup found", rawProposes.status === 403, rawProposes.json);
  const proposed = await call(
    "/board/profile/propose",
    {
      duty_id: linked.setup_duty_id,
      agent_id: lane1,
      toolchain: [{ name: "godot", version: "4.7.1", why: "engine" }],
      test_command: "tools/run_tests.sh",
      worktree: { prep: "godot --headless --import", prep_inputs: ["project.godot"], cache: [".godot"], copy: [".env"] },
      deploy: { method: "ci-dispatch", workflow: "deploy.yml" },
    },
    mkey,
    { board: mBoard },
  );
  check(
    "setup writes what it found onto the board, and leaves the rest alone",
    proposed.profile.toolchain[0].name === "godot" && proposed.profile.deploy.method === "ci-dispatch" && proposed.profile.type === "game",
    proposed.profile,
  );
  await call("/duty/complete", { duty_id: linked.setup_duty_id, agent_id: lane1, outcome_summary: "Godot 4.7.1 installed and registered." }, mkey, { board: mBoard });
  const afterSetup = await call("/duty/get", { duty_id: linked.setup_duty_id }, mkey, { board: mBoard });
  check("a daemon reads back how its session left the duty", afterSetup.duty.status === "done" && /Godot/.test(afterSetup.duty.outcome_summary), afterSetup.duty);

  const rulesClaim = await call("/duty/claim", { duty_id: mCreated.rules_duty_id, agent_id: lane1 }, mkey, { board: mBoard });
  check("the rules duty is claimed next, before any rules exist", rulesClaim.duty.kind === "rules" && rulesClaim.rules_version === 0, rulesClaim);
  const profileTool = await machineTool(mkey, mBoard, "board_profile", {});
  check("a session reads the profile over MCP", !profileTool.isError && profileTool.structuredContent.profile.test_command === "tools/run_tests.sh", profileTool);
  const handedIn = await machineTool(mkey, mBoard, "board_rules_submit", {
    duty_id: mCreated.rules_duty_id,
    agent_id: lane1,
    body: "# Rules\n\n- Never commit secrets.\n- Run tools/run_tests.sh before completing.",
  });
  check("and hands in rules over MCP", !handedIn.isError, handedIn);
  await call("/duty/complete", { duty_id: mCreated.rules_duty_id, agent_id: lane1, outcome_summary: "Drafted the rules." }, mkey, { board: mBoard });
  const draftOnly = await call("/board/rules", {}, rawAgent);
  check("an agent is told a draft is waiting, not what it says", draftOnly.version === 0 && draftOnly.has_draft === true && draftOnly.draft === undefined, draftOnly);
  const accepted = await call("/board/rules/accept", { project_id: mBoard }, human);
  check("a person puts the draft in force", accepted.version === 1, accepted);
  const inForce = await call("/board/rules", {}, rawAgent);
  check("and every agent on the board reads it", inForce.version === 1 && /Never commit secrets/.test(inForce.body) && inForce.has_draft === false, inForce);

  // Lanes. One at a time first, then two, with two claims racing for the last free lane.
  const saveFix = await call("/duty/enqueue", { project_id: mBoard, title: "Fix the save file", brief: "Saves vanish on reload." }, human);
  const first = await call("/duty/claim", { duty_id: pauseMenu.duty_id, agent_id: lane1 }, mkey, { board: mBoard });
  check("a claim names the rules version in force", first.rules_version === 1, first.rules_version);
  const overLimit = await call("/duty/claim", { duty_id: saveFix.duty_id, agent_id: lane2 }, mkey, { expectStatus: true, board: mBoard });
  check("a board that runs one duty at a time refuses a second", overLimit.status === 409 && overLimit.json.error.details.parallel === 1, overLimit.json);
  await call("/projects/profile", { project_id: mBoard, runner: { parallel: 2 } }, human);
  const tutorial = await call("/duty/enqueue", { project_id: mBoard, title: "Write the tutorial", brief: "Three screens." }, human);
  const race = await Promise.all([
    call("/duty/claim", { duty_id: saveFix.duty_id, agent_id: lane2 }, mkey, { expectStatus: true, board: mBoard }),
    call("/duty/claim", { duty_id: tutorial.duty_id }, rawAgent, { expectStatus: true }),
  ]);
  check(
    "with one lane left, two claims race for it and exactly one lands",
    race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 1,
    race.map((r) => r.status),
  );
  const winner = race[0].status === 200 ? { duty: saveFix.duty_id, agent: lane2, key: mkey, board: mBoard } : { duty: tutorial.duty_id, agent: "raw", key: rawAgent };
  await call("/duty/complete", { duty_id: winner.duty, agent_id: winner.agent, outcome_summary: "Done in the race." }, winner.key, { board: winner.board });

  // A parked duty stays with the machine whose worktree has the half-finished work — while that
  // machine is there to resume it.
  await call(
    "/duty/checkpoint",
    { duty_id: pauseMenu.duty_id, agent_id: lane1, kind: "question", message: "Esc or P?", suggested_options: ["Esc", "P"], set_status: "needs_decision", affinity: true },
    mkey,
    { board: mBoard },
  );
  await call("/duty/resolve", { duty_id: pauseMenu.duty_id, resolution_text: "Esc." }, human);
  const offeredToRaw = async () => (await call("/duty/poll", { limit: 10 }, rawAgent)).runnable_duties.some((d) => d.id === pauseMenu.duty_id);
  check("while the machine holding its worktree is offline, anyone may take the answered duty", await offeredToRaw());

  const liveMint = await call("/machine/live", {}, mkey);
  check(
    "the machine's channel token covers its own channel and its board's",
    liveMint.channels.includes(`machine.${paired.machine_id}`) && liveMint.channels.includes(`board.${mBoard}`),
    liveMint.channels,
  );
  const socket = await openSocket(liveMint);
  check("while it is online, nobody else is offered it", await eventually(async () => !(await offeredToRaw())));
  const rawResume = await call("/duty/claim", { duty_id: pauseMenu.duty_id }, rawAgent, { expectStatus: true });
  check("or can claim it", rawResume.status === 409 && /parked on machine/.test(JSON.stringify(rawResume.json)), rawResume.json);
  const daemonView = await call("/machine/poll", {}, mkey);
  const boardView = daemonView.boards.find((b) => b.project_id === mBoard) || { runnable: [] };
  check("and the machine sees it as its own to resume", boardView.runnable.some((d) => d.duty_id === pauseMenu.duty_id && d.resumes), boardView);
  check("and how many machines work the board", boardView.machines === 1, boardView.machines);

  const retried = await call("/machines/retry", { machine_id: paired.machine_id, project_id: mBoard }, human);
  const heardRetry = await socket.next((f) => f.channel === `machine.${paired.machine_id}` && f.data && f.data.t === "retry");
  check("its owner can have it check again now, and it hears so on its own channel", retried.ok && heardRetry && heardRetry.data.project_id === mBoard, heardRetry);
  const strangerRetry = await call("/machines/retry", { machine_id: paired.machine_id }, other.id_token, { expectStatus: true });
  check("nobody else can", strangerRetry.status === 404, strangerRetry);

  const setupRequest = await call("/machine/request", { machine_id: paired.machine_id, project_id: mBoard, path: "machines" }, human);
  const heardSetup = await socket.next((f) => f.data && f.data.t === "setup");
  check("a setup asked for in the console reaches the daemon on its own channel", heardSetup && heardSetup.data.request_id === setupRequest.request.request_id, heardSetup);
  const outsidePath = await call("/machine/request", { machine_id: paired.machine_id, project_id: mBoard, path: "../elsewhere" }, human, { expectStatus: true });
  check("but never for a folder outside the machine's projects folder", outsidePath.status === 400, outsidePath.json);
  const reportedDone = await call("/machine/request/report", { request_id: setupRequest.request.request_id, status: "done", result: "cloned" }, mkey);
  check("the daemon reports the setup done", reportedDone.request.status === "done", reportedDone);
  await call("/machine/state", { project_id: mBoard, runs: [{ duty_id: pauseMenu.duty_id, state: "parked", detail: "waiting on Esc" }] }, mkey);
  const ownerView = (await call("/machines/list", {}, human)).machines.find((m) => m.machine_id === paired.machine_id) || {};
  check(
    "the owner sees the machine online, the board it works, and what it is doing there",
    ownerView.online === true && ownerView.links.length === 1 && ownerView.links[0].runs[0].state === "parked",
    ownerView,
  );
  const onBoard = await call("/board/runners", { project_id: mBoard }, human);
  check(
    "the board shows who is working it, online, and on what",
    onBoard.runners.length === 1 && onBoard.runners[0].online === true && onBoard.runners[0].runs[0].duty_id === pauseMenu.duty_id,
    onBoard.runners,
  );
  const openedWithRunners = await call("/board/open", { project_id: mBoard }, human);
  check("and opening the board brings the same, for its header", (openedWithRunners.runners || []).length === 1, openedWithRunners.runners);
  await call("/machines/update", { machine_id: paired.machine_id, paused: true }, human);
  check("pausing it from the console tells the daemon at once", !!(await socket.next((f) => f.data && f.data.t === "pause")));
  socket.close();
  check("and once the machine goes away, the duty is open to others again", await eventually(offeredToRaw));

  // A member's machine, which needs the owner's say-so.
  await call("/board/members/add", { project_id: mBoard, email: bystanderEmail }, human);
  const theirMachine = await pair(bystanderToken, "Bystander laptop");
  const noSaySo = await call("/machine/link", { project_id: mBoard }, theirMachine.machine_key, { expectStatus: true });
  check("a member's machine cannot join a board until the owner allows it", noSaySo.status === 403, noSaySo.json);
  await call("/board/members/agents", { project_id: mBoard, uid: other0.user.uid, can_run_agents: true }, human);
  const theirLink = await call("/machine/link", { project_id: mBoard, setup: false }, theirMachine.machine_key);
  check("once allowed, it links", theirLink.created === true, theirLink);
  await call("/board/members/agents", { project_id: mBoard, uid: other0.user.uid, can_run_agents: false }, human);
  const cutOff = await call("/duty/poll", {}, theirMachine.machine_key, { expectStatus: true, board: mBoard });
  check("taking the permission away cuts that machine off on its very next call", cutOff.status === 403, cutOff.json);
  await call("/machines/revoke", { machine_id: theirMachine.machine_id }, bystanderToken);
  await call("/projects/delete", { project_id: theirBoard, confirm: theirBoard }, bystanderToken);

  const mRemoved = await call("/projects/delete", { project_id: mBoard, confirm: mBoard }, human);
  check("deleting a board unlinks every machine on it", mRemoved.removed.machine_links === 1, mRemoved.removed);
  const afterBoardGone = await call("/duty/poll", {}, mkey, { expectStatus: true, board: mBoard });
  check("and the machine can no longer act there", afterBoardGone.status === 403, afterBoardGone.json);

  // --- what is actually deployed ------------------------------------------
  //
  // A version that lies is worse than no version: it is the first thing anyone reads when
  // deciding whether a bug is already fixed. It used to be written out three times, twice
  // as copies nobody would think to update at release, so this asserts the deployment
  // agrees with package.json on both surfaces that report it.
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  check("MCP serverInfo agrees with it", initialized.result.serverInfo.version === PKG_VERSION, initialized.result.serverInfo);
  check(
    "and the handshake carries the operating protocol",
    /duty_poll/.test(initialized.result.instructions || "") && /duty_checkpoint/.test(initialized.result.instructions || ""),
    (initialized.result.instructions || "").slice(0, 120),
  );

  // A body no endpoint here has a legitimate use for. Every field is capped individually,
  // but request.text() buffers whatever arrives before any of those caps can look at it —
  // and file bytes deliberately never come through this function, so there is no large body
  // to allow for.
  const huge = await fetch(`${API}/duty/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${human}` },
    body: JSON.stringify({ project_id: projectId, title: "x".repeat(400000), brief: "y" }),
  });
  check("an oversized body is refused before it is parsed", huge.status === 413, huge.status);

  // --- finished work is findable -------------------------------------------
  //
  // The point of outcome_summary is that it outlives the session that wrote it, and until
  // now nothing could reach it: duty_poll returns only runnable work and duty_thread needs
  // an id you do not have. Indexing is not synchronous, so this waits rather than asserting
  // on the first try — a flaky test here would be worse than none.
  if (health.search) {
    let found = null;
    for (let i = 0; i < 20 && !found; i++) {
      const res = await call("/duty/search", { project_id: projectId, query: "composite index" }, agent);
      found = (res.hits || [])[0] || null;
      if (!found) await new Promise((r) => setTimeout(r, 250));
    }
    check("a finished duty can be found by words from its outcome", !!found, found);
    check(
      "and the hit carries the summary, not just an id",
      found && /composite index/.test(found.outcome_summary || "") && !!found.title,
      found,
    );

    const openOne = await call("/duty/search", { project_id: projectId, query: "docs" }, agent);
    check(
      "an unfinished duty is not in the index",
      !(openOne.hits || []).some((h) => h.status !== "done" && h.status !== "failed"),
      openOne.hits,
    );

    // A duty that was sent back is not finished work any more. Leaving it indexed is how an
    // agent searching for "have we done this" finds a duty sitting in the queue, reads an
    // outcome summary for work that did not hold, and concludes it is done.
    let stillIndexed = true;
    for (let i = 0; i < 20 && stillIndexed; i++) {
      const res = await call("/duty/search", { project_id: projectId, query: "export" }, agent);
      stillIndexed = (res.hits || []).some((h) => h.duty_id === shipped.duty_id);
      if (stillIndexed) await new Promise((r) => setTimeout(r, 250));
    }
    check("a duty sent back leaves the finished index", !stillIndexed);

    // The board is pinned by a FACET, outside the query string, so nothing the caller writes
    // can widen it. A query string prefix would have made this a way to read another board.
    // Work finished before search existed. Every board that predates the feature has an
    // empty index once, and a search that answers "nothing" for the whole history you
    // turned it on to reach is worse than no search at all.
    const backfill = await call("/board/reindex", { project_id: projectId }, human);
    check(
      `a board can be reindexed (${backfill.indexed} finished duties)`,
      backfill.indexed >= 1 && backfill.more === false,
      backfill,
    );
    const agentReindex = await call("/board/reindex", { project_id: projectId }, agent, { expectStatus: true });
    check("but only by a person, not an agent", agentReindex.status === 403, agentReindex);

    // /duty/reopen is the path that records WHY, but the console's status dropdown can move
    // a duty out of `done` too, and it has to leave the same world behind it. This is the
    // duty the two checks above just found and reindexed, moved by hand.
    await call("/duty/update", { duty_id: blocker.duty_id, status: "queued" }, human);
    let byHand = true;
    for (let i = 0; i < 20 && byHand; i++) {
      const res = await call("/duty/search", { project_id: projectId, query: "composite index" }, agent);
      byHand = (res.hits || []).some((h) => h.duty_id === blocker.duty_id);
      if (byHand) await new Promise((r) => setTimeout(r, 250));
    }
    check("and editing a duty out of done also takes it out of the index", !byHand);

    const nosy = `smoke-nosy-${Date.now()}`;
    await call("/projects/create", { name: "Nosy", project_id: nosy }, human);
    const nosyToken = (await call("/tokens/mint", { project_id: nosy, name: "nosy" }, human)).token;
    const escapes = [`project_id="${projectId}"`, `index OR project_id="${projectId}"`, "-nonexistent"];
    const leaked = [];
    for (const q of escapes) {
      const res = await call("/duty/search", { query: q }, nosyToken);
      if ((res.hits || []).length) leaked.push(q);
    }
    check(`no query escapes its board (${escapes.length} tried)`, leaked.length === 0, leaked);
    await call("/projects/delete", { project_id: nosy, confirm: nosy }, human);
  } else {
    check("search is optional and this deployment says it is off", health.search === false, health);
  }

  // --- the bounds that protect the bill -----------------------------------
  //
  // These exist because agents write here unattended and our own protocol tells them to
  // enqueue what they find. A cap nobody has ever seen fire is a comment, not a guard, so
  // one of them is driven to its limit for real. The thread cap is the cheapest to reach;
  // it exercises the same countAtMost path all four use.
  const capDuty = (await call("/duty/enqueue", { project_id: projectId, title: "cap probe", brief: "drive the thread cap" }, human)).duty_id;
  const capStart = Date.now();
  for (let i = 0; i < 200; i++) {
    await call("/duty/checkpoint", { duty_id: capDuty, kind: "note", message: `note ${i}` }, human);
  }
  const overCap = await call("/duty/checkpoint", { duty_id: capDuty, kind: "note", message: "one too many" }, human, {
    expectStatus: true,
  });
  check(`a thread stops growing at its limit (200 in ${Date.now() - capStart}ms)`, overCap.status === 400, overCap);
  check("and the refusal says what to do instead", /limit/.test(JSON.stringify(overCap.json)) && /split/.test(JSON.stringify(overCap.json)), overCap.json);

  // The duty itself is untouched — a full thread must not make a duty unfinishable.
  const stillWorks = await call("/duty/update", { duty_id: capDuty, title: "cap probe (renamed)" }, human, { expectStatus: true });
  check("a duty with a full thread can still be worked", stillWorks.status === 200, stillWorks);
  await call("/duty/delete", { duty_id: capDuty, confirm: capDuty }, human);

  // --- every endpoint, against a caller who owns none of it ----------------
  //
  // DERIVED from the function's own route table, not from a list here: a new endpoint with
  // no entry below fails this suite before it can ship without an ownership check. That is
  // exactly how /duty/thread went out — it loaded a duty by id and returned its whole
  // decision log to anyone who asked, and nothing forced the question to be asked again for
  // each new route.
  //
  // Two strangers, because they fail differently and both must. A signed-in person who owns
  // no part of this board, and an agent token minted on a DIFFERENT board — the second is
  // the one that matters most, since an agent token is the credential most likely to leak
  // into a log or a repo.
  //
  // EVERY duty-scoped probe gets a FRESH duty. Sharing one target makes the suite lie: the
  // first version of this shared a duty, /duty/delete ran before /duty/thread, and a
  // successful delete turned the next probe's leak into an honest 404. A test that hides a
  // hole because an earlier hole fired first is worse than no test.
  const freshDuty = async () =>
    (await call("/duty/enqueue", { project_id: projectId, title: "outsider target", brief: "a duty to probe against" }, human))
      .duty_id;

  const outsiderArgs = {
    "/duty/poll": () => ({ project_id: projectId }),
    "/duty/claim": (d) => ({ duty_id: d }),
    "/duty/enqueue": () => ({ project_id: projectId, title: "no", brief: "no" }),
    "/duty/checkpoint": (d) => ({ duty_id: d, message: "no" }),
    "/duty/complete": (d) => ({ duty_id: d, outcome_summary: "no" }),
    "/duty/fail": (d) => ({ duty_id: d, reason: "no" }),
    "/duty/resolve": (d) => ({ duty_id: d, answer: "no" }),
    "/duty/reopen": (d) => ({ duty_id: d, note: "no" }),
    "/duty/update": (d) => ({ duty_id: d, title: "no" }),
    "/duty/delete": (d) => ({ duty_id: d, confirm: d }),
    "/duty/thread": (d) => ({ duty_id: d }),
    "/duty/get": (d) => ({ duty_id: d }),
    "/duty/search": () => ({ project_id: projectId, query: "anything" }),
    "/duty/attach": (d) => ({ duty_id: d, name: "x.png", size: 10, content_type: "image/png" }),
    "/duty/attachments": (d) => ({ duty_id: d }),
    "/duty/attachment/delete": () => ({ attachment_id: "att_nope" }),
    "/board/open": () => ({ project_id: projectId }),
    "/board/reindex": () => ({ project_id: projectId }),
    "/board/members/list": () => ({ project_id: projectId }),
    "/board/members/add": () => ({ project_id: projectId, email: bystanderEmail }),
    "/board/members/remove": () => ({ project_id: projectId, uid: signup.user.uid }),
    "/projects/rename": () => ({ project_id: projectId, name: "mine now" }),
    "/projects/delete": () => ({ project_id: projectId, confirm: projectId }),
    "/tokens/mint": () => ({ project_id: projectId, name: "no" }),
    "/tokens/list": () => ({ project_id: projectId }),
    "/tokens/revoke": () => ({ project_id: projectId, token_id: "tok_nope" }),
    "/live/token": () => ({ project_id: projectId }),
    "/board/members/agents": () => ({ project_id: projectId, uid: other0.user.uid, can_run_agents: true }),
    "/board/profile": () => ({ project_id: projectId }),
    "/board/runners": () => ({ project_id: projectId }),
    "/board/profile/propose": (d) => ({ duty_id: d, test_command: "no" }),
    "/board/rules": () => ({ project_id: projectId }),
    "/board/rules/set": () => ({ project_id: projectId, body: "no" }),
    "/board/rules/accept": () => ({ project_id: projectId }),
    "/board/rules/submit": (d) => ({ duty_id: d, body: "no" }),
    "/projects/profile": () => ({ project_id: projectId, runner: { parallel: 3 } }),
    "/connect/lookup": () => ({ user_code: "ZZZZ-ZZZZ" }),
    "/connect/approve": () => ({ user_code: "ZZZZ-ZZZZ" }),
    "/connect/deny": () => ({ user_code: "ZZZZ-ZZZZ" }),
    "/connect/poll": () => ({ device_code: "not-a-device-code" }),
    "/machines/update": () => ({ machine_id: paired.machine_id, paused: false }),
    "/machines/revoke": () => ({ machine_id: paired.machine_id }),
    "/machines/unlink": () => ({ machine_id: paired.machine_id, project_id: projectId }),
    "/machine/me": () => ({}),
    "/machine/boards": () => ({}),
    "/machine/boards/create": () => ({ name: "Not yours", project_id: `outsider-made-${Date.now()}` }),
    "/machine/link": () => ({ project_id: projectId }),
    "/machine/unlink": () => ({ project_id: projectId }),
    "/machine/state": () => ({ project_id: projectId, runs: [] }),
    "/machine/poll": () => ({}),
    "/machine/live": () => ({}),
    "/machine/request": () => ({ machine_id: paired.machine_id, project_id: projectId }),
    "/machine/request/report": () => ({ request_id: "mr_nope", status: "done" }),
    // Public by design: a daemon starting a pairing has no credential to check yet.
    "/connect/start": null,
    // Acts on whoever is calling: an outsider gets their own, empty, list.
    "/machines/list": null,
    "/machines/retry": () => ({ machine_id: paired.machine_id, project_id: projectId }),
    // These two take no target: they act on whoever is calling. An outsider calling them
    // gets their OWN empty world, which is correct rather than a leak — so they are
    // excluded deliberately, and named here so the exclusion is a decision on the record.
    "/projects/create": null,
    "/projects/list": null,
    "/me/access": null,
    // Notifications act on the caller too: their own channel, key, and devices. Turning off a device
    // that is not yours answers ok and removes nothing, which is checked above.
    "/live/me": null,
    "/push/key": null,
    "/push/subscribe": null,
    "/push/unsubscribe": null,
    "/push/test": null,
  };

  const uncovered = ROUTE_PATHS.filter((p) => !(p in outsiderArgs));
  check(`every route is in the cross-tenant matrix${uncovered.length ? ` (missing: ${uncovered.join(", ")})` : ""}`, uncovered.length === 0);

  // An agent token on a board of their own — the realistic leaked-credential case.
  const otherProject = `smoke-outsider-${Date.now()}`;
  await call("/projects/create", { name: "Outsider board", project_id: otherProject, profile: { repo_url: "https://github.com/example/outsider.git" } }, other.id_token);
  const otherAgent = (await call("/tokens/mint", { project_id: otherProject, name: "outsider" }, other.id_token)).token;
  // And a machine key belonging to someone else, pointed at this board — the leaked daemon key.
  const otherMachine = await pair(other.id_token, "Outsider machine");
  await call("/machine/link", { project_id: otherProject, setup: false }, otherMachine.machine_key);

  const leaks = [];
  let probes = 0;
  const outsiders = [
    ["a stranger", other.id_token, null],
    ["another board's agent", otherAgent, null],
    ["another person's machine naming this board", otherMachine.machine_key, projectId],
  ];
  for (const path of ROUTE_PATHS) {
    const build = outsiderArgs[path];
    if (!build) continue;
    for (const [who, token, board] of outsiders) {
      const res = await call(path, build(await freshDuty()), token, { expectStatus: true, board });
      probes++;
      // 401/403/404 are all correct refusals; which one is a separate design question
      // (404 where naming a thing would confirm it exists). Anything below 400 is a leak.
      if (res.status < 400) leaks.push(`${path} answered ${res.status} to ${who}`);
    }
  }
  check(`no endpoint answers a caller who owns nothing here (${probes} probes)${leaks.length ? `: ${leaks.join("; ")}` : ""}`, leaks.length === 0);

  // The board must still be here: every one of those probes was supposed to be refused,
  // and /projects/delete was among them.
  const survived = await call("/board/open", { project_id: projectId }, human, { expectStatus: true });
  check("the board survived every probe", survived.status === 200, survived.status);

  await call("/projects/delete", { project_id: otherProject, confirm: otherProject }, other.id_token);
  await call("/machines/revoke", { machine_id: otherMachine.machine_id }, other.id_token);

  // --- revocation ---------------------------------------------------------
  const tokenList = await call("/tokens/list", { project_id: projectId }, human);
  check("the console can list tokens", tokenList.tokens.length === 1, tokenList);
  check("but never the token itself", !JSON.stringify(tokenList).includes(agent), tokenList);

  await call("/tokens/revoke", { project_id: projectId, token_id: minted.token_id }, human);
  const afterRevoke = await call("/duty/poll", { agent_id: "alpha" }, agent, { expectStatus: true });
  check("a revoked token stops working", afterRevoke.status === 401, afterRevoke);

  await call("/machines/revoke", { machine_id: paired.machine_id }, human);
  const afterMachineRevoke = await call("/machine/me", {}, mkey, { expectStatus: true });
  check("a revoked machine key stops working", afterMachineRevoke.status === 401, afterMachineRevoke);

  // --- cleanup ------------------------------------------------------------
  const wrongConfirm = await call("/projects/delete", { project_id: projectId, confirm: "nope" }, human, { expectStatus: true });
  check("deleting a board needs the id repeated", wrongConfirm.status === 403, wrongConfirm);

  // Four from the walk above, plus one target per cross-tenant probe. Derived rather than
  // a constant, so the sweep is asserted against what was actually created.
  const expectedDuties = 4 + probes;
  const removed = await call("/projects/delete", { project_id: projectId, confirm: projectId }, human);
  check(`the board and its rows are swept (${expectedDuties} duties)`, removed.removed.duties === expectedDuties, removed.removed);

  console.log(`\n${failures.length ? "✖" : "✔"} ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`    ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
