// Request/response plumbing shared by the REST router and the MCP endpoint.
//
// Everything a handler can go wrong with is thrown as an `HttpError`, so the two
// front doors (REST and JSON-RPC) can each render the same failure in their own
// dialect without every handler knowing which one called it.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, "INVALID_ARGUMENT", msg, details);
export const unauthorized = (msg) => new HttpError(401, "UNAUTHENTICATED", msg || "missing or invalid credentials");
export const forbidden = (msg) => new HttpError(403, "PERMISSION_DENIED", msg || "not permitted");
export const notFound = (msg) => new HttpError(404, "NOT_FOUND", msg || "not found");
/** The single-active-duty invariant and every other "the board moved under you" case. */
export const conflict = (msg, details) => new HttpError(409, "CONFLICT", msg, details);

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(err, requestId) {
  const e = err instanceof HttpError ? err : null;
  const status = e ? e.status : 500;
  // A non-HttpError is a bug in this function, not something the caller can fix — say so
  // without leaking the stack, and hand back the request id the platform stamped so the
  // failure can be found in the error groups.
  const body = {
    error: {
      code: e ? e.code : "INTERNAL",
      message: e ? e.message : "internal error",
      ...(e && e.details ? { details: e.details } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
  return json(body, status);
}

/** Parse a JSON body, tolerating an empty one (a POST with no payload is a valid call). */
export async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("body must be JSON");
  }
}

// --- field coercion -------------------------------------------------------
// Agents generate these payloads, and a model that emits `priority: "urgent"` should
// get a message naming the values that exist rather than a row with a priority nothing
// will ever schedule.

export function str(v, field, { required = false, max = 4000, fallback = "" } = {}) {
  if (v == null || v === "") {
    if (required) throw badRequest(`'${field}' is required`);
    return fallback;
  }
  if (typeof v !== "string") throw badRequest(`'${field}' must be a string`);
  const s = v.trim();
  if (required && !s) throw badRequest(`'${field}' is required`);
  if (s.length > max) throw badRequest(`'${field}' must be at most ${max} characters`);
  return s;
}

export function oneOf(v, field, allowed, fallback) {
  if (v == null || v === "") {
    if (fallback !== undefined) return fallback;
    throw badRequest(`'${field}' is required (one of: ${allowed.join(", ")})`);
  }
  if (!allowed.includes(v)) throw badRequest(`'${field}' must be one of: ${allowed.join(", ")}`);
  return v;
}

export function intIn(v, field, min, max, fallback) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`'${field}' must be a number`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Truncate for the token-frugal payloads — poll and claim answer into an agent's context. */
export function clip(s, n) {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}
