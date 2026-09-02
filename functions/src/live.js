// Live updates.
//
// Two channels, both published only from here:
//   board.<project_id>  every duty create/transition on that board
//   duty.<duty_id>      thread activity on one duty
//
// Payloads carry an id and a status and nothing else. The console re-reads through the
// access-controlled datastore path, so an event can never show someone a duty they are
// not allowed to read — which is what makes it safe for the payload to be this thin.
//
// Subscriber tokens are minted HERE rather than by the browser against the auth
// instance's channel rules, because the rule that matters is "does this person own this
// board", and a row-level rule cannot look up a project to find out. This is the case
// the docs describe as needing actual code.

import { badRequest, forbidden, str } from "./http.js";
import { requireHuman, resolveProject } from "./identity.js";

const TOKEN_TTL_SECONDS = 3600;
const MAX_DUTY_CHANNELS = 8;

export const boardChannel = (projectId) => `board.${projectId}`;
export const dutyChannel = (id) => `duty.${id}`;

/**
 * A publisher bound to one request. Failures are swallowed: live updates are an
 * enhancement, and a channel instance that is missing or briefly unreachable must never
 * turn a successful state transition into an error the agent has to retry.
 */
export function makePublisher(env, cfg) {
  if (!env.channel || !cfg.channelInstance) {
    return async () => {};
  }
  const target = { instance: cfg.channelInstance };
  return async function publish(projectId, dutyIdOrNull, payload) {
    const body = { ...payload, ts: Date.now() };
    const sends = [env.channel.publish(target, boardChannel(projectId), body)];
    if (dutyIdOrNull) sends.push(env.channel.publish(target, dutyChannel(dutyIdOrNull), body));
    try {
      await Promise.all(sends);
    } catch (err) {
      console.log("live publish failed (ignored):", err && err.message);
    }
  };
}

/**
 * `POST /live/token` — a subscribe-only token for one board and, optionally, the
 * duties the console currently has open.
 */
export async function liveToken(ctx, body) {
  requireHuman(ctx.caller);
  if (!ctx.env.channel || !ctx.cfg.channelInstance) {
    throw badRequest("live updates are not configured for this deployment");
  }
  const project = await resolveProject(ctx.caller, body.project_id, ctx.store);

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
