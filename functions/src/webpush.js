// Web Push, from inside a function: no library, only Web Crypto.
//
// A push is a POST to the endpoint the browser's push service gave the subscriber (Google's for
// Chrome, Mozilla's for Firefox, Apple's for Safari, Microsoft's for Edge), carrying:
//
//   - a VAPID header (RFC 8292): a short-lived ES256 JWT, signed with this deployment's own key,
//     that tells the push service which application server is sending. The subscriber was created
//     against the public half, so nobody else can push to it;
//   - the payload encrypted to the subscriber (RFC 8291, "aes128gcm" content coding, RFC 8188):
//     the push service relays bytes it cannot read.
//
// The VAPID key pair is made the first time it is needed and kept in the deployment's datastore
// (`settings/webpush`), which no browser rule can read. Not a function secret: hosted, those are only
// written from a signed-in altengine console.

const enc = new TextEncoder();

export const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function unb64url(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** A new VAPID key pair: the public key as the browser wants it (raw, base64url), the private as JWK. */
export async function makeVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { public_key: b64url(raw), private_jwk: jwk };
}

/** The `Authorization` header for one push: `vapid t=<JWT>, k=<public key>`. */
export async function vapidHeader(endpoint, keys, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Twelve hours: RFC 8292 caps it at twenty-four, and a push service may refuse one near the cap.
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.private_jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // Web Crypto's ECDSA signature is r||s, which is exactly JWS's ES256 form.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.public_key}`;
}

/**
 * Encrypt a payload to one subscription (RFC 8291). `p256dh` and `auth` are the subscription's keys,
 * base64url. Answers the request body: salt, record size, the sender's public key, the ciphertext.
 */
export async function encryptPayload(payload, p256dh, auth, { salt = crypto.getRandomValues(new Uint8Array(16)), senderKeys = null } = {}) {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("the subscription's keys are not a P-256 key and a 16-byte secret");

  const sender = senderKeys || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256));

  // HKDF-SHA-256 with a 32-byte output is HMAC(extract) then one round of HMAC(expand, info || 0x01).
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hmac(await hmac(authSecret, ecdhSecret), concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  // One record, so it ends with the last-record delimiter 0x02 and no padding.
  const plaintext = concat(typeof payload === "string" ? enc.encode(payload) : payload, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plaintext));

  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

/** Push services a subscription's endpoint may point at — and so the hosts a function must reach. */
export const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "*.notify.windows.com"];

export function isPushEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return PUSH_HOSTS.some((h) => (h.startsWith("*.") ? u.hostname.endsWith(h.slice(1)) : u.hostname === h));
}

/**
 * Send one push. Answers `{ ok, gone, status }`: `gone` is a subscription the push service says no
 * longer exists (404, 410), to be forgotten.
 */
export async function sendPush(subscription, payload, keys, { subject, ttl = 86400, topic = "", fetchImpl = fetch } = {}) {
  const body = await encryptPayload(JSON.stringify(payload), subscription.p256dh, subscription.auth);
  const headers = {
    authorization: await vapidHeader(subscription.endpoint, keys, subject),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(ttl),
    urgency: "high",
  };
  // A topic replaces an undelivered push with the same one, so a phone that was off gets the latest
  // state of a duty rather than every step of it. At most 32 base64url characters.
  if (topic) headers.topic = topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await fetchImpl(subscription.endpoint, { method: "POST", headers, body });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}
