// The browser's half of DutyBoard.
//
// Three things, and the split between them is the whole architecture:
//
//   auth       sign up / sign in against /v1/auth/<instance>. The id_token that comes
//              back is kept in localStorage and sent as a bearer on everything below.
//   datastore  READS ONLY, straight from the browser. Row rules on the auth instance
//              AND `owner_uid = you` into every query server-side, so the page just asks
//              for what it wants and cannot see anyone else's board.
//   api        every WRITE, through the function. A duty transition touches more than
//              one collection at once, which a row rule cannot scope — so the state
//              machine lives on the server and the page posts intentions to it.
//
// There is no API key here, and no backend of our own.

import { config } from "../config.js";

const seg = (s) => encodeURIComponent(String(s));

const LS = { id: "dutyboard.id_token", refresh: "dutyboard.refresh_token", user: "dutyboard.user" };

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
    for (const [k, v] of [
      [LS.id, s.idToken],
      [LS.refresh, s.refreshToken],
      [LS.user, s.user ? JSON.stringify(s.user) : null],
    ]) {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    }
  } catch {
    /* private mode — the session just will not survive a reload */
  }
}

let session = loadSession();

// Anyone who needs to re-render when the session changes. This file stays free of any
// framework — `src/lib/session.js` is the thin Vue layer over this — but a module-level
// `session` that views read through a plain function is invisible to reactivity, and the
// symptom is a navigation bar that never notices you signed in.
const watchers = new Set();
const notify = () => watchers.forEach((fn) => fn(session));

/** Observe sign-in / sign-out / refresh. Returns an unsubscribe. */
export function onSessionChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

/** An error carrying the API's structured `{code, message}` and the HTTP status. */
export class ApiError extends Error {
  constructor({ code, message, status, details }) {
    super(message || code || `HTTP ${status}`);
    this.name = "ApiError";
    this.code = code || "INTERNAL";
    this.status = status;
    this.details = details;
  }
}

export const currentUser = () => session.user;
export const isSignedIn = () => !!session.idToken;

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

async function raw(method, url, { body, bearer, headers } = {}) {
  const h = { ...(headers || {}) };
  if (bearer) h.authorization = "Bearer " + bearer;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers: h, body: payload });
  if (res.status === 204) return undefined;
  if (!res.ok) throw await parseError(res);
  return res.json();
}

/** An authenticated request that transparently refreshes the id_token once on a 401. */
async function authed(method, url, opts = {}) {
  if (!session.idToken) throw new ApiError({ code: "UNAUTHENTICATED", message: "sign in first", status: 401 });
  try {
    return await raw(method, url, { ...opts, bearer: session.idToken });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && session.refreshToken) {
      await refresh();
      return raw(method, url, { ...opts, bearer: session.idToken });
    }
    throw err;
  }
}

// --- auth -----------------------------------------------------------------

const authBase = () => `${config.baseUrl}/v1/auth/${seg(config.auth)}`;

/** The instance's public sign-in config: which fields to collect, which methods are on. */
export const authConfig = () => raw("GET", `${authBase()}/config`);

function applyTokens(t) {
  session = { idToken: t.id_token, refreshToken: t.refresh_token, user: t.user || session.user };
  saveSession(session);
  notify();
  return session.user;
}

export async function signUp(fields) {
  return applyTokens(await raw("POST", `${authBase()}/signup`, { body: fields }));
}

export async function signIn(identifier, password) {
  const t = await raw("POST", `${authBase()}/signin`, { body: { identifier, password } });
  if (t.mfa_required) return { mfaRequired: true, mfaToken: t.mfa_token };
  return { user: applyTokens(t) };
}

export const verifyMfa = async (mfaToken, code) =>
  applyTokens(await raw("POST", `${authBase()}/2fa/verify`, { body: { mfa_token: mfaToken, code } }));

/** Start passwordless sign-in. Always resolves — the server never reveals whether the
 *  account exists. */
export const passwordlessStart = (identifier) =>
  raw("POST", `${authBase()}/passwordless/start`, { body: { identifier } });

export async function passwordlessVerify(identifier, code) {
  const t = await raw("POST", `${authBase()}/passwordless/verify`, { body: { identifier, code } });
  if (t.mfa_required) return { mfaRequired: true, mfaToken: t.mfa_token };
  return { user: applyTokens(t) };
}

