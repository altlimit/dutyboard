// Runtime configuration.
//
// Everything here is PUBLIC — an API origin, instance names, a function URL. There is no
// key in this app: a person signs in against the auth instance and the identity token
// they get back is the only credential the page ever holds.
//
// A visitor can also retarget the build at runtime through localStorage, which is what
// makes one static bundle usable against a local emulator and a hosted deployment
// without rebuilding.

const env = {
  baseUrl: import.meta.env.VITE_ALTENGINE_URL || "http://127.0.0.1:9191",
  auth: import.meta.env.VITE_AUTH_INSTANCE || "dutyboard-auth",
  datastore: import.meta.env.VITE_DATASTORE_INSTANCE || "dutyboard",
  channel: import.meta.env.VITE_CHANNEL_INSTANCE || "dutyboard-live",
  functions: import.meta.env.VITE_FUNCTIONS_INSTANCE || "dutyboard",
  api: import.meta.env.VITE_API_URL || "",
  fn: import.meta.env.VITE_FUNCTION_NAME || "board",
};

function override(key) {
  try {
    return localStorage.getItem("dutyboard.cfg." + key) || undefined;
  } catch {
    return undefined;
  }
}

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
