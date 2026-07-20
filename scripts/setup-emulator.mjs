#!/usr/bin/env node
// Provision a local altengine emulator (`altengine dev`) for DutyBoard.
//
// Instances auto-create on first use, but their CONFIG does not — a fresh auth instance
// collects only an email and grants no access, so DutyBoard would sign a user up and then
// get 403 on every datastore call. This applies the configs in backend/ so the app just runs.
//
// Against a hosted altengine you do this once in the console instead; the admin API here is
// the emulator's local, unauthenticated one.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const AUTH = process.env.AUTH_INSTANCE || "dutyboard-auth";
const DS = process.env.DATASTORE_INSTANCE || "dutyboard";
const CH = process.env.CHANNEL_INSTANCE || "dutyboard-live";

const json = (p) => readFile(join(root, "backend", p), "utf8").then(JSON.parse);

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** The admin API addresses instances by id, so map a name to one (creating it if needed). */
async function instanceId(service, name) {
  await req("POST", `/admin/${service}`, { name }); // 409 if it already exists — fine
  const { instances } = await req("GET", `/admin/${service}`);
  const found = instances.find((i) => i.name === name);
  if (!found) throw new Error(`could not create ${service} instance '${name}'`);
  return found.id;
}

async function main() {
  // Fail fast with a useful message rather than a stack trace.
  try {
    await fetch(BASE + "/healthz");
  } catch {
    console.error(`✖ No altengine at ${BASE}.\n  Start it with:  altengine dev\n  (or set ALTENGINE_URL)`);
    process.exit(1);
  }

  const [signup, access, live] = await Promise.all([json("signup.json"), json("access.json"), json("live.json")]);

  // The rules and live binding reference instances BY NAME, so keep them in step with
  // whatever names we actually provision.
  const accessCfg = {
    [`datastore:${DS}`]: access[`datastore:dutyboard`] ?? Object.values(access)[0],
    [`channel:${CH}`]: access[`channel:dutyboard-live`] ?? { level: "read", channels: ["duties.*", "comments.*"] },
  };
  const liveCfg = { ...live, channelInstance: CH };

  const [authId, dsId] = await Promise.all([instanceId("auth", AUTH), instanceId("datastore", DS), instanceId("channel", CH)]);

  await req("PUT", `/admin/auth/${authId}/config`, {
    config: {
      allowSignup: true,
      passwordlessEnabled: true, // the emulator prints/echoes the code — no mail needed
      signup,
      access: accessCfg,
    },
  });

  await req("PUT", `/admin/datastore/${dsId}/config`, {
    config: { autoId: "uuid", autoIndex: true, live: liveCfg },
  });

  console.log(`✔ DutyBoard provisioned on ${BASE}`);
  console.log(`    auth       ${AUTH}   (email + name, signup open, passwordless on)`);
  console.log(`    datastore  ${DS}   (auto-index on, live → ${CH})`);
  console.log(`    channel    ${CH}`);
  console.log(`\n  Now run:  npm run dev`);
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
