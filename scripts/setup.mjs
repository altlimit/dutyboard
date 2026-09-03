#!/usr/bin/env node
// Provision DutyBoard's backend — the same instances and the same config, against a local
// emulator or against hosted altengine.
//
//   altengine dev            # in another terminal
//   npm run setup
//
//   ALTENGINE_URL=https://api.altengine.net ALTENGINE_KEY=ak_… npm run setup
//
// Instances auto-create on first use but their CONFIG does not, and none of the defaults
// are what this app needs: a fresh auth instance collects only an email and grants no
// access at all, so the console would sign someone up and then get 403 on every read.
// This applies backend/ for you.
//
// TWO CONTROL PLANES, ONE INTENT. Locally, provisioning is the emulator's own admin API,
// which is unauthenticated and can do everything. Hosted, there is no admin API for an
// API key — the console's `/admin` routes want a browser session — so the control plane
// is the MCP endpoint, which accepts an API key with control scopes and exposes exactly
// the same operations as tools. Different transport, same decisions, one file, so the two
// cannot drift into meaning different things.
//
// Two hosted steps genuinely cannot be scripted today, and this says so rather than
// half-succeeding: creating the auth and channel instances (both mint a signing secret at
// creation, which is the service's to generate, so MCP refuses), and the auth instance's
// sign-up form and allowed origins (auth config is split across four independently
// validated sections, which patch_instance_config refuses to merge blindly). Everything
// else — instances, datastore settings, indexes, access rules, the function's CORS list —
// is done here.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BASE = (process.env.ALTENGINE_URL || "http://127.0.0.1:9191").replace(/\/+$/, "");
const KEY = process.env.ALTENGINE_KEY || "";
const DS = process.env.DUTYBOARD_DATASTORE || "dutyboard";
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const CHANNEL = process.env.DUTYBOARD_CHANNEL || "dutyboard-live";
const FN = process.env.DUTYBOARD_FN_INSTANCE || "dutyboard";
const BLOB = process.env.DUTYBOARD_BLOB || "dutyboard-files";
// Where the console is served from, so the function will answer its calls. CORS is
// enforced in both deployments, so this is not a local-only convenience.
const PORT = process.env.DUTYBOARD_PORT || "5173";
const CONSOLE_ORIGINS = (process.env.DUTYBOARD_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** An emulator is addressed by loopback. Everything else is hosted, which decides which
 *  control plane the rest of this file uses — not a flag someone can forget to pass. */
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);

const readConfig = (name) => readFile(join(root, "backend", name), "utf8").then(JSON.parse);

/** The access rules name the datastore instance by name, so keep them in step with
 *  whatever we actually provisioned. `_comment` keys are for the reader, not the API. */
const accessFor = (access) => ({ [`datastore:${DS}`]: access["datastore:dutyboard"] });

/** Declared indexes, flattened to (collection, fields) pairs. `_`-prefixed keys are
 *  commentary. */
