// Webhooks: telling the system that filed a duty that the duty moved.
//
// A token can carry a URL. Every status change of a duty that token filed — queued, active,
// needs_decision, blocked, done, failed, deleted — is POSTed there, signed with a secret that
// belongs to that token alone.
//
// The URL and secret live in `webhooks`, keyed like the token by its hash, and not on the token
// row: that row is rewritten once a minute by whoever is using the token, and a write carrying the
// row as it was a moment ago would put back a secret the owner had just rotated. Browsers cannot
// read the collection — the access rules name no `webhooks` — so the secret is the function's.
//
// Delivery is not done here, in the request that changed the duty. A function has no waitUntil,
// so a slow receiver would hold up an agent's `duty_complete`, and a receiver that is down would
// lose the event. Instead each event is a task on the deployment's `webhooks` push queue, and the
// queue calls this function back (`x-ae-trigger: task`) to make the request. The queue owns the
// retries, the backoff and giving up; this file owns the signature, because the queue's own
// webhook signing uses one secret for the whole instance, and a deployment is shared by every
// board on it.
//
//   transition ──ctx.publish──▶ queueDutyEvent ──env.tasks.add──▶ `webhooks` queue
//                                                                     │ (retries, backoff)
//                                                   deliverWebhook ◀──┘ x-ae-trigger: task
//                                                         │ signed with the token's dbw_ secret
//                                                         ▼
//                                                  the token's URL
//
// One funnel, not one call per transition: every transition already publishes its new status for
// the console, so wrapping the publisher catches all of them — including the clock's — and a
// transition added later is covered without anyone remembering this file exists.
//
// What the function may reach is the deployment's to decide: hosts are allowed when it is
// deployed (`dutyboard --provision-only --webhook-hosts …`), which both lets the function's fetch
// out and is recorded in `settings/webhooks` for the check below. A URL on any other host is
// refused when it is set, not discovered when the first delivery fails.

import { badRequest, conflict, forbidden, notFound, str } from "./http.js";
import { hmacSha256Hex } from "./hash.js";
import { mintWebhookSecret } from "./ids.js";
import { requireHuman, resolveProject } from "./identity.js";

export const WEBHOOK_QUEUE = "webhooks";

/** What a token's webhook can be told about: a duty reaching each status, or going away. */
export const WEBHOOK_EVENTS = ["queued", "active", "needs_decision", "blocked", "done", "failed", "deleted"];

/** How long a receiver gets to answer, inside the queue's own 30s deadline. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** How long what the provisioner recorded is believed, per isolate. A host allowed by a deploy
 *  is usable within this; nothing else changes it. */
const SETTINGS_TTL_MS = 60_000;

let settingsMemo = null;

/**
 * This deployment's webhook settings: the hosts its function may reach, the tasks instance its
 * queue lives on, and where its console is (for the link in each payload). Recorded by the
 * provisioner in the datastore rather than as function secrets, because hosted, secrets are only
 * written from a signed-in altengine console and the provisioner holds an API key.
 */
export async function webhookSettings(ctx) {
  const now = Date.now();
  if (settingsMemo && now - settingsMemo.at < SETTINGS_TTL_MS) return settingsMemo;
  const [hooks, deployment] = await Promise.all([
    ctx.store.get("settings", "webhooks").catch(() => null),
    ctx.store.get("settings", "deployment").catch(() => null),
  ]);
  const hosts = Array.isArray(hooks && hooks.hosts) ? hooks.hosts.filter((h) => typeof h === "string" && h) : [];
  const tasksInstance = ctx.cfg.tasksInstance || (hooks && typeof hooks.tasks_instance === "string" ? hooks.tasks_instance : "");
  const consoleUrl = ctx.cfg.consoleUrl || (deployment && typeof deployment.console_url === "string" ? deployment.console_url : "");
  settingsMemo = { at: now, hosts, tasksInstance, consoleUrl, ready: !!(ctx.env.tasks && tasksInstance && hosts.length) };
  return settingsMemo;
}

/** Same rule as the push services' list: `*.example.com` is any subdomain of it, anything else is
 *  that host exactly. */
const hostMatches = (host, pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern);

