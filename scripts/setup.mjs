#!/usr/bin/env node
// Provision a local altengine emulator for DutyBoard.
//
//   altengine dev            # in another terminal
//   npm run setup
//
// Instances auto-create on first use but their CONFIG does not, and none of the defaults
// are what this app needs: a fresh auth instance collects only an email and grants no
// access at all, so the console would sign someone up and then get 403 on every read.
// This applies backend/ for you.
//
// Against hosted altengine you do the same thing once in the console — see the README.
// The admin API used here is the emulator's local, unauthenticated one.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const DS = process.env.DUTYBOARD_DATASTORE || "dutyboard";
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const CHANNEL = process.env.DUTYBOARD_CHANNEL || "dutyboard-live";
const FN = process.env.DUTYBOARD_FN_INSTANCE || "dutyboard";
// Where the console is served from, so the function will answer its calls. The emulator
// serves functions from the same origin family, but CORS is enforced there too.
const CONSOLE_ORIGINS = (process.env.DUTYBOARD_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173").split(",");

const readConfig = (name) => readFile(join(root, "backend", name), "utf8").then(JSON.parse);

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer dev" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** The admin API addresses instances by id, so map a name to one, creating it if needed. */
async function instanceId(service, name) {
  await req("POST", `/admin/${service}`, { name }); // 409 when it already exists — fine
  const { instances } = await req("GET", `/admin/${service}`);
  const found = (instances || []).find((i) => i.name === name);
  if (!found) throw new Error(`could not create ${service} instance '${name}'`);
  return found.id;
}

/** Wait for the emulator to answer, up to `seconds`.
 *
 *  Bounded, not infinite, and it waits rather than failing fast because the usual way this
 *  runs is as a task started at the same moment as the emulator itself — losing that race
 *  by half a second should not mean an unprovisioned backend and a console that 403s. */
async function waitForAltengine(seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + "/healthz");
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      console.error(`✖ no altengine at ${BASE} after ${seconds}s`);
      console.error(`  start it with:  altengine dev    (or set ALTENGINE_URL)`);
      process.exit(1);
    }
    if (attempt === 0) process.stdout.write(`… waiting for altengine at ${BASE}`);
    else process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  await waitForAltengine();

  const [signup, access, indexes] = await Promise.all([
    readConfig("signup.json"),
    readConfig("access.json"),
    readConfig("indexes.json"),
  ]);

  const [authId, dsId] = await Promise.all([
    instanceId("auth", AUTH),
    instanceId("datastore", DS),
    instanceId("channel", CHANNEL),
  ]);

  // The access rules name the datastore instance by name, so keep them in step with
  // whatever we actually provisioned.
  const accessCfg = { [`datastore:${DS}`]: access["datastore:dutyboard"] };

  await req("PUT", `/admin/auth/${authId}/config`, {
    config: {
      allowSignup: true,
      passwordlessEnabled: true, // the emulator prints the code to its own terminal
      signup,
      access: accessCfg,
      origins: CONSOLE_ORIGINS,
    },
  });

  await req("PUT", `/admin/datastore/${dsId}/config`, {
    config: { autoId: "uuid", autoIndex: true },
  });

  let created = 0;
  for (const [collection, specs] of Object.entries(indexes)) {
    if (collection.startsWith("_")) continue;
    for (const spec of specs) {
      await req("POST", `/admin/datastore/${dsId}/namespaces/_default/collections/${collection}/indexes`, {
        fields: spec.fields,
      });
      created++;
    }
  }

  // A functions instance is not created through the admin plane — it comes into being on
  // its first deploy. Its settings live on the data plane, behind an API key, and CORS is
  // one of them: without an origin list the function sends no CORS headers at all and the
  // console's every call fails in the browser while working perfectly from curl.
  await req("PUT", `/v1/functions/${encodeURIComponent(FN)}/settings`, {
    corsOrigins: CONSOLE_ORIGINS,
    allowedHosts: [],
  }).catch((err) => {
    console.warn(`  ! could not set CORS on functions instance '${FN}': ${err.message}`);
    console.warn(`    deploy the function first, then re-run this.`);
  });

  console.log(`✔ DutyBoard provisioned on ${BASE}`);
  console.log(`    auth       ${AUTH}      email + name, signup open, passwordless on`);
  console.log(`    datastore  ${DS}           auto-index on, ${created} indexes declared`);
  console.log(`    channel    ${CHANNEL}      live board updates`);
  console.log(`    functions  ${FN}           CORS: ${CONSOLE_ORIGINS.join(", ")}`);
  console.log(`\n  Next:  npm run deploy   (ALTENGINE_URL=${BASE} ALTENGINE_KEY=dev)`);
  console.log(`         npm run dev`);
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
