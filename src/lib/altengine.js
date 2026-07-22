// A small, dependency-free altengine browser client for END-USER (identity-token)
// access — the "Firestore-style" client path. The browser signs in against the auth
// instance, gets an `id_token`, and sends it as `Authorization: Bearer <id_token>` to
// the datastore and channel data planes. Row-level rules on the backend decide what
// each user may read/write, so there is no backend of our own and no org API key in
// the page.
//
// Contracts mirrored from the altengine data plane:
//   auth:      POST /v1/auth/<inst>/{signup,signin,token/refresh,signout,passwordless/*}
//   datastore: POST /v1/datastore/<inst>/ns/<ns>/col/<col>/{documents,documents/get,documents/delete,query}
//   channel:   POST /v1/channel/<inst>/tokens  +  WS /v1/channel/<inst>/subscribe?token=

import { config } from "../config.js";

const seg = (s) => encodeURIComponent(String(s));

// --- token storage -------------------------------------------------------
// id_token / refresh_token live in localStorage so a reload keeps the session.
// These are the end-user's OWN tokens (not a shared secret), which is exactly the
// model the auth service is built for.
const LS = {
  id: "dutyboard.id_token",
  refresh: "dutyboard.refresh_token",
  user: "dutyboard.user",
};

function loadSession() {
  try {
    const user = localStorage.getItem(LS.user);
    return {
      idToken: localStorage.getItem(LS.id) || null,
      refreshToken: localStorage.getItem(LS.refresh) || null,
      user: user ? JSON.parse(user) : null,
    };
  } catch {
    return { idToken: null, refreshToken: null, user: null };
  }
}

function saveSession(s) {
  try {
    if (s.idToken) localStorage.setItem(LS.id, s.idToken);
    else localStorage.removeItem(LS.id);
    if (s.refreshToken) localStorage.setItem(LS.refresh, s.refreshToken);
    else localStorage.removeItem(LS.refresh);
    if (s.user) localStorage.setItem(LS.user, JSON.stringify(s.user));
    else localStorage.removeItem(LS.user);
  } catch {
    /* private mode / storage full — session just won't persist */
  }
}

/** An error carrying the API's structured `{code,message}` and HTTP status. */
export class ApiError extends Error {
  constructor({ code, message, status, details }) {
    super(message || code || `HTTP ${status}`);
    this.name = "ApiError";
    this.code = code || "INTERNAL";
    this.status = status;
    this.details = details;
  }
}

let session = loadSession();

export function currentUser() {
  return session.user;
}
export function isSignedIn() {
  return !!session.idToken;
}

async function parseError(res) {
  let code, message, details;
  try {
    const body = await res.json();
    if (body && body.error) ({ code, message, details } = body.error);
  } catch {
    /* non-JSON body */
  }
  return new ApiError({ code, message, status: res.status, details });
}

// --- low-level request ----------------------------------------------------

async function raw(method, path, { body, bearer, headers } = {}) {
  const h = { ...(headers || {}) };
  if (bearer) h["authorization"] = "Bearer " + bearer;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(config.baseUrl + path, { method, headers: h, body: payload });
  if (res.status === 204) return undefined;
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// An authenticated request that transparently refreshes the id_token once on 401.
async function authed(method, path, opts = {}) {
  if (!session.idToken) throw new ApiError({ code: "UNAUTHENTICATED", message: "sign in first", status: 401 });
  try {
    return await raw(method, path, { ...opts, bearer: session.idToken });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && session.refreshToken) {
      await refresh();
      return raw(method, path, { ...opts, bearer: session.idToken });
    }
    throw err;
  }
}

// --- auth -----------------------------------------------------------------

const authBase = () => `/v1/auth/${seg(config.auth)}`;

/** Fetch the instance's public sign-in config (fields to collect, enabled methods). */
export async function authConfig() {
  return raw("GET", `${authBase()}/config`);
}

function applyTokens(t) {
  session = { idToken: t.id_token, refreshToken: t.refresh_token, user: t.user || session.user };
  saveSession(session);
  return session.user;
}

/** Create an account. `fields` is the identity field + any configured extras +
 * `password`. Returns the signed-in user. */
export async function signUp(fields) {
  const t = await raw("POST", `${authBase()}/signup`, { body: fields });
  return applyTokens(t);
}

/** Sign in with the identity field + password. Returns `{ user }` on success, or
 * `{ mfaRequired: true, mfaToken }` when the account has 2FA enabled. */
export async function signIn(identifier, password) {
  const t = await raw("POST", `${authBase()}/signin`, { body: { identifier, password } });
  if (t.mfa_required) return { mfaRequired: true, mfaToken: t.mfa_token };
  return { user: applyTokens(t) };
}

/** Complete a 2FA challenge started by signIn (TOTP or emailed code). */
export async function verifyMfa(mfaToken, code) {
  const t = await raw("POST", `${authBase()}/2fa/verify`, { body: { mfa_token: mfaToken, code } });
  return applyTokens(t);
}

/** Start passwordless sign-in: emails a one-time code. Always resolves (the server
 * never reveals whether the account exists). */