/** Why this URL cannot be a webhook here, or "" when it can. */
export function urlProblem(raw, hosts) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "'url' is not a URL";
  }
  if (u.protocol !== "https:") return "a webhook URL must be https";
  if (u.username || u.password) return "a webhook URL must not carry credentials — the signature is how the receiver knows it is us";
  // What the platform's fetch refuses whatever the allowlist says, refused here where it can be read.
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return "a webhook URL must name a host, not an IP address";
  if (host === "localhost" || /\.(localhost|internal|local)$/.test(host)) return `'${host}' is not a public hostname`;
  if (!hosts.some((h) => hostMatches(host, h.toLowerCase()))) {
    return hosts.length
      ? `this deployment may only call ${hosts.join(", ")} — deploy it again with --webhook-hosts ${u.hostname} to allow that host`
      : `this deployment allows no webhook hosts yet — deploy it again with --webhook-hosts ${u.hostname}`;
  }
  return "";
}

// --- the owner's routes --------------------------------------------------------------------------

/** The token a route names, checked to be this board's, and its webhook row if it has one. */
async function ownedToken(ctx, body) {
  requireHuman(ctx.caller);
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store, { ownerOnly: true });
  const id = str(body.token_id, "token_id", { required: true, max: 128 });
  const [token, hook] = await Promise.all([ctx.store.get("tokens", id), ctx.store.get("webhooks", id)]);
  if (!token || token.project_id !== project.key) throw notFound(`token '${id}' not found`);
  if (token.revoked) throw conflict(`token '${id}' is revoked`);
  return { id, project, hook: hook ? stripKeys(hook) : null };
}

const stripKeys = ({ key, _created, _updated, ...data }) => data;

/** A board's webhooks by token id, for the owner's token list. Never the secrets. */
export async function webhooksOf(ctx, projectKey, limit) {
  const { rows } = await ctx.store.query("webhooks", { where: [{ field: "project_id", op: "=", value: projectKey }], limit });
  const out = new Map();
  for (const h of rows) {
    out.set(h.key, { url: h.url, events: h.events || ["*"], last_status: h.last_status || null, last_at: h.last_at || null });
  }
  return out;
}

/** A revoked token's webhook goes with it, and with it every delivery still queued. */
export async function dropWebhook(ctx, tokenId) {
  await ctx.store.delete("webhooks", [tokenId]);
}

function eventsFrom(v) {
  if (v == null) return ["*"];
  if (!Array.isArray(v) || !v.length) throw badRequest(`'events' must be a non-empty array of: *, ${WEBHOOK_EVENTS.join(", ")}`);
  for (const e of v) {
    if (e !== "*" && !WEBHOOK_EVENTS.includes(e)) throw badRequest(`'events' must contain only: *, ${WEBHOOK_EVENTS.join(", ")}`);
  }
  return v.includes("*") ? ["*"] : [...new Set(v)];
}

/**
 * `POST /tokens/webhook` — set, change or (`url: null`) remove a token's webhook.
 *
 * The secret is minted the first time a URL is set and returned then, once — like the token itself.
 * Changing the URL keeps it, so a receiver moving hosts does not have to be re-keyed; rotating is
 * its own route.
 */
export async function setWebhook(ctx, body) {
  const { id, project, hook } = await ownedToken(ctx, body);
  if (body.url === null || body.url === "") {
    await dropWebhook(ctx, id);
    return { ok: true, token_id: id, webhook_url: null };
  }
  const settings = await webhookSettings(ctx);
  if (!settings.ready) {
    throw forbidden(
      ctx.env.tasks && settings.tasksInstance
        ? "this deployment allows no webhook hosts yet — deploy it again with --webhook-hosts <host>"
        : "this deployment has no task queue for webhooks — deploy it again with this version of dutyboard",
    );
  }
  const url = str(body.url, "url", { required: true, max: 2000 });
  const why = urlProblem(url, settings.hosts);
  if (why) throw badRequest(why);
  const secret = (hook && hook.secret) || mintWebhookSecret();
  const events = eventsFrom(body.events);
  const now = Date.now();
  await ctx.store.putOne("webhooks", id, {
    ...(hook || { created_at: now, last_status: null, last_at: null }),
    project_id: project.key,
    url,
    secret,
    events,
    updated_at: now,
  });
  return { ok: true, token_id: id, webhook_url: url, events, ...(hook ? {} : { secret }) };
}

/** `POST /tokens/webhook/rotate` — a new secret, returned once. The old one stops signing at once:
 *  a receiver that checks signatures refuses deliveries until it has the new one. */
