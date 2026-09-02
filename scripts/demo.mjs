#!/usr/bin/env node
// Fill a board with a plausible afternoon's work, so there is something to look at.
//
//   npm run demo
//
// It creates (or reuses) a demo account, makes a board, mints an agent token, and then
// drives the real state machine through a real agent's real sequence: poll, claim,
// complete, ask, interrupt. Nothing is written directly — every row here is one the API
// could have produced, because a demo that reaches states the API cannot is a demo that
// lies about the product.
//
// The board is left mid-flight on purpose. One duty is parked on a question with two
// suggested options and nobody has answered it: that is the interaction this whole thing
// exists for, and it should be the first thing you can click.

const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const FN = process.env.DUTYBOARD_FN_INSTANCE || "dutyboard";
const FN_NAME = process.env.DUTYBOARD_FN_NAME || "board";
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const API =
  process.env.DUTYBOARD_API ||
  (BASE.includes("altengine.net") ? `https://${FN}-fn.altengine.app/${FN_NAME}` : `${BASE}/fn/${FN}/${FN_NAME}`);

const EMAIL = process.env.DUTYBOARD_DEMO_EMAIL || "demo@dutyboard.test";
const PASSWORD = process.env.DUTYBOARD_DEMO_PASSWORD || "dutyboard-demo-account";

async function authCall(path, body) {
  const res = await fetch(`${BASE}/v1/auth/${encodeURIComponent(AUTH)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function call(path, body, token) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Sign in if the demo account is already there, sign up if it is not. Re-running should
 *  add a second board to look at, not fail on an email that exists. */
async function account() {
  const up = await authCall("/signup", { email: EMAIL, name: "Demo Owner", password: PASSWORD });
  if (up.status < 400) return { token: up.json.id_token, fresh: true };
  const inn = await authCall("/signin", { identifier: EMAIL, password: PASSWORD });
  if (inn.status < 400) return { token: inn.json.id_token, fresh: false };
  throw new Error(
    `could not sign in as ${EMAIL} (${inn.status} ${JSON.stringify(inn.json)}) — ` +
      `if you changed the password, set DUTYBOARD_DEMO_EMAIL to a new address`,
  );
}

const enqueue = (human, project_id, title, brief, priority) =>
  call("/duty/enqueue", { project_id, title, brief, priority }, human);

async function main() {
  const health = await fetch(`${API}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`✖ no DutyBoard function at ${API}`);
    console.error(`  start the emulator and run:  npm run provision`);
    process.exit(1);
  }

  const { token: human, fresh } = await account();
  const slug = `demo-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  await call("/projects/create", { name: "Payments rewrite", project_id: slug }, human);

  const minted = await call("/tokens/mint", { project_id: slug, name: "demo agent", default_agent_id: "alpha" }, human);
  const agent = minted.token;

  // The backlog, oldest first — the order the queue will hand them back in.
  const migrate = await enqueue(
    human,
    slug,
    "Migrate the charge table to the new schema",
    "Add `currency` and `captured_at`, backfill from the ledger, and leave the old columns in place until the read path is cut over.",
    "next",
  );
  const webhooks = await enqueue(
    human,
    slug,
    "Verify Stripe webhook signatures",
    "Every webhook handler currently trusts the body. Verify the signature header against the endpoint secret and reject the ones that do not match.",
    "next",
  );
  const receipts = await enqueue(
    human,
    slug,
    "Send a receipt email on successful capture",
    "Plain text is fine for now. It needs the amount, the last four digits, and a link to the invoice.",
    "backlog",
  );
  await enqueue(
    human,
    slug,
    "Delete the legacy /v1/pay endpoint",
    "Nothing has called it in four months. Confirm from the access logs before removing it.",
    "backlog",
  );

  // --- the agent's afternoon ----------------------------------------------------------
  // 1. It takes the top of the queue and finishes it.
  await call("/duty/claim", { duty_id: migrate.duty_id, agent_id: "alpha" }, agent);
  await call(
    "/duty/checkpoint",
    { duty_id: migrate.duty_id, agent_id: "alpha", kind: "checkpoint", message: "Backfilled 41,882 rows; the ledger and the charge table agree." },
    agent,
  );
  await call(
    "/duty/complete",
    {
      duty_id: migrate.duty_id,
      agent_id: "alpha",
      outcome_summary:
        "Added `currency` and `captured_at` to `charges` and backfilled from the ledger. The old columns are still written but nothing reads them — cutting them is a separate duty.",
    },
    agent,
  );

  // 2. It takes the next one and hits something only a person can settle. The duty parks,
  //    the agent is freed in the same write.
  await call("/duty/claim", { duty_id: webhooks.duty_id, agent_id: "alpha" }, agent);
  await call(
    "/duty/checkpoint",
    {
      duty_id: webhooks.duty_id,
      agent_id: "alpha",
      kind: "question",
      message:
        "There are two endpoint secrets in the vault — one from the old account and one from the migration. Which is live, and should the other be rejected outright or logged and ignored for a while?",
      suggested_options: ["Use the migration secret, reject the other", "Accept both for 30 days, then reject"],
      set_status: "needs_decision",
    },
    agent,
  );

  // 3. It starts the third and discovers work that has to happen first. The interrupt
  //    moves the parent to `blocked` and the child goes to the front of the queue.
  await call("/duty/claim", { duty_id: receipts.duty_id, agent_id: "alpha" }, agent);
  const blocker = await call(
    "/duty/enqueue",
    {
      project_id: slug,
      agent_id: "alpha",
      title: "No outbound mail is configured",
      brief: "There is no SMTP config and no sending domain, so the receipt cannot be delivered. This has to exist before the receipt duty can finish.",
      priority: "immediate_blocker",
    },
    agent,
  );
  await call("/duty/claim", { duty_id: blocker.duty_id, agent_id: "alpha" }, agent);
  await call(
    "/duty/checkpoint",
    { duty_id: blocker.duty_id, agent_id: "alpha", kind: "note", message: "Checked the DNS: the domain has no SPF record either. Adding both." },
    agent,
  );

  console.log(`✔ demo board ready\n`);
  console.log(`    board       Payments rewrite  (${slug})`);
  console.log(`    columns     1 needs a decision · 1 active · 1 blocked · 2 queued · 1 done`);
  console.log(`\n  Sign in at http://localhost:5173/app/`);
  console.log(`    email       ${EMAIL}`);
  console.log(`    password    ${PASSWORD}${fresh ? "" : "   (existing demo account)"}`);
  console.log(`\n  Answer the parked question on "Verify Stripe webhook signatures" —`);
  console.log(`  it goes back to the front of the queue with your answer attached.`);
  console.log(`\n  The agent token, if you want to drive it from a terminal too:`);
  console.log(`    ${agent}`);
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
