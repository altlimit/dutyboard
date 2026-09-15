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
  reopenDuty,
  updateDuty,
  deleteDuty,
  listThread,
  getDuty,
} from "./duties.js";
import { handleMcp } from "./mcp.js";
import { addMember, listMembers, removeMember, setMemberAgents, syncAccess } from "./members.js";
import { reindexBoard, searchConfigured, searchDuties } from "./searching.js";
import { getProfile, updateProfile, proposeProfile, getRules, setRules, acceptRules, submitRules } from "./profile.js";
import {
  startPairing,
  pollPairing,
  lookupPairing,
  approvePairing,
  denyPairing,
  listMachines,
  updateMachine,
  revokeMachine,
  unlinkMachineByPerson,
  boardRunners,
  machineMe,
  machineBoards,
  createMachineBoard,
  linkMachine,
  unlinkMachine,
  reportState,
  pollMachine,
  machineLive,
  requestSetup,
  reportRequest,
  noteMachineUse,
} from "./machines.js";
import { VERSION } from "./version.js";



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
    searchInstance: env.DUTYBOARD_SEARCH || "dutyboard-search",
    // Where the console is served, for a daemon that has just started pairing and needs to tell a
    // person where to approve it. The function cannot work this out: the console is a static site
    // anywhere, and this is only ever called by the thing it serves.
    consoleUrl: env.DUTYBOARD_CONSOLE_URL || "",
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
  "/duty/reopen": reopenDuty,
  "/duty/update": updateDuty,
  "/duty/delete": deleteDuty,
  "/duty/thread": listThread,
  "/duty/get": getDuty,
  "/duty/search": searchDuties,
  "/duty/attach": attachToDuty,
  "/duty/attachments": listAttachments,
  "/duty/attachment/delete": deleteAttachment,
  "/board/open": openBoard,
  "/board/reindex": reindexBoard,
  "/board/members/list": listMembers,
  "/board/members/add": addMember,
  "/board/members/remove": removeMember,
  "/board/members/agents": setMemberAgents,
  "/board/profile": getProfile,
  "/board/runners": boardRunners,
  "/board/profile/propose": proposeProfile,
  "/board/rules": getRules,
  "/board/rules/set": setRules,
  "/board/rules/accept": acceptRules,
  "/board/rules/submit": submitRules,
  "/me/access": syncAccess,
  "/projects/create": createProject,
  "/projects/list": listProjects,
  "/projects/rename": renameProject,
  "/projects/delete": deleteProject,
  "/projects/profile": updateProfile,
  "/tokens/mint": createToken,
  "/tokens/list": listTokens,
  "/tokens/revoke": revokeToken,
  "/live/token": liveToken,
  "/connect/lookup": lookupPairing,
  "/connect/approve": approvePairing,
  "/connect/deny": denyPairing,
  "/machines/list": listMachines,
  "/machines/update": updateMachine,
  "/machines/revoke": revokeMachine,
  "/machines/unlink": unlinkMachineByPerson,
  "/machine/me": machineMe,
  "/machine/boards": machineBoards,
  "/machine/boards/create": createMachineBoard,
  "/machine/link": linkMachine,
  "/machine/unlink": unlinkMachine,
  "/machine/state": reportState,
  "/machine/poll": pollMachine,
  "/machine/live": machineLive,
  "/machine/request": requestSetup,
  "/machine/request/report": reportRequest,
};

/**
 * The two routes that take no credential, because the thing calling them does not have one yet: a
 * daemon starting a pairing, and the same daemon asking whether it has been approved. The device
 * code it holds is the credential for the second.
 */
const PUBLIC_ROUTES = {
  "/connect/start": startPairing,
  "/connect/poll": pollPairing,
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
export const ROUTE_PATHS = [...Object.keys(ROUTES), ...Object.keys(PUBLIC_ROUTES)];

/**
 * Bodies big enough to carry an inline attachment, for the two doors that can receive one.
 *
 * Everything else is held to the default in http.js, which is small on purpose: no other
 * endpoint has a field that could legitimately be megabytes, and `request.text()` buffers
 * whatever arrives before any per-field cap can look at it.
 */
/** Comfortably above base64 of MAX_INLINE_BYTES (2MB raw ≈ 2.7MB encoded), so an oversized
 *  inline upload is refused by the attachment limit — which says to use the upload_url and
 *  how big that path takes — rather than by a body limit, which says only "too big". */
const ATTACH_BODY_BYTES = 4 * 1024 * 1024;

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

/**
 * Where the provisioner published this deployment's console, as it recorded it in the datastore
 * (`settings/deployment`). Not a function secret: hosted, secrets are only written from a signed-in
 * altengine console, and the provisioner holds an API key. Browsers cannot read the row — the
 * access rules name no `settings` collection. Memoised per isolate once found, like the index
 * checks below; a miss is asked again, since the provisioner writes it after deploying this code.
 */
let consoleUrlMemo = null;
async function recordedConsoleUrl(store) {
  if (consoleUrlMemo) return consoleUrlMemo;
  try {
    const doc = await store.get("settings", "deployment");
    const url = doc && (doc.data?.console_url || doc.console_url);
    if (typeof url === "string" && /^https?:\/\//.test(url)) consoleUrlMemo = url;
  } catch {
    // No row, or no datastore yet: the answer is "not recorded", not an unhealthy function.
  }
  return consoleUrlMemo;
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
      // Memoised per isolate (see store.ensureUniqueIndex), so a monitor polling this every
      // minute costs one datastore call per cold start and nothing after.
      const health = makeStore(env, cfg.datastoreInstance, cfg.datastoreNamespace);
      return json({
        ok: true,
        service: "dutyboard",
        version: VERSION,
        // The MCP path, relative to this function — the prefix in front of it depends on
        // where it is deployed, which is exactly what routePath above exists to absorb.
        mcp: "/mcp",
        attachments: !!(env.blob && cfg.blobInstance),
        // Whether finished work is findable. Optional like the others: a board without it
        // works, it just cannot answer "have we done this before".
        search: !!(env.search && cfg.searchInstance),
        // Whether a `dutyboard` daemon can pair with this deployment, and where to send the person
        // who approves it.
        machines: true,
        console_url: cfg.consoleUrl || (await recordedConsoleUrl(health)),
        // Whether the constraint that stops two agents holding one duty is actually in
        // place. It is created on demand, so it can fail — and a mutex that is silently
        // absent is worse than one nobody claimed to have.
        single_holder: await Promise.all([
          health.ensureUniqueIndex("agents", ["active_duty_id"]),
          health.ensureUniqueIndex("duties", ["holder"]),
        ])
          .then((r) => r.every(Boolean))
          .catch(() => false),
      });
    }

    try {
      const cfg = configure(env);
      const store = makeStore(env, cfg.datastoreInstance, cfg.datastoreNamespace);

      const open = PUBLIC_ROUTES[path];
      if (open) {
        if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", `use POST for '${path}'`);
        return json(await open({ env, cfg, store, caller: { kind: "anonymous" }, requestId }, await readJson(request)));
      }

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
      await noteMachineUse(ctx, caller);

      if (path === "/mcp") return await handleMcp(ctx, request, ATTACH_BODY_BYTES);

      const handler = ROUTES[path];
      if (!handler) throw notFound(`no route '${path}' — see /health`);
      if (request.method !== "POST") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `use POST for '${path}'`);
      }

      const body = await readJson(request, path === "/duty/attach" ? { max: ATTACH_BODY_BYTES } : undefined);
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
