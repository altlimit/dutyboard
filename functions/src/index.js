// DutyBoard — the whole server.
//
// One altengine function, deployed as `board`, so every route in the spec lives under
// the URL the console shows you:
//
//   https://<subdomain>-fn.altengine.app/board/duty/poll      (hosted)
//   http://127.0.0.1:9191/fn/<instance>/board/duty/poll       (altengine dev)
//
// The name is `board` and not `api` because the platform reserves `api` on a function
// host: the console's own SPA makes relative calls to /api/auth/*, so a tenant function
// answering there could be lured into serving them. A deploy named `api` is refused —
// hosted only, which is exactly the kind of difference the emulator will not show you.
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
import { openBoard, createProject, listProjects, renameProject, deleteProject } from "./projects.js";
import { attachToDuty, listAttachments, deleteAttachment } from "./attachments.js";
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
    blobInstance: env.DUTYBOARD_BLOB || "dutyboard-files",
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
  "/duty/attach": attachToDuty,
  "/duty/attachments": listAttachments,
  "/duty/attachment/delete": deleteAttachment,
  "/board/open": openBoard,
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
 * Every path this function answers, exported so a test can be DERIVED from the real table
 * rather than from a list someone has to remember to update.
 *
 * The cross-tenant matrix in scripts/smoke.mjs reads this: a route added without an entry
 * there fails the suite. That is not hypothetical caution — `/duty/thread` shipped with no
 * ownership check at all and was found by hand, months later, because nothing forced the
 * question to be asked for each new endpoint.
 */
export const ROUTE_PATHS = Object.keys(ROUTES);

/**
 * The path below this function, in both deployments.
 *
 * Hosted, the function name is the first segment (`/board/duty/poll`). Locally there are
 * no per-instance subdomains, so it is `/fn/<instance>/board/duty/poll`. The name itself
 * comes from `x-ae-fn`, so this keeps working whatever the function is deployed as —
 * reading the path off the request rather than assuming a prefix is what makes one
 * bundle work in both.
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
      // Capabilities, not configuration: whether attachments work here is decided by the
      // deploy (a blob grant and an instance name), and it is the one thing about this
      // function a console cannot find out by looking at itself — the browser never names
      // the blob instance, it only ever asks this function for an upload URL. The name is
      // deliberately not reported; whether it exists is the useful half.
      const cfg = configure(env);
      return json({
        ok: true,
        service: "dutyboard",
        version: VERSION,
        // The MCP path, relative to this function — the prefix in front of it depends on
        // where it is deployed, which is exactly what routePath above exists to absorb.
        mcp: "/mcp",
        attachments: !!(env.blob && cfg.blobInstance),
      });
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
        publish: makePublisher(env, cfg, request.headers.get("x-dutyboard-origin") || ""),
      };
      // Fire-and-forget in spirit; awaited because a function has no waitUntil. It
      // writes at most once a minute per token, so it is not on the hot path.
      await noteTokenUse(ctx, caller);

      if (path === "/mcp") return await handleMcp(ctx, request);

      const handler = ROUTES[path];
      if (!handler) throw notFound(`no route '${path}' — see /health`);
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
