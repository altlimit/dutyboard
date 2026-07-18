// Runtime configuration. Reads Vite build-time env (VITE_*), and lets a visitor
// override the target at runtime via localStorage (handy when hosting one static
// build against several altengine backends, e.g. dev vs prod). All values here are
// PUBLIC — an API origin and instance names, never a secret.

const fromEnv = {
  baseUrl: import.meta.env.VITE_ALTENGINE_URL || "http://127.0.0.1:9191",
  auth: import.meta.env.VITE_AUTH_INSTANCE || "dutyboard-auth",
  datastore: import.meta.env.VITE_DATASTORE_INSTANCE || "dutyboard",
  channel: import.meta.env.VITE_CHANNEL_INSTANCE || "dutyboard-live",
};

function override(key) {
  try {
    return localStorage.getItem("dutyboard.cfg." + key) || undefined;
  } catch {
    return undefined;
  }
}

export const config = {
  baseUrl: (override("baseUrl") || fromEnv.baseUrl).replace(/\/+$/, ""),
  auth: override("auth") || fromEnv.auth,
  datastore: override("datastore") || fromEnv.datastore,
  channel: override("channel") || fromEnv.channel,
  // Default (unnamed) datastore namespace. The empty namespace can't ride a URL
  // path, so it travels as the reserved `_default` sentinel (server maps it back).
  namespace: "_default",
};
