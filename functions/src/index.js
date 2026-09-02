// DutyBoard — the whole server.
//
// One altengine function, deployed as `api`, so every route in the spec lives under the
// URL the console shows you:
//
//   https://<subdomain>-fn.altengine.app/api/duty/poll        (hosted)
//   http://127.0.0.1:9191/fn/<instance>/api/duty/poll         (altengine dev)
//
// Why a function and not direct datastore access from the browser: every transition
// here writes more than one collection at once — claiming a duty touches the duty and
// the agent row together, an interrupt moves a parent to `blocked` while creating its
// child — and row-level rules scope to one collection per request. That work is
// structurally unreachable from an end-user token, which is exactly what functions are
// for. The console reads the board directly (row rules, live over a channel) and posts
// every change back through here.

import { HttpError, errorResponse, json, readJson, notFound, str } from "./http.js";
import { makeStore } from "./store.js";
import { identify } from "./identity.js";
import { makePublisher, liveToken } from "./live.js";
import { noteTokenUse, createToken, listTokens, revokeToken } from "./tokens.js";
import { createProject, listProjects, renameProject, deleteProject } from "./projects.js";
import {
  pollDuties,
  claimDuty,
  enqueueDuty,
  checkpointDuty,
  completeDuty,
  failDuty,
  resolveDuty,
  updateDuty,
  deleteDuty,
  listThread,
} from "./duties.js";
import { handleMcp } from "./mcp.js";

const VERSION = "2.0.0";

/** Instance names are configuration, not constants: the same bundle serves a hosted
 *  deployment and a local emulator whose instances are named differently. Set them as
 *  `env`-exposure secrets on the functions instance to override. */
function configure(env) {
  return {
    datastoreInstance: env.DUTYBOARD_DATASTORE || "dutyboard",
    datastoreNamespace: env.DUTYBOARD_NAMESPACE || "",
    authInstance: env.DUTYBOARD_AUTH || "dutyboard-auth",
    channelInstance: env.DUTYBOARD_CHANNEL || "dutyboard-live",
  };
}

// Handlers are (ctx, body) -> JSON-serialisable result. Anything they throw that is an
// HttpError becomes that status; anything else is a 500 with the request id.
const ROUTES = {
  "/duty/poll": pollDuties,
  "/duty/claim": claimDuty,
  "/duty/enqueue": enqueueDuty,
  "/duty/checkpoint": checkpointDuty,
  "/duty/complete": completeDuty,
  "/duty/fail": failDuty,
  "/duty/resolve": resolveDuty,
  "/duty/update": updateDuty,
  "/duty/delete": deleteDuty,
  "/duty/thread": listThread,
  "/projects/create": createProject,
  "/projects/list": listProjects,
  "/projects/rename": renameProject,
  "/projects/delete": deleteProject,
  "/tokens/mint": createToken,
  "/tokens/list": listTokens,
  "/tokens/revoke": revokeToken,
  "/live/token": liveToken,
};

/**
 * The path below this function, in both deployments.
 *
 * Hosted, the function name is the first segment (`/api/duty/poll`). Locally there are
 * no per-instance subdomains, so it is `/fn/<instance>/api/duty/poll`. Reading the path
 * off the URL rather than assuming a prefix is what makes one bundle work in both.
 */
function routePath(url, fnName) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "fn" && parts.length >= 3) return "/" + parts.slice(3).join("/");
  if (fnName && parts[0] === fnName) return "/" + parts.slice(1).join("/");
  return "/" + parts.join("/");
}

/**
 * Which agent is calling, when the call itself does not say.
 *
 * An MCP client sends the same tool arguments the model produced, and making the model
 * remember its own agent id on every call is a reliable way to get three different ones.
 * So the connection can carry it: `?agent=alpha` in the server URL, an
 * `x-dutyboard-agent` header, or a default recorded on the token itself.
 */
function defaultAgentId(url, request, caller) {
  return (
    url.searchParams.get("agent") ||
    request.headers.get("x-dutyboard-agent") ||
    (caller.kind === "agent" ? caller.defaultAgentId : "") ||
    ""
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-ae-request-id") || "";
    const path = routePath(url, request.headers.get("x-ae-fn"));

    // Unauthenticated, so a deploy can be checked before any credential exists.
    if (path === "/health" || path === "/") {
      return json({ ok: true, service: "dutyboard", version: VERSION, mcp: "/api/mcp" });
    }

    try {
      const cfg = configure(env);
      const store = makeStore(env, cfg.datastoreInstance, cfg.datastoreNamespace);
      const caller = await identify(request, env, cfg, store);
      const ctx = {
        env,
        cfg,
        store,
        caller,
        requestId,
        defaultAgentId: defaultAgentId(url, request, caller),
        publish: makePublisher(env, cfg),
      };
      // Fire-and-forget in spirit; awaited because a function has no waitUntil. It
      // writes at most once a minute per token, so it is not on the hot path.
      await noteTokenUse(ctx, caller);

      if (path === "/mcp") return await handleMcp(ctx, request);

      const handler = ROUTES[path];
      if (!handler) throw notFound(`no route '${path}' — see /api/health`);
      if (request.method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `use POST for '${path}'`);
      }

      const body = await readJson(request);
      // A `project_id` in the query string is a convenience for curl and for the
      // console's own links; the body wins where both are present.
      if (!body.project_id && url.searchParams.get("project_id")) {
        body.project_id = str(url.searchParams.get("project_id"), "project_id", { max: 60 });
      }
      return json(await handler(ctx, body));
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.log("unhandled:", request.method, path, err && (err.stack || err.message));
      }
      return errorResponse(err, requestId);
    }
  },
};
