// Runtime configuration.
//
// Everything here is PUBLIC — an API origin, instance names, a function URL. There is no
// key in this app: a person signs in against the auth instance and the identity token
// they get back is the only credential the page ever holds.
//
// A visitor can also retarget the build at runtime through localStorage, which is what
// makes one static bundle usable against a local emulator and a hosted deployment
// without rebuilding.

/**
 * Written at DEPLOY time, not build time: `/app/config.js` sets `window.DUTYBOARD_CONFIG` before
 * this bundle loads. It is how one prebuilt console — the one the `dutyboard` binary carries —
 * is pointed at whichever deployment it was uploaded next to, with no rebuild. The build's own
 * `VITE_*` values are what is used when that file sets nothing, which is the dev server's case.
 */
const deployed = (typeof window !== "undefined" && window.DUTYBOARD_CONFIG) || {};

const env = {
  baseUrl: deployed.baseUrl || import.meta.env.VITE_ALTENGINE_URL || "http://127.0.0.1:9191",
  // Hosted, this must be the auth instance's ID rather than its name: sign-in carries no
  // API key, so there is no org to resolve a name inside and the platform answers 404.
  // The datastore and channel below are named — those calls carry an identity token.
  auth: deployed.auth || import.meta.env.VITE_AUTH_INSTANCE || "dutyboard-auth",
  datastore: deployed.datastore || import.meta.env.VITE_DATASTORE_INSTANCE || "dutyboard",
  channel: deployed.channel || import.meta.env.VITE_CHANNEL_INSTANCE || "dutyboard-live",
  functions: deployed.functions || import.meta.env.VITE_FUNCTIONS_INSTANCE || "dutyboard",
  api: deployed.api || import.meta.env.VITE_API_URL || "",
  fn: deployed.fn || import.meta.env.VITE_FUNCTION_NAME || "board",
};

/** What this build was compiled to talk to, before anyone retargets it. Exported so the
 *  connect screen can offer "reset to default" and mean something by it. */
export const DEFAULTS = Object.freeze({
  baseUrl: env.baseUrl.replace(/\/+$/, ""),
  auth: env.auth,
  datastore: env.datastore,
  channel: env.channel,
  functions: env.functions,
  fn: env.fn,
  // Usually empty: the function's URL is derived from the two fields above. It is a field
  // at all because hosted, a functions instance answers on a MINTED subdomain that need
  // not match its name, and then deriving it is guesswork.
  api: env.api,
});

const OVERRIDE_PREFIX = "dutyboard.cfg.";

function override(key) {
  try {
    return localStorage.getItem(OVERRIDE_PREFIX + key) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Point this console at a different altengine.
 *
 * Written here, read at the top of this module on the next load — which is why the caller
 * reloads rather than trying to apply it live. Every module in the app captured the old
 * values when it was imported.
 *
 * A value equal to the default is REMOVED rather than stored. Otherwise a build that later
 * changes where it points would be overridden by a copy of its own old default, saved by
 * someone who never meant to pin anything.
 */
export function saveOverrides(values) {
  try {
    for (const [key, raw] of Object.entries(values)) {
      const value = String(raw ?? "").trim().replace(/\/+$/, "");
      if (!value || value === DEFAULTS[key]) localStorage.removeItem(OVERRIDE_PREFIX + key);
      else localStorage.setItem(OVERRIDE_PREFIX + key, value);
    }
  } catch {
    /* storage refused — nothing is pinned, and the app keeps working against the default */
  }
}

export function clearOverrides() {
  try {
    for (const key of Object.keys(DEFAULTS)) localStorage.removeItem(OVERRIDE_PREFIX + key);
    localStorage.removeItem(OVERRIDE_PREFIX + "api");
  } catch {
    /* see saveOverrides */
  }
}

/** True when this console has been pointed somewhere other than where it was built to
 *  point. The nav says so, because "which backend am I looking at" is otherwise invisible
 *  and is the first question when something looks wrong. */
export const isRetargeted = () => Object.keys(DEFAULTS).some((k) => override(k) && override(k) !== DEFAULTS[k]);

const baseUrl = (override("baseUrl") || env.baseUrl).replace(/\/+$/, "");
const functions = override("functions") || env.functions;
// The deployed function's name — the first path segment under its host. See scripts/deploy.mjs.
const fn = override("fn") || env.fn;

/**
 * Where the function lives.
 *
 * Hosted, every functions instance gets its own subdomain and the function name is the
 * first path segment. Locally there are no subdomains, so the emulator serves the same
 * function from `/fn/{instance}/{name}`. Deriving it rather than hard-coding one means
 * the same build works in both.
 */
function apiUrl() {
  const explicit = override("api") || env.api;
  if (explicit) return explicit.replace(/\/+$/, "");
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(baseUrl);
  return local ? `${baseUrl}/fn/${functions}/${fn}` : `https://${functions}-fn.altengine.app/${fn}`;
}

export const config = {
  baseUrl,
  /** The raw override, NOT the resolved URL — the connect form has to be able to show an
   *  empty box when nobody pinned one, or saving the form would pin the derived value. */
  apiOverride: override("api") || env.api,
  auth: override("auth") || env.auth,
  datastore: override("datastore") || env.datastore,
  channel: override("channel") || env.channel,
  functions,
  fn,
  api: apiUrl(),
  // The default (unnamed) namespace cannot ride a URL path, so it travels as the
  // reserved `_default` sentinel and the server maps it back.
  namespace: "_default",
};
