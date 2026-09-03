#!/usr/bin/env node
// End-to-end exercise of the state machine against a running deployment.
//
//   altengine dev && npm run setup && npm run deploy      # in another terminal
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

async function call(path, body, token, { expectStatus } = {}) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

  // --- a person, a board, and a token for an agent ------------------------
  const email = `smoke_${Date.now()}@example.test`;
  const signup = await authCall("/signup", { email, name: "Smoke Tester", password: "correct-horse-battery-staple" });
  const human = signup.id_token;
  check("signed up a human", !!human);

  const projectId = `smoke-${Date.now().toString(36)}`;
  const other0 = await authCall("/signup", {
    email: `bystander_${Date.now()}@example.test`,
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
  const dsQuery = async (collection, req, token) => {
    const res = await fetch(`${BASE}/v1/datastore/${encodeURIComponent(DS)}/ns/_default/col/${collection}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(req),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, docs: json.documents || [] };
  };

  const mine = await dsQuery("duties", { where: [{ field: "project_id", op: "=", value: projectId }], limit: 50 }, human);
  check("the console can read its own duties", mine.status === 200 && mine.docs.length === 3, mine);

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
  const theirs = await dsQuery("duties", { where: [{ field: "project_id", op: "=", value: projectId }], limit: 50 }, other.id_token);
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
    "/duty/update": (d) => ({ duty_id: d, title: "no" }),
    "/duty/delete": (d) => ({ duty_id: d, confirm: d }),
    "/duty/thread": (d) => ({ duty_id: d }),
    "/duty/attach": (d) => ({ duty_id: d, name: "x.png", size: 10, content_type: "image/png" }),
    "/duty/attachments": (d) => ({ duty_id: d }),
    "/duty/attachment/delete": () => ({ attachment_id: "att_nope" }),
    "/board/open": () => ({ project_id: projectId }),
    "/projects/rename": () => ({ project_id: projectId, name: "mine now" }),
    "/projects/delete": () => ({ project_id: projectId, confirm: projectId }),
    "/tokens/mint": () => ({ project_id: projectId, name: "no" }),
    "/tokens/list": () => ({ project_id: projectId }),
    "/tokens/revoke": () => ({ project_id: projectId, token_id: "tok_nope" }),
    "/live/token": () => ({ project_id: projectId }),
    // These two take no target: they act on whoever is calling. An outsider calling them
    // gets their OWN empty world, which is correct rather than a leak — so they are
    // excluded deliberately, and named here so the exclusion is a decision on the record.
    "/projects/create": null,
    "/projects/list": null,
  };

  const uncovered = ROUTE_PATHS.filter((p) => !(p in outsiderArgs));
  check(`every route is in the cross-tenant matrix${uncovered.length ? ` (missing: ${uncovered.join(", ")})` : ""}`, uncovered.length === 0);

  // An agent token on a board of their own — the realistic leaked-credential case.
  const otherProject = `smoke-outsider-${Date.now()}`;
  await call("/projects/create", { name: "Outsider board", project_id: otherProject }, other.id_token);
  const otherAgent = (await call("/tokens/mint", { project_id: otherProject, name: "outsider" }, other.id_token)).token;

  const leaks = [];
  let probes = 0;
  for (const path of ROUTE_PATHS) {
    const build = outsiderArgs[path];
    if (!build) continue;
    for (const [who, token] of [["a stranger", other.id_token], ["another board's agent", otherAgent]]) {
      const res = await call(path, build(await freshDuty()), token, { expectStatus: true });
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

  // --- revocation ---------------------------------------------------------
  const tokenList = await call("/tokens/list", { project_id: projectId }, human);
  check("the console can list tokens", tokenList.tokens.length === 1, tokenList);
  check("but never the token itself", !JSON.stringify(tokenList).includes(agent), tokenList);

  await call("/tokens/revoke", { project_id: projectId, token_id: minted.token_id }, human);
  const afterRevoke = await call("/duty/poll", { agent_id: "alpha" }, agent, { expectStatus: true });
  check("a revoked token stops working", afterRevoke.status === 401, afterRevoke);

  // --- cleanup ------------------------------------------------------------
  const wrongConfirm = await call("/projects/delete", { project_id: projectId, confirm: "nope" }, human, { expectStatus: true });
  check("deleting a board needs the id repeated", wrongConfirm.status === 403, wrongConfirm);

  // Three from the walk above, plus one target per cross-tenant probe. Derived rather than
  // a constant, so the sweep is asserted against what was actually created.
  const expectedDuties = 3 + probes;
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