export async function refresh() {
  if (!session.refreshToken) throw new ApiError({ code: "UNAUTHENTICATED", message: "no refresh token", status: 401 });
  const t = await raw("POST", `${authBase()}/token/refresh`, { body: { refresh_token: session.refreshToken } });
  session = { ...session, idToken: t.id_token, refreshToken: t.refresh_token };
  saveSession(session);
  notify();
  return session.idToken;
}

export async function signOut() {
  const rt = session.refreshToken;
  session = { idToken: null, refreshToken: null, user: null };
  saveSession(session);
  notify();
  if (rt) {
    try {
      await raw("POST", `${authBase()}/signout`, { body: { refresh_token: rt } });
    } catch {
      /* best effort — local state is already cleared */
    }
  }
}

// --- datastore (read-only, identity-scoped) -------------------------------

const dsCol = (collection) =>
  `${config.baseUrl}/v1/datastore/${seg(config.datastore)}/ns/${seg(config.namespace)}/col/${seg(collection)}`;

/** Query a collection. The backend ANDs `owner_uid = you` into `where` before it runs,
 *  so there is nothing to add here and no way to ask for someone else's rows. */
export const query = (collection, req = {}) => authed("POST", `${dsCol(collection)}/query`, { body: req });

/** Point-read by key. Only rows you may read come back. */
export const getDocs = (collection, keys) =>
  authed("POST", `${dsCol(collection)}/documents/get`, { body: { keys } });

// --- the function ---------------------------------------------------------

/** Call a DutyBoard endpoint as the signed-in person. Every write goes through here. */
export const api = (path, body = {}) => authed("POST", `${config.api}${path}`, { body });

// --- live -----------------------------------------------------------------

/**
 * Subscribe to board/duty events and call `onEvent` for each.
 *
 * The subscriber token is minted by the FUNCTION, not by the browser against the auth
 * instance: the question "may this person watch this board" needs a project lookup, which
 * a row rule cannot express. Events carry only an id and a status; the page re-reads
 * through the access-controlled datastore path, so an event can never show a duty the
 * reader is not allowed to see.
 *
 * Live is an enhancement. If the channel instance is missing or the socket will not stay
 * up, the board still works — it just stops updating on its own.
 */
export function subscribeLive({ projectId, dutyIds = [] }, onEvent, onState) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;
  const setState = (s) => onState && onState(s);

  async function connect() {
    if (closed) return;
    setState("connecting");
    let minted;
    try {
      minted = await api("/live/token", { project_id: projectId, duty_ids: dutyIds });
    } catch {
      setState("off");
      return scheduleReconnect();
    }

    // Take the PATH and QUERY from the mint but keep our own origin.
    //
    // The mint's `ws_url` already carries the token, so re-appending one would produce
    // `?token=A?token=B` and a 401 handshake. But its host is the server's idea of where
    // it lives, which is not always where this page can reach it — an emulator hands back
    // a placeholder host, and a deployment behind a tunnel or a port-forward has the same
    // problem. The origin we were configured with is the one that demonstrably works,
    // since every other call in this file just succeeded against it.
    const wsBase = config.baseUrl.replace(/^http/, "ws");
    const fallback = `/v1/channel/${seg(config.channel)}/subscribe`;
    let pathAndQuery = fallback;
    if (minted.ws_url) {
      try {
        const from = new URL(minted.ws_url, wsBase);
        pathAndQuery = from.pathname + from.search;
      } catch {
        /* unparseable — fall back to the path we can build ourselves */
      }
    }
    const u = new URL(pathAndQuery, wsBase);
    if (!u.searchParams.has("token")) u.searchParams.set("token", minted.token);

    try {
      ws = new WebSocket(u.toString());
    } catch {
      return scheduleReconnect();
    }
    ws.onopen = () => {
      attempt = 0;
      setState("live");
      ws.send(JSON.stringify({ type: "subscribe", channels: minted.channels }));
    };
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      // A delivery is a plain `{channel, data, ts}` frame; control acks carry a `type`.
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
    if (closed || timer) return;
    attempt++;
    setState("reconnecting");
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, Math.min(500 * 2 ** (attempt - 1), 15000));
  }

  connect();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      setState("closed");
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
