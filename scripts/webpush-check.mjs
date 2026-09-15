#!/usr/bin/env node
// Checks functions/src/webpush.js against an independent implementation: the receiving side of RFC
// 8291 and RFC 8292, written with node:crypto rather than Web Crypto. A push service and a browser
// accept a push only when every byte of this is right, and nothing else in the repository can reach
// one — so this is where it is proven.
//
//   node scripts/webpush-check.mjs

import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { encryptPayload, makeVapidKeys, vapidHeader, isPushEndpoint, b64url, unb64url } from "../functions/src/webpush.js";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("      ", detail);
  }
};
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// A browser's subscription: its ECDH key pair and auth secret.
const ua = createECDH("prime256v1");
ua.generateKeys();
const authSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
const p256dh = b64url(ua.getPublicKey());
const auth = b64url(authSecret);

const message = JSON.stringify({ title: "Needs you · Cadence", body: "Blue or green? — the answer rides along with the duty ✓" });
const body = Buffer.from(await encryptPayload(message, p256dh, auth));

// Decrypt it the way a browser does (RFC 8188 header, RFC 8291 key derivation).
const salt = body.subarray(0, 16);
const rs = body.readUInt32BE(16);
const idlen = body[20];
const asPublic = body.subarray(21, 21 + idlen);
const ciphertext = body.subarray(21 + idlen);
check("the header carries a 16-byte salt, a record size and the sender's 65-byte key", rs === 4096 && idlen === 65 && asPublic[0] === 4);
const ecdhSecret = ua.computeSecret(asPublic);
const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
const ikm = hmac(hmac(authSecret, ecdhSecret), Buffer.concat([keyInfo, Buffer.from([1])]));
const prk = hmac(salt, ikm);
const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
let plain = null;
try {
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
} catch (err) {
  plain = err;
}
check("a subscriber can decrypt the payload", Buffer.isBuffer(plain), plain);
check("and it ends with the last-record delimiter", Buffer.isBuffer(plain) && plain[plain.length - 1] === 2);
check("to the exact message sent", Buffer.isBuffer(plain) && plain.subarray(0, plain.length - 1).toString() === message);

const wrongAuth = b64url(crypto.getRandomValues(new Uint8Array(16)));
const other = Buffer.from(await encryptPayload(message, p256dh, wrongAuth));
let refused = false;
try {
  const s2 = other.subarray(0, 16), as2 = other.subarray(21, 86), ct2 = other.subarray(86);
  const ikm2 = hmac(hmac(authSecret, ua.computeSecret(as2)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), as2, Buffer.from([1])]));
  const prk2 = hmac(s2, ikm2);
  const d = createDecipheriv("aes-128-gcm", hmac(prk2, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16), hmac(prk2, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12));
  d.setAuthTag(ct2.subarray(ct2.length - 16));
  d.update(ct2.subarray(0, ct2.length - 16));
  d.final();
} catch {
  refused = true;
}
check("a payload for someone else's auth secret does not decrypt", refused);

// VAPID: the JWT verifies under the public key the subscriber was made with.
const keys = await makeVapidKeys();
check("the VAPID public key is an uncompressed P-256 point", unb64url(keys.public_key).length === 65 && unb64url(keys.public_key)[0] === 4);
const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
const hdr = await vapidHeader(endpoint, keys, "https://example.test", Date.parse("2026-09-15T12:00:00Z"));
const m = hdr.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
check("the header is `vapid t=<jwt>, k=<key>`", !!m && m[4] === keys.public_key, hdr);
if (m) {
  const claims = JSON.parse(Buffer.from(unb64url(m[2])).toString());
  check("its audience is the push service's origin, with a subject and an expiry", claims.aud === "https://fcm.googleapis.com" && claims.sub === "https://example.test" && claims.exp === Date.parse("2026-09-15T12:00:00Z") / 1000 + 43200, claims);
  const raw = unb64url(keys.public_key);
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) }, format: "jwk" });
  const ok = verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(unb64url(m[3])));
  check("its ES256 signature verifies with the public key", ok);
}

check(
  "only the known push services are accepted as endpoints",
  isPushEndpoint(endpoint) && isPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x") && isPushEndpoint("https://web.push.apple.com/abc") &&
    !isPushEndpoint("https://evil.example/fcm.googleapis.com") && !isPushEndpoint("http://fcm.googleapis.com/x") && !isPushEndpoint("https://notify.windows.com.evil.example/x"),
);

console.log(`\n${failures ? "✖" : "✔"} web push: ${failures ? failures + " failed" : "all checks passed"}`);
process.exit(failures ? 1 : 0);
