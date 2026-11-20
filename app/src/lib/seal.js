// Encrypting to a machine's own key, so a secret typed in the console reaches that machine without
// the board in between being able to read it.
//
// The machine publishes a P-256 public key and keeps the private half in its keyring. This makes a
// one-time key pair, agrees a secret with the machine's key (ECDH), stretches it into an AES-256-GCM
// key (HKDF-SHA256, bound to both public keys) and encrypts. Only ciphertext leaves the browser.
// The other half of this is cli/internal/seal/seal.go; a Go test there opens what this makes.

const CONTEXT = "dutyboard-seal-v1";
const encoder = new TextEncoder();

const toBase64Url = (bytes) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Whether this browser can seal at all. Every current one can; an old one is told, not failed. */
export const canSeal = () => !!(globalThis.crypto && globalThis.crypto.subtle);

/**
 * `plaintext` sealed to `publicKey` (the machine's, base64url), as the envelope the machine opens:
 * `v1.<one-time public key>.<nonce>.<ciphertext>`.
 */
export async function seal(publicKey, plaintext) {
  const { subtle } = globalThis.crypto;
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const machineRaw = fromBase64Url(publicKey);
  const machineKey = await subtle.importKey("raw", machineRaw, curve, false, []);
  const oneTime = await subtle.generateKey(curve, true, ["deriveBits"]);
  const oneTimeRaw = new Uint8Array(await subtle.exportKey("raw", oneTime.publicKey));

  const shared = await subtle.deriveBits({ name: "ECDH", public: machineKey }, oneTime.privateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: concat(encoder.encode(CONTEXT), machineRaw, oneTimeRaw) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(CONTEXT) }, key, encoder.encode(plaintext));
  return ["v1", toBase64Url(oneTimeRaw), toBase64Url(nonce), toBase64Url(sealed)].join(".");
}

/** The MCP secrets a person typed, sealed for one machine. `values` is `[{ board, server, name, value }]`. */
export const sealSecrets = (publicKey, values) => seal(publicKey, JSON.stringify({ v: 1, secrets: values }));
