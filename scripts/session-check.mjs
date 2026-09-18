#!/usr/bin/env node
// The console's session, checked without a browser.
//
// An identity token lasts an hour and the refresh token that replaces it is SINGLE USE: spending
// it returns a new one and kills the old. That makes the interesting cases concurrent ones, and
// they are exactly the cases a person hits — opening a board fires several calls at once, and two
// open tabs share one token. Getting this wrong signs people out mid-sentence an hour in, which is
// what this exists to stop happening again.
//
//   node scripts/session-check.mjs
//
// The module is bundled with esbuild first because it is written for Vite (`import.meta.env`), and
// the browser it expects — localStorage, window, fetch — is stubbed here.

import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok || detail === "" ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// --- the browser this module expects --------------------------------------

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const listeners = new Map();
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
  removeEventListener: () => {},
  location: { origin: "http://localhost" },
};
/** What the browser does when another tab writes to localStorage. */
const otherTabWrote = (key) => (listeners.get("storage") || []).forEach((fn) => fn({ key }));

const seconds = (n) => Math.floor(Date.now() / 1000) + n;
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// Every request the module makes, in order, so a test can say how many refreshes happened.
let calls = [];
let refreshes = 0;
let token = "id-1";
let refreshToken = "rt-1";
/** When the server stops accepting `token` — an expiry the client cannot talk its way past. */
let tokenUntil = Infinity;
/** Set by a test to change what the server does next. */
let server = {};

globalThis.fetch = async (url, init = {}) => {
  const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || "";
  calls.push({ url: String(url), bearer: auth.replace("Bearer ", "") });
  if (String(url).endsWith("/token/refresh")) {
    refreshes++;
    const sent = JSON.parse(init.body || "{}").refresh_token;
    if (server.refreshThrows) throw new TypeError("Failed to fetch");
    if (server.refreshRefuses || sent !== refreshToken) {
      return reply(401, { error: { code: "UNAUTHENTICATED", message: "invalid or expired refresh token" } });
    }
    token = `id-${refreshes + 1}`;
    refreshToken = `rt-${refreshes + 1}`;
    tokenUntil = seconds(3600);
    return reply(200, { id_token: token, refresh_token: refreshToken, expires_at: tokenUntil, refresh_expires_at: seconds(86400) });
  }
  if (auth.replace("Bearer ", "") !== token || seconds(0) > tokenUntil) {
    return reply(401, { error: { code: "UNAUTHENTICATED", message: "token expired" } });
  }
  return reply(200, { ok: true });
};

// --- the module under test ------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), "dutyboard-session-"));
const outfile = join(dir, "altengine.mjs");
await build({
  entryPoints: ["app/src/lib/altengine.js"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "neutral",
  // Vite's own; a define must be a literal, so the empty object arrives as a global this file sets.
  define: { "import.meta.env": "__VITE_ENV__" },
  inject: [],
  banner: { js: "const __VITE_ENV__ = {};" },
});
/**
 * A page load, signed in: the tokens are in storage before the module is imported, and each case
 * gets its own copy of the module — which is what a reload is.
 *
 * An expiry the client knows about is one the SERVER enforces too: a stub that kept accepting an
 * expired token would let a broken client look like a working one.
 */
let loads = 0;
async function signedIn({ expiresAt } = {}) {
  calls = [];
  refreshes = 0;
  token = "id-1";
  refreshToken = "rt-1";
  tokenUntil = expiresAt || Infinity;
  server = {};
  listeners.clear();
  store.clear();
  store.set("dutyboard.id_token", "id-1");
  store.set("dutyboard.refresh_token", "rt-1");
  store.set("dutyboard.user", JSON.stringify({ uid: "u1", name: "Tester" }));
  if (expiresAt) store.set("dutyboard.expires_at", String(expiresAt));
  return import(`${outfile}?load=${++loads}`);
}

console.log("an expired token, several calls at once");
let { api, isSignedIn, refresh } = await signedIn({ expiresAt: seconds(-10) });
const together = await Promise.allSettled([api("/board/open"), api("/duty/poll"), api("/board/runners")]);
check("every call goes through", together.every((r) => r.status === "fulfilled"), together.map((r) => r.reason && r.reason.message));
check("the single-use refresh token is spent once, not once per call", refreshes === 1, refreshes);
check("and the session survives", isSignedIn());
check("every call carries the new token", calls.filter((c) => !c.url.endsWith("/token/refresh")).every((c) => c.bearer === "id-2"), calls);

console.log("a token that expires with no warning (a session stored before expiry was recorded)");
({ api, isSignedIn, refresh } = await signedIn());
token = "id-0"; // the server has moved on; the stored token is refused
const surprised = await Promise.allSettled([api("/board/open"), api("/duty/poll")]);
check("both calls recover", surprised.every((r) => r.status === "fulfilled"), surprised.map((r) => r.reason && r.reason.message));
check("with one refresh between them", refreshes === 1, refreshes);

console.log("another tab refreshed first");
({ api, isSignedIn, refresh } = await signedIn({ expiresAt: seconds(3600) }));
// The other tab spends the token and leaves the new pair behind, as a rotation does.
token = "id-9";
refreshToken = "rt-9";
tokenUntil = seconds(3600);
store.set("dutyboard.id_token", "id-9");
store.set("dutyboard.refresh_token", "rt-9");
otherTabWrote("dutyboard.id_token");
const afterOtherTab = await api("/board/open").then(() => true, (e) => e.message);
check("this tab picks up the tokens rather than signing out", afterOtherTab === true, afterOtherTab);
check("and spends nothing of its own", refreshes === 0, refreshes);

console.log("the refresh token is genuinely dead");
({ api, isSignedIn, refresh } = await signedIn({ expiresAt: seconds(-10) }));
server.refreshRefuses = true;
const dead = await api("/board/open").then(() => null, (e) => e);
check("the call fails with something a person can act on", /sign in again/i.test(dead && dead.message), dead && dead.message);
check("and the session is cleared, so the app can send them to sign in", !isSignedIn());

console.log("the network is down");
({ api, isSignedIn, refresh } = await signedIn({ expiresAt: seconds(-10) }));
server.refreshThrows = true;
const offline = await api("/board/open").then(() => null, (e) => e);
check("the call fails", !!offline);
check("but nobody is signed out for being offline", isSignedIn());

console.log("refreshing on purpose, from several places at once");
({ api, isSignedIn, refresh } = await signedIn({ expiresAt: seconds(3600) }));
const [a, b, c] = await Promise.all([refresh(), refresh(), refresh()]);
check("one refresh, one answer, shared", refreshes === 1 && a === b && b === c, { refreshes, a, b, c });

await rm(dir, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} failed` : "\n✔ all session checks passed");
process.exit(failed ? 1 : 0);