export async function rotateWebhookSecret(ctx, body) {
  const { id, hook } = await ownedToken(ctx, body);
  if (!hook) throw conflict(`token '${id}' has no webhook to rotate the secret of`);
  const secret = mintWebhookSecret();
  await ctx.store.putOne("webhooks", id, { ...hook, secret, updated_at: Date.now() });
  return { ok: true, token_id: id, secret };
}

/** `POST /tokens/webhook/test` — queue a `ping`, delivered exactly as an event would be. */
export async function testWebhook(ctx, body) {
  const { id, project, hook } = await ownedToken(ctx, body);
  if (!hook) throw conflict(`token '${id}' has no webhook to test`);
  const settings = await webhookSettings(ctx);
  if (!settings.ready) throw forbidden("this deployment cannot deliver webhooks — see /tokens/webhook");
  const now = Date.now();
  const name = `ping.${id.slice(0, 16)}.${now}`;
  await addTask(ctx, settings, name, id, "ping", { id: name, type: "ping", created_at: now, board: project.key });
  return { ok: true, token_id: id, queued: name };
}

// --- emitting ------------------------------------------------------------------------------------

/**
 * The request's publisher, with webhooks behind it.
 *
 * A fourth argument — the duty row, when the caller has it — is never published; it is for a duty
 * that is about to be or has just been deleted, whose row this could no longer read.
 */
export function withWebhooks(ctx, publish) {
  return async function publishAndNotify(projectId, dutyIdOrNull, payload, row) {
    await publish(projectId, dutyIdOrNull, payload);
    if (!dutyIdOrNull || !payload || payload.t !== "duty" || !payload.status) return;
    await queueDutyEvent(ctx, dutyIdOrNull, payload.status, row);
  };
}

/**
 * Queue the event for a duty that just reached `status`, if a token filed it and wants to know.
 * Never throws: the transition it reports has already happened.
 */
export async function queueDutyEvent(ctx, dutyId, status, row) {
  try {
    const settings = await webhookSettings(ctx);
    // Nothing allowed, nothing to send — and no read on every transition of a deployment that
    // has never set a webhook.
    if (!settings.ready) return;
    const duty = row || (await ctx.store.get("duties", dutyId));
    if (!duty || !duty.filed_by_token) return;
    const hook = await hookFor(ctx, duty.filed_by_token);
    if (!hook || !hook.url) return;
    const events = hook.events || ["*"];
    if (!events.includes("*") && !events.includes(status)) return;

    const now = Date.now();
    // The name makes a double publish of one transition one task, and is what the receiver sees
    // as the delivery id: the same event retried keeps it.
    const name = status === "deleted" ? `${dutyId}.deleted` : `${dutyId}.${duty.updated_at || now}.${status}`;
    await addTask(ctx, settings, name, duty.filed_by_token, `duty.${status}`, {
      id: name,
      type: `duty.${status}`,
      created_at: now,
      board: duty.project_id,
      duty: snapshotOf(duty, status, settings.consoleUrl),
    });
  } catch (err) {
    console.log(`webhooks: could not queue ${status} for ${dutyId}:`, err && err.message);
  }
}

/** Webhook rows, read once per request however many duties it moves. */
async function hookFor(ctx, key) {
  if (!ctx._webhooks) ctx._webhooks = new Map();
  if (!ctx._webhooks.has(key)) ctx._webhooks.set(key, await ctx.store.get("webhooks", key));
  return ctx._webhooks.get(key);
}

/** The duty as it stood when it moved. A snapshot, not a pointer: deliveries can arrive out of
 *  order, and `updated_at` is how a receiver tells which is newer. */
function snapshotOf(duty, status, consoleUrl) {
  return {
    id: duty.key,
    title: duty.title,
    status,
    priority: duty.priority,
    external_ref: duty.external_ref || null,
    metadata: duty.metadata || null,
    outcome_summary: duty.outcome_summary || null,
    last_question: duty.last_question || null,
    attachment_count: duty.attachment_count || 0,
    assigned_agent_id: duty.assigned_agent_id || null,
    reserved_for: duty.reserved_for || null,
    created_at: duty.created_at || null,
    updated_at: duty.updated_at || null,
    url: consoleUrl ? `${consoleUrl.replace(/\/+$/, "")}/#/b/${encodeURIComponent(duty.project_id)}/d/${encodeURIComponent(duty.key)}` : null,
  };
}

