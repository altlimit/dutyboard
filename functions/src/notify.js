// Telling people a duty needs them.
//
// Two ways, both started by the same moment — a duty parked on a question (`needs_decision`):
//
//   live   an event on the person's own channel, `user.<uid>`. Any console tab they have open, on
//          any board or none, turns it into a browser notification. Nothing to set up.
//   push   Web Push to every device they turned it on for, so it arrives with no tab open, and on a
//          phone. The subscriptions are theirs: stored here by uid, readable by no browser rule.
//
// Everyone who can see the board is told — its owner and its members — except the person who parked
// it themselves.

import { HttpError, badRequest, str } from "./http.js";
import { requireHuman } from "./identity.js";
import { sha256Hex } from "./ids.js";
import { liveConfigured } from "./live.js";
import { isPushEndpoint, makeVapidKeys, sendPush } from "./webpush.js";

export const userChannel = (uid) => `user.${uid}`;

/** Devices one person may have push on. A phone, a laptop, a work machine — with room to spare. */
const MAX_DEVICES = 10;

/** How long a push waits for its push service before the request that caused it moves on. */
const PUSH_TIMEOUT_MS = 4000;

// --- the VAPID key -------------------------------------------------------------------------

let vapidMemo = null;

/**
 * This deployment's VAPID keys, made on first use. Two first uses at once can each write a pair; both
 * read back what was stored last, so they agree, and a subscription made against the loser's key
 * would fail its first push and be forgotten — the device turns it on again.
 */
export async function vapidKeys(ctx) {
  if (vapidMemo) return vapidMemo;
  let doc = await ctx.store.get("settings", "webpush");
  if (!doc || !doc.public_key) {
    let made;
    try {
      made = await makeVapidKeys();
    } catch (err) {
      // The local emulator implements only digest of Web Crypto; hosted altengine has all of it.
      throw new HttpError(501, "NOT_IMPLEMENTED", `push notifications need Web Crypto, which this altengine does not provide (${err && err.message})`);
    }
    await ctx.store.putOne("settings", "webpush", { ...made, created_at: Date.now() });
    doc = await ctx.store.get("settings", "webpush");
  }
  vapidMemo = { public_key: doc.public_key, private_jwk: doc.private_jwk };
  return vapidMemo;
}

// --- endpoints -----------------------------------------------------------------------------

/** `POST /push/key` — the public key a browser subscribes with. */
export async function pushKey(ctx) {
  requireHuman(ctx.caller);
  return { public_key: (await vapidKeys(ctx)).public_key };
}

/** `POST /push/subscribe` — `{ subscription: { endpoint, keys: { p256dh, auth } }, label? }`. */
export async function pushSubscribe(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const sub = body.subscription && typeof body.subscription === "object" ? body.subscription : {};
  const endpoint = str(sub.endpoint, "subscription.endpoint", { required: true, max: 1000 });
  if (!isPushEndpoint(endpoint)) throw badRequest("that is not a push service this deployment sends to");
  const keys = sub.keys && typeof sub.keys === "object" ? sub.keys : {};
  const p256dh = str(keys.p256dh, "subscription.keys.p256dh", { required: true, max: 200 });
  const auth = str(keys.auth, "subscription.keys.auth", { required: true, max: 100 });

  const key = await sha256Hex(endpoint);
  const existing = await ctx.store.get("push_subscriptions", key);
  if (!existing) {
    const { rows } = await ctx.store.query("push_subscriptions", {
      where: [{ field: "uid", op: "=", value: caller.uid }],
      limit: MAX_DEVICES + 1,
      keys_only: true,
    });
    if (rows.length >= MAX_DEVICES) throw badRequest(`you already get notifications on ${MAX_DEVICES} devices — turn one off first`);
  }
  await ctx.store.putOne("push_subscriptions", key, {
    uid: caller.uid,
    endpoint,
    p256dh,
    auth,
    label: str(body.label, "label", { max: 120 }),
    created_at: (existing && existing.created_at) || Date.now(),
    updated_at: Date.now(),
  });
  return { ok: true };
}

/** `POST /push/unsubscribe` — `{ endpoint }`. Only the caller's own. */
export async function pushUnsubscribe(ctx, body) {
  const caller = requireHuman(ctx.caller);
  const endpoint = str(body.endpoint, "endpoint", { required: true, max: 1000 });
  const key = await sha256Hex(endpoint);
  const existing = await ctx.store.get("push_subscriptions", key);
  if (existing && existing.uid === caller.uid) await ctx.store.delete("push_subscriptions", [key]);
  return { ok: true, removed: !!(existing && existing.uid === caller.uid) };
}

