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

const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const FN = process.env.DUTYBOARD_FN_INSTANCE || "dutyboard";
const DS = process.env.DUTYBOARD_DATASTORE || "dutyboard";
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const FN_NAME = process.env.DUTYBOARD_FN_NAME || "board";
const API = process.env.DUTYBOARD_API || (BASE.includes("altengine.net") ? `https://${FN}-fn.altengine.app/${FN_NAME}` : `${BASE}/fn/${FN}/${FN_NAME}`);

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
  check("the refusal names what to finish", second.json.error.details.active_duty_id === soon.duty_id, second.json);

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

  const removed = await call("/projects/delete", { project_id: projectId, confirm: projectId }, human);
  check("the board and its rows are swept", removed.removed.duties === 3, removed.removed);

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
