// Live updates.
//
// Two channels, both published only from here:
//   board.<project_id>  every duty create/transition on that board
//   duty.<duty_id>      thread activity on one duty
//
// Payloads carry an id and a status and no duty CONTENT. The console re-reads through the
// access-controlled datastore path, so an event can never show someone a duty they are
// not allowed to read — which is what makes it safe for the payload to be this thin.
//
// The one addition is `ag`: the four transitions that move an agent row carry that row's
// three visible fields, so the console can patch its agent strip instead of querying the
// agents collection on every event. It is exempt because it is not a duty and not a
// secret — only a board's own owner can subscribe at all — and because the strip is
// decoration, where a card is not.
//
// Subscriber tokens are minted HERE rather than by the browser against the auth
// instance's channel rules, because the rule that matters is "does this person own this
// board", and a row-level rule cannot look up a project to find out. This is the case
// the docs describe as needing actual code.

import { badRequest, forbidden, str } from "./http.js";
import { requireHuman, resolveProject } from "./identity.js";

const TOKEN_TTL_SECONDS = 3600;
const MAX_DUTY_CHANNELS = 8;

/** A daemon's socket lives as long as its token, and the platform closes it at expiry. Four hours
 *  is the platform's ceiling; the daemon rotates before it rather than reconnecting after. */
const MACHINE_TOKEN_TTL_SECONDS = 14400;

export const boardChannel = (projectId) => `board.${projectId}`;
export const dutyChannel = (id) => `duty.${id}`;

/**
 * One daemon's own channel: commands only the server publishes — set a project up, pause, resume,
 * re-mint your token, you are revoked. Work does NOT arrive here; it arrives on the board
 * channels the daemon already watches, which is what the console listens to as well.
 */
export const machineChannel = (id) => `machine.${id}`;

/** Publish to a machine's channel. Best-effort for the same reason board events are: the daemon
 *  re-checks everything on reconnect and every fifteen minutes, so a lost command is late, not
 *  lost. */
export async function publishMachine(ctx, machineId, payload) {
  if (!liveConfigured(ctx)) return;
  try {
    await ctx.env.channel.publish({ instance: ctx.cfg.channelInstance }, machineChannel(machineId), { ...payload, ts: Date.now() });
  } catch (err) {
    console.log("machine publish failed (ignored):", err && err.message);
  }
}

/**
 * Which of these machines has a socket open right now. `true`/`false` per id, or `null` for all
 * of them when presence cannot be asked — the channel instance has it switched off, or there is
 * no channel at all. Callers treat null as "unknown" and fall back to time.
 */
export async function machinesPresent(ctx, machineIds) {
  const out = new Map();
  if (!liveConfigured(ctx) || typeof ctx.env.channel.presence !== "function") {
    for (const id of machineIds) out.set(id, null);
    return out;
  }
  await Promise.all(
    [...new Set(machineIds)].map(async (id) => {
      try {
        const snap = await ctx.env.channel.presence({ instance: ctx.cfg.channelInstance }, machineChannel(id));
        out.set(id, !!(snap && snap.occupancy > 0));
      } catch {
        out.set(id, null);
      }
    }),
  );
  return out;
}

/** A subscribe-only token for a daemon: its own channel and the board channel of every board it
 *  is linked to. Presence is the machine id, which is what makes "runner online" answerable. */
export async function mintMachineLive(ctx, machineId, projectIds) {
  const channels = [machineChannel(machineId), ...projectIds.map(boardChannel)];
  const minted = await ctx.env.channel.token(
    { instance: ctx.cfg.channelInstance },
    { channels, ttlSeconds: MACHINE_TOKEN_TTL_SECONDS, presenceId: machineId },
  );
  return { ...minted, channels };
}

/**
 * A publisher bound to one request. Failures are swallowed: live updates are an
 * enhancement, and a channel instance that is missing or briefly unreachable must never
 * turn a successful state transition into an error the agent has to retry.
 */
export function makePublisher(env, cfg, origin) {
  if (!env.channel || !cfg.channelInstance) {
    return async () => {};
  }
  const target = { instance: cfg.channelInstance };
  return async function publish(projectId, dutyIdOrNull, payload) {
    // `o` is the caller's own origin id, echoed back to it.
    //
    // A page that writes something already reloads to see the result, and then its own
    // event arrives and it reloads again — every action costing two round trips of reads
    // instead of one. With this the page can recognise the echo of its own write and
    // ignore it, while everyone else's tab still refreshes. It is an opaque string chosen
    // by the client: it identifies a tab, not a person, and it is only ever compared for
    // equality by the tab that sent it.
    const body = { ...payload, ts: Date.now(), ...(origin ? { o: origin } : {}) };
    const sends = [env.channel.publish(target, boardChannel(projectId), body)];
    if (dutyIdOrNull) sends.push(env.channel.publish(target, dutyChannel(dutyIdOrNull), body));
    try {
      await Promise.all(sends);
    } catch (err) {
      console.log("live publish failed (ignored):", err && err.message);
    }
  };
}

/** Is a channel configured at all? Live updates are optional; everything else works. */
export const liveConfigured = (ctx) => !!(ctx.env.channel && ctx.cfg.channelInstance);

/**
 * Mint a subscribe-only token for a board the caller already owns, and optionally for
 * some of its duties.
 *
 * Split out of the endpoint below so `/board/open` can hand back a token in the same
 * response as the board itself, rather than the page making a second call for it.
 */
export async function mintLive(ctx, project, body) {
  const requested = Array.isArray(body.duty_ids) ? body.duty_ids.slice(0, MAX_DUTY_CHANNELS) : [];
  const dutyIds = requested.map((d, i) => str(d, `duty_ids[${i}]`, { required: true, max: 64 }));

  // Every duty channel is checked against the board the caller owns. Skipping this would
  // let an owner of any board subscribe to any duty on any other.
  if (dutyIds.length) {
    const found = await ctx.store.getMany("duties", dutyIds);
    for (const id of dutyIds) {
      const duty = found.get(id);
      if (!duty || duty.project_id !== project.key) throw forbidden(`duty '${id}' is not on this board`);
    }
  }

  const channels = [boardChannel(project.key), ...dutyIds.map(dutyChannel)];
  const minted = await ctx.env.channel.token(
    { instance: ctx.cfg.channelInstance },
    { channels, ttlSeconds: TOKEN_TTL_SECONDS, presenceId: ctx.caller.uid },
  );
  return { ...minted, channels };
}

/**
 * `POST /live/token` — a subscribe-only token for one board and, optionally, the
 * duties the console currently has open.
 *
 * Still its own endpoint because a socket that drops re-mints on reconnect, and that is
 * all it needs then.
 */
export async function liveToken(ctx, body) {
  requireHuman(ctx.caller);
  if (!liveConfigured(ctx)) throw badRequest("live updates are not configured for this deployment");
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);
  return mintLive(ctx, project, body);
}