/** `POST /push/test` — a notification to every device the caller has push on, and their open tabs. */
export async function pushTest(ctx) {
  const caller = requireHuman(ctx.caller);
  const payload = { t: "test", title: "DutyBoard", body: "Notifications work on this device.", url: "#/" };
  const [pushed] = await Promise.all([pushTo(ctx, caller.uid, payload, "test"), liveTo(ctx, caller.uid, payload)]);
  return { ok: true, ...pushed };
}

/** `POST /live/me` — a subscribe-only token for the caller's own channel. */
export async function liveMe(ctx) {
  const caller = requireHuman(ctx.caller);
  if (!liveConfigured(ctx)) throw badRequest("live updates are not configured for this deployment");
  const channels = [userChannel(caller.uid)];
  const minted = await ctx.env.channel.token({ instance: ctx.cfg.channelInstance }, { channels, ttlSeconds: 3600, presenceId: caller.uid });
  return { ...minted, channels };
}

// --- sending -------------------------------------------------------------------------------

async function liveTo(ctx, uid, payload) {
  if (!liveConfigured(ctx)) return;
  try {
    await ctx.env.channel.publish({ instance: ctx.cfg.channelInstance }, userChannel(uid), { ...payload, ts: Date.now() });
  } catch (err) {
    console.log("user publish failed (ignored):", err && err.message);
  }
}

/** Push to every device `uid` has on. Forgets subscriptions their push service says are gone. */
async function pushTo(ctx, uid, payload, topic) {
  const { rows } = await ctx.store.query("push_subscriptions", {
    where: [{ field: "uid", op: "=", value: uid }],
    limit: MAX_DEVICES,
  });
  if (!rows.length) return { devices: 0, delivered: 0 };
  let keys;
  try {
    keys = await vapidKeys(ctx);
  } catch (err) {
    console.log("push unavailable (ignored):", err && err.message);
    return { devices: rows.length, delivered: 0 };
  }
  const subject = ctx.cfg.consoleUrl || "https://github.com/altlimit/dutyboard";
  let delivered = 0;
  await Promise.all(
    rows.map(async (row) => {
      const sub = row;
      try {
        const res = await withTimeout(sendPush(sub, payload, keys, { subject, topic }), PUSH_TIMEOUT_MS);
        if (res.ok) delivered++;
        else if (res.gone) await ctx.store.delete("push_subscriptions", [row.key]);
        else console.log(`push to a device of ${uid} answered ${res.status}`);
      } catch (err) {
        // A push service being slow, or this function not being allowed to reach it, must not fail the
        // write that parked the duty.
        console.log("push failed (ignored):", err && err.message);
      }
    }),
  );
  return { devices: rows.length, delivered };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms))]);

/**
 * A duty on `project` is waiting on a person: tell everyone who can see the board, but the caller.
 * Never throws — being told is a courtesy; the duty is already parked.
 */
export async function notifyNeedsYou(ctx, project, duty, question) {
  try {
    const uids = new Set([project.owner_uid]);
    const { rows } = await ctx.store.query("memberships", {
      where: [{ field: "project_id", op: "=", value: project.key }],
      limit: 50,
    });
    for (const r of rows) {
      if (r.uid) uids.add(r.uid);
    }
    if (ctx.caller.kind === "human") uids.delete(ctx.caller.uid);
    if (!uids.size) return;
    // The project a duty write resolves carries only its key and owner: the name is one read more,
    // paid only when someone is about to be told.
    const name = project.name || ((await ctx.store.get("projects", project.key)) || {}).name || project.key;

    const payload = {
      t: "needs_you",
      title: `Needs you · ${name}`,
      body: clip(`${duty.title}: ${question}`, 240),
      project_id: project.key,
      duty_id: duty.key,
      url: `#/b/${encodeURIComponent(project.key)}/d/${encodeURIComponent(duty.key)}`,
    };
    await Promise.all([...uids].map((uid) => Promise.all([liveTo(ctx, uid, payload), pushTo(ctx, uid, payload, duty.key)])));
  } catch (err) {
    console.log("notifying failed (ignored):", err && err.message);
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