async function addTask(ctx, settings, name, tokenKey, event, envelope) {
  const [res] = await ctx.env.tasks.add({ instance: settings.tasksInstance }, WEBHOOK_QUEUE, [
    // The body is signed as these exact bytes, so it travels as a string and is sent unchanged.
    { name, payload: { token_key: tokenKey, event, body: JSON.stringify(envelope) } },
  ]);
  // A name already queued is the same event published twice — the point of naming it.
  if (res && res.ok === false && res.code !== "TASK_EXISTS") {
    throw new Error(`${res.code || "add failed"}: ${res.message || ""}`);
  }
}

// --- delivering ----------------------------------------------------------------------------------

const answer = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * One delivery, for the queue. What this answers is what the queue does next:
 *
 *   200  delivered, or dropped on purpose (token revoked, webhook removed) — done
 *   503  the receiver was down, slow or said 429/5xx — retried with backoff
 *   422  the receiver refused it with a 4xx, or it was never a delivery — failed now; the same
 *        request would be refused the same way again
 *
 * The task's payload is data: the URL and secret are read from the webhook row as it is NOW, so
 * revoking a token (which removes the row) or removing its webhook stops deliveries already queued.
 */
export async function deliverWebhook(ctx, request) {
  let delivery;
  try {
    delivery = await request.json();
  } catch {
    return answer(422, { error: "not a task delivery" }, { "x-task-retry": "never" });
  }
  const task = delivery && delivery.task;
  const p = delivery && delivery.payload;
  if (!task || task.queue !== WEBHOOK_QUEUE || !p || typeof p.token_key !== "string" || typeof p.body !== "string") {
    return answer(422, { error: `not a '${WEBHOOK_QUEUE}' delivery` }, { "x-task-retry": "never" });
  }

  const hook = await ctx.store.get("webhooks", p.token_key);
  if (!hook || !hook.url || !hook.secret) return answer(200, { dropped: "the token or its webhook is gone" });
  const settings = await webhookSettings(ctx);
  const why = urlProblem(hook.url, settings.hosts);
  if (why) {
    await noteDelivery(ctx, hook.key, `refused: ${why}`);
    return answer(200, { dropped: why });
  }

  const ts = Date.now();
  let res;
  try {
    res = await withTimeout(
      fetch(hook.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "dutyboard-webhooks",
          "x-dutyboard-event": p.event || "",
          "x-dutyboard-delivery": task.name || task.id || "",
          "x-dutyboard-timestamp": String(ts),
          "x-dutyboard-signature": "v1=" + hmacSha256Hex(hook.secret, `${ts}.${p.body}`),
        },
        body: p.body,
      }),
      DELIVERY_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = (err && err.message) || "no answer";
    await noteDelivery(ctx, hook.key, `error: ${msg}`);
    return answer(503, { error: msg });
  }
  // Read so the connection is released; the body is not ours to keep.
  await res.text().catch(() => "");
  await noteDelivery(ctx, hook.key, `http:${res.status}`);

  if (res.status >= 200 && res.status < 300) return answer(200, { delivered: res.status });
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    const after = res.headers.get("retry-after");
    return answer(503, { receiver: res.status }, after ? { "retry-after": after } : {});
  }
  // A redirect is a setting to fix, like any other 3xx/4xx: the signature was made for this URL,
  // and the platform follows one only as a GET without the body, if at all.
  return answer(422, { receiver: res.status }, { "x-task-retry": "never" });
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms))]);

/**
 * What the last delivery came to, for the owner's token list. At most once a minute per token,
 * unless it changed — a failing receiver is worth seeing the moment it starts failing.
 *
 * Read again here rather than reusing the row the delivery started with: the receiver may have
 * taken ten seconds, and an owner who rotated the secret in them must not have it put back.
 */
async function noteDelivery(ctx, key, status) {
  try {
    const row = await ctx.store.get("webhooks", key);
    if (!row) return;
    const now = Date.now();
    if (row.last_status === status && row.last_at && now - row.last_at < 60_000) return;
    await ctx.store.putOne("webhooks", key, { ...stripKeys(row), last_status: status, last_at: now });
  } catch (err) {
    console.log("webhooks: could not record a delivery:", err && err.message);
  }
}