function indexPairs(indexes) {
  const out = [];
  for (const [collection, specs] of Object.entries(indexes)) {
    if (collection.startsWith("_")) continue;
    for (const spec of specs) out.push([collection, spec.fields, spec.unique === true]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Local: the emulator's admin API
// ---------------------------------------------------------------------------------------

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY || "dev"}` },
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

async function provisionLocal({ signup, access, indexes }) {
  await waitForAltengine();

  const [authId, dsId] = await Promise.all([
    instanceId("auth", AUTH),
    instanceId("datastore", DS),
    instanceId("channel", CHANNEL),
  ]);
  // No blob here: the emulator has no /admin/blob, and does not need one — it creates a
  // blob instance the first time anything names it, which is the function's first upload.
  // Hosted is different, and the hosted branch below creates it explicitly.

  await req("PUT", `/admin/auth/${authId}/config`, {
    config: {
      allowSignup: true,
      passwordlessEnabled: true, // the emulator prints the code to its own terminal
      signup,
      access: accessFor(access),
      origins: CONSOLE_ORIGINS,
    },
  });

  await req("PUT", `/admin/datastore/${dsId}/config`, {
    config: { autoId: "uuid", autoIndex: true },
  });

  let created = 0;
  for (const [collection, fields, unique] of indexPairs(indexes)) {
    await req("POST", `/admin/datastore/${dsId}/namespaces/_default/collections/${collection}/indexes`, { fields, unique });
    created++;
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
  console.log(`    blob       ${BLOB}     attachments (created on first use)`);
  console.log(`    functions  ${FN}           CORS: ${CONSOLE_ORIGINS.join(", ")}`);
  console.log(`\n  Next:  npm run deploy   (ALTENGINE_URL=${BASE} ALTENGINE_KEY=dev)`);
  console.log(`         npm run dev`);
}

// ---------------------------------------------------------------------------------------
// Hosted: the MCP control plane, plus the /v1 data plane for indexes
// ---------------------------------------------------------------------------------------

let rpcId = 0;

/** Call one MCP tool and return its parsed result.
 *
 *  The server is stateless — no initialize handshake, no session id — so a tool call is a
 *  single POST. A tool that fails answers `isError: true` with the reason as text rather
 *  than a JSON-RPC error, so both shapes have to be read or a refusal looks like success. */
async function mcp(tool, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${res.status} from ${BASE}/mcp — the key needs CONTROL access to instances and functions ` +
        `(Settings → API keys in the console), not just data access.`,
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${tool}: unreadable response (${res.status}) ${text.slice(0, 200)}`);
  }
  if (body.error) throw new Error(`${tool}: ${body.error.message || JSON.stringify(body.error)}`);
  const content = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) {
    const err = new Error(`${tool}: ${content}`);
    err.toolError = content;
    throw err;
  }
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** A plain data-plane call, for the things MCP has no tool for. */
async function v1(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => null);
}

async function provisionHosted({ signup, access, indexes }) {
  if (!KEY) {
    console.error(`✖ ${BASE} is not a local emulator, so this needs an API key`);
    console.error(`  ALTENGINE_KEY=ak_… npm run setup`);
    process.exit(1);
  }

  const who = await mcp("whoami", {});
  console.log(`  organization: ${who?.org?.name ?? "?"}`);

  const instances = await mcp("list_instances", {});
  const exists = (service, name) => (instances?.[service] || []).some((i) => i.name === name);

  // Anything the platform refuses to create ends up here and is reported together, at the
  // end, as one list of things to do — not as a failure per missing instance.
  //
  // Auth and channel used to be a certainty: both mint a signing secret at creation and
  // create_instance would not do it. Newer altengine will, so they are ATTEMPTED like the
  // rest and only fall back to the console when the refusal actually comes.
  const manual = [];

  for (const [service, name] of [
    ["auth", AUTH],
    ["channel", CHANNEL],
    ["datastore", DS],
    ["functions", FN],
    ["blob", BLOB],
  ]) {
    if (exists(service, name)) {
      console.log(`  ${service.padEnd(10)} ${name} — already there`);
      continue;
    }
    // ALREADY_EXISTS is not an error here: two people running this at once, or a name
    // taken between the listing and now, both mean the thing we wanted is in place.
    let refused = "";
    await mcp("create_instance", { service, name }).catch((err) => {
      const message = err.toolError || err.message || "";
      if (/already exists/i.test(message)) return;
      // "must be created in the console" is the older platform's answer for auth and
      // channel. It is a thing for a person to do, not a reason to stop provisioning the
      // rest — everything after this either does not need them or is checked separately.
      if (/must be created in the console/i.test(message)) {
        refused = message;
        return;
      }
      throw err;
    });
    if (refused) {
      manual.push([service, name]);
      console.log(`  ${service.padEnd(10)} ${name} — console only on this altengine`);
      continue;
    }
    console.log(`  ${service.padEnd(10)} ${name} — created`);
  }

  await mcp("patch_instance_config", {
    service: "datastore",
    instance: DS,
    changes: { autoId: "uuid", autoIndex: true },
  });

  // Indexes have no MCP-shaped ceremony: the data plane takes them directly, and creating
  // one that already exists is a no-op rather than a conflict.
  let created = 0;
  for (const [collection, fields, unique] of indexPairs(indexes)) {
    await v1("POST", `/v1/datastore/${encodeURIComponent(DS)}/ns/_default/col/${encodeURIComponent(collection)}/indexes`, {
      fields,
      unique,
    });
    created++;
  }
  console.log(`  indexes    ${created} declared on ${DS}`);

  if (exists("auth", AUTH)) {
    // REPLACES the whole access config, which is what we want: backend/access.json is the
    // single description of what a browser may read, and a merge would leave behind rules
    // nobody wrote down.
    await mcp("auth_set_rules", { instance: AUTH, access: accessFor(access) });
    console.log(`  auth       ${AUTH} — access rules applied`);
  }

  // The function's CORS list. Hosted this is instance config; locally it is a settings
  // endpoint that only the emulator has — the one place the two planes are not the same
  // call, which is why it is written twice rather than shared.
  await mcp("patch_instance_config", {
    service: "functions",
    instance: FN,
    changes: { corsOrigins: CONSOLE_ORIGINS, allowedHosts: [] },
  });
  console.log(`  functions  ${FN} — CORS: ${CONSOLE_ORIGINS.join(", ")}`);

  console.log(`\n✔ provisioned what a key can provision on ${BASE}`);

  // What is left, checked rather than assumed. The sign-up form and the origin list are
  // readable through MCP even though they are not writable through it, so this reports the
  // instance as it actually is instead of printing the same paragraph every run.
  const todo = manual.map(
    ([service, name]) =>
      `Create the ${service} instance '${name}'. It mints a signing secret at creation, ` +
      `which is the service's to generate, so no API key can make it.`,
  );

  if (exists("auth", AUTH)) {
    const cfg = (await mcp("get_instance_config", { service: "auth", instance: AUTH }))?.config || {};
    // Read BOTH spellings. Hosted nests the scalars under `settings` and calls the origin
    // list `allowedOrigins`; the emulator returns them flat, as `origins`. This check is
    // advisory — reporting work that is already done would be worse than reporting none —
    // so it reads whichever the answering plane uses rather than insisting on one.
    const settings = cfg.settings || cfg;
    const origins = settings.allowedOrigins || settings.origins || [];
    const haveFields = new Set((cfg.signup?.fields || []).map((f) => f.key));
    const wantFields = (signup.fields || []).map((f) => f.key);
    const missingFields = wantFields.filter((k) => !haveFields.has(k));
    const missingOrigins = CONSOLE_ORIGINS.filter((o) => !origins.includes(o));

    if (missingFields.length) {
      todo.push(
        `On auth '${AUTH}', set the sign-up form to the fields in backend/signup.json ` +
          `(missing: ${missingFields.join(", ")}). \`name\` is not decoration — every duty is ` +
          `stamped with its author's name from the token's claims.`,
      );
    }
    if (missingOrigins.length) {
      todo.push(`On auth '${AUTH}', add the console's origins: ${missingOrigins.join(", ")}`);
    }
    if (settings.allowSignup === false) {
      todo.push(`On auth '${AUTH}', turn sign-up on, or nobody can create the first account.`);
    }
  }

  if (todo.length) {
    console.log(`\n  Left to do, in the console (https://console.altengine.net):\n`);
    for (const t of todo) console.log(`  • ${t}`);
    console.log(`\n  Then run this again — it will apply the access rules once auth exists.`);
  }
  console.log(`\n  Next:  npm run deploy    ALTENGINE_URL=${BASE} ALTENGINE_KEY=ak_…`);
  console.log(`         npm run build     the site and the console, into public/`);
}

async function main() {
  const [signup, access, indexes] = await Promise.all([
    readConfig("signup.json"),
    readConfig("access.json"),
    readConfig("indexes.json"),
  ]);
  const config = { signup, access, indexes };
  await (LOCAL ? provisionLocal(config) : provisionHosted(config));
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