export async function passwordlessStart(identifier) {
  return raw("POST", `${authBase()}/passwordless/start`, { body: { identifier } });
}

/** Finish passwordless sign-in with the emailed code. */
export async function passwordlessVerify(identifier, code) {
  const t = await raw("POST", `${authBase()}/passwordless/verify`, { body: { identifier, code } });
  if (t.mfa_required) return { mfaRequired: true, mfaToken: t.mfa_token };
  return { user: applyTokens(t) };
}

/** Rotate the refresh token for a fresh id_token (also refreshes claims). */
export async function refresh() {
  if (!session.refreshToken) throw new ApiError({ code: "UNAUTHENTICATED", message: "no refresh token", status: 401 });
  const t = await raw("POST", `${authBase()}/token/refresh`, { body: { refresh_token: session.refreshToken } });
  session = { ...session, idToken: t.id_token, refreshToken: t.refresh_token };
  saveSession(session);
  return session.idToken;
}

/** Sign out: revoke the refresh token server-side and clear local state. */
export async function signOut() {
  const rt = session.refreshToken;
  session = { idToken: null, refreshToken: null, user: null };
  saveSession(session);
  if (rt) {
    try {
      await raw("POST", `${authBase()}/signout`, { body: { refresh_token: rt } });
    } catch {
      /* best-effort — local state is already cleared */
    }
  }
}

// --- datastore (identity-scoped) -----------------------------------------

const dsCol = (collection) =>
  `/v1/datastore/${seg(config.datastore)}/ns/${seg(config.namespace)}/col/${seg(collection)}`;

/** Query a collection. `req` = { where?, order?, limit?, cursor?, join? }.
 * Returns { documents: [{key,data,created,updated}], cursor }. Row-read rules on
 * the backend AND their owner filters into `where` automatically. */
export async function query(collection, req = {}) {
  return authed("POST", `${dsCol(collection)}/query`, { body: req });
}

/** Point-read documents by key. Returns { documents: [...] } (only rows you may read). */
export async function getDocs(collection, keys) {
  return authed("POST", `${dsCol(collection)}/documents/get`, { body: { keys } });
}

/** Upsert documents. `docs` = [{ key?, data }]. Server `stamp` rules overwrite
 * forge-proof fields (author_uid, author_name) from your token. Returns { keys }. */
export async function putDocs(collection, docs) {
  return authed("POST", `${dsCol(collection)}/documents`, { body: { documents: docs } });
}

/** Delete documents by key (owner-guarded on the backend). Returns { deleted }. */
export async function deleteDocs(collection, keys) {
  return authed("POST", `${dsCol(collection)}/documents/delete`, { body: { keys } });
}

// --- channel live ---------------------------------------------------------

/** Mint a subscribe-only token for the given channels (scoped by the auth
 * instance's channel access template). Returns { token, ws_url }. */
async function liveToken(channels) {
  return authed("POST", `/v1/channel/${seg(config.channel)}/tokens`, { body: { channels } });
}

/**
 * Subscribe to live change events for `channels` and call `onEvent(msg)` for each.
 * The datastore→channel bridge publishes minimal `{op,key,ns,collection}` payloads
 * on write; subscribers re-fetch through the access-controlled read path (a live
 * event can never leak a doc you couldn't read). Returns a `{ close() }` handle.
 *
 * Resilient-but-simple: one reconnect timer with capped backoff, re-mints the token
 * on every (re)connect. If the channel instance isn't configured, callers can ignore
 * the thrown error and fall back to manual refresh.
 */
export function subscribeLive(channels, onEvent, onState) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  const setState = (s) => onState && onState(s);

  async function connect() {
    if (closed) return;
    setState("connecting");
    let tok;
    try {
      tok = await liveToken(channels);
    } catch (err) {
      setState("error");
      scheduleReconnect();
      return;
    }
    // The mint's `ws_url` ALREADY carries `?token=...`, so parse and only add the token if
    // it's missing (the fallback URL has none). Blindly appending `?token=` would produce
    // `...subscribe?token=A?token=B`, corrupting the token → a 401 handshake and no live
    // updates. Mirrors how @altengine/sdk's ChannelSocket builds the URL.
    let raw = tok.ws_url;
    if (!raw) {
      const wsBase = config.baseUrl.replace(/^http/, "ws");
      raw = `${wsBase}/v1/channel/${seg(config.channel)}/subscribe`;
    }
    const u = new URL(raw);
    if (!u.searchParams.has("token")) u.searchParams.set("token", tok.token);
    try {
      ws = new WebSocket(u.toString());
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      setState("open");
      ws.send(JSON.stringify({ type: "subscribe", channels }));
    };
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      // A pub/sub delivery is a plain { channel, data, ts } frame (no `type`);
      // control acks (subscribed/error/...) carry a `type` and are ignored here.
      if (frame && typeof frame.channel === "string" && frame.type === undefined) onEvent(frame);
    };
    ws.onclose = () => {
      if (!closed) scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    attempt++;
    const delay = Math.min(500 * 2 ** (attempt - 1), 15000);
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setState("closed");
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
