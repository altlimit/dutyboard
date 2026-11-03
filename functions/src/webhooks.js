// Webhooks: telling the system that filed a duty that the duty moved.
//
// A token can carry a URL. Every status change of a duty that token filed — queued, active,
// needs_decision, blocked, done, failed, deleted — is POSTed there.
//
// Not from here, in the request that changed the duty: a function has no waitUntil, so a slow
// receiver would hold up an agent's `duty_complete`, and a receiver that is down would lose the
// event. Each event is a task on the deployment's `webhooks` queue (altengine tasks), aimed at the
// token's URL, and the platform makes the request — signed with the tasks instance's secret, the
// way every altengine webhook is, and retried with backoff until the receiver takes it or a day
// has passed. One secret for the whole deployment is fine for what this is: a DutyBoard someone
// runs for themselves, whose boards' owners are their own people.
//
//   transition ──ctx.publish──▶ queueDutyEvent ──env.tasks.add──▶ `webhooks` queue ──▶ the URL
//                                                                   (signs, retries)
//
// One funnel, not one call per transition: every transition already publishes its new status for
// the console, so wrapping the publisher catches all of them — including the clock's — and a
// transition added later is covered without anyone remembering this file exists.
//
// The URL lives in `webhooks`, keyed like the token by its hash, rather than on the token row,
// which whoever is using the token rewrites once a minute.

import { badRequest, conflict, forbidden, notFound, str } from "./http.js";
import { requireHuman, resolveProject } from "./identity.js";

export const WEBHOOK_QUEUE = "webhooks";

/** What a token's webhook can be told about: a duty reaching each status, or going away. */
export const WEBHOOK_EVENTS = ["queued", "active", "needs_decision", "blocked", "done", "failed", "deleted"];

/** How long what the provisioner recorded is believed, per isolate. */
const SETTINGS_TTL_MS = 60_000;

let settingsMemo = null;

/**
 * This deployment's webhook settings: the tasks instance its queue lives on, and where its console
 * is (for the link in each payload). Recorded by the provisioner in the datastore rather than as
 * function secrets, because hosted, secrets are only written from a signed-in altengine console and
 * the provisioner holds an API key.
 */
export async function webhookSettings(ctx) {
  const now = Date.now();
  if (settingsMemo && now - settingsMemo.at < SETTINGS_TTL_MS) return settingsMemo;
  const [hooks, deployment] = await Promise.all([
    ctx.store.get("settings", "webhooks").catch(() => null),
    ctx.store.get("settings", "deployment").catch(() => null),
  ]);
  const tasksInstance = ctx.cfg.tasksInstance || (hooks && typeof hooks.tasks_instance === "string" ? hooks.tasks_instance : "");
  const consoleUrl = ctx.cfg.consoleUrl || (deployment && typeof deployment.console_url === "string" ? deployment.console_url : "");
  settingsMemo = { at: now, tasksInstance, consoleUrl, ready: !!(ctx.env.tasks && tasksInstance) };
  return settingsMemo;
}

/** Why this URL cannot be a webhook, or "" when it can. The platform checks again when a task is
 *  added; this is so the owner hears it when they set the URL, not at the first delivery. */
export function urlProblem(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "'url' is not a URL";
  }
  if (u.protocol !== "https:") return "a webhook URL must be https";
  if (u.username || u.password) return "a webhook URL must not carry credentials — the signature is how the receiver knows it is us";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || /\.(localhost|internal|local)$/.test(host)) return `'${host}' is not a public hostname`;
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

/** A board's webhooks by token id, for the owner's token list. */
export async function webhooksOf(ctx, projectKey, limit) {
  const { rows } = await ctx.store.query("webhooks", { where: [{ field: "project_id", op: "=", value: projectKey }], limit });
  const out = new Map();
  for (const h of rows) out.set(h.key, { url: h.url, events: h.events || ["*"] });
  return out;
}

/** A revoked token's webhook goes with it. Deliveries already queued still go out. */
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

/** `POST /tokens/webhook` — set, change or (`url: null`) remove a token's webhook. */
export async function setWebhook(ctx, body) {
  const { id, project, hook } = await ownedToken(ctx, body);
  if (body.url === null || body.url === "") {
    await dropWebhook(ctx, id);
    return { ok: true, token_id: id, webhook_url: null };
  }
  const settings = await webhookSettings(ctx);
  if (!settings.ready) throw forbidden("this deployment has no task queue for webhooks — deploy it again with this version of dutyboard");
  const url = str(body.url, "url", { required: true, max: 2000 });
  const why = urlProblem(url);
  if (why) throw badRequest(why);
  const events = eventsFrom(body.events);
  const now = Date.now();
  await ctx.store.putOne("webhooks", id, { ...(hook || { created_at: now }), project_id: project.key, url, events, updated_at: now });
  return { ok: true, token_id: id, webhook_url: url, events };
}

/** `POST /tokens/webhook/test` — queue a `ping`, delivered exactly as an event would be. */
export async function testWebhook(ctx, body) {
  const { id, project, hook } = await ownedToken(ctx, body);
  if (!hook) throw conflict(`token '${id}' has no webhook to test`);
  const settings = await webhookSettings(ctx);
  if (!settings.ready) throw forbidden("this deployment cannot deliver webhooks — see /tokens/webhook");
  const now = Date.now();
  const name = `ping.${id.slice(0, 16)}.${now}`;
  await addTask(ctx, settings, name, hook.url, { id: name, type: "ping", created_at: now, board: project.key });
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
    // No queue, nothing to send — and no read on every transition of a deployment without one.
    if (!settings.ready) return;
    const duty = row || (await ctx.store.get("duties", dutyId));
    if (!duty || !duty.filed_by_token) return;
    const hook = await hookFor(ctx, duty.filed_by_token);
    if (!hook || !hook.url) return;
    const events = hook.events || ["*"];
    if (!events.includes("*") && !events.includes(status)) return;

    const now = Date.now();
    // The name makes a double publish of one transition one task, and is the event's `id`: the
    // same event retried keeps it.
    const name = status === "deleted" ? `${dutyId}.deleted` : `${dutyId}.${duty.updated_at || now}.${status}`;
    await addTask(ctx, settings, name, hook.url, {
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

async function addTask(ctx, settings, name, url, event) {
  const [res] = await ctx.env.tasks.add({ instance: settings.tasksInstance }, WEBHOOK_QUEUE, [{ name, payload: event, target: { webhook: url } }]);
  // A name already queued is the same event published twice — the point of naming it.
  if (res && res.ok === false && res.code !== "TASK_EXISTS") {
    throw new Error(`${res.code || "add failed"}: ${res.message || ""}`);
  }
}
