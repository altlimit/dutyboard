<script setup>
// Point this console at someone else's altengine.
//
// The app has always read its target from localStorage before falling back to what it was
// built with (see config.js) — this is the screen that writes those values. It is what
// makes ONE hosted console usable against YOUR account: the page is served from
// dutyboard.com, the data never is.
//
// It has to be reachable before sign-in, because signing in is already a call to the auth
// instance being configured here.

import { onMounted, ref } from "vue";
import { config, DEFAULTS, clearOverrides, saveOverrides } from "../config.js";

const form = ref({
  baseUrl: config.baseUrl,
  auth: config.auth,
  datastore: config.datastore,
  channel: config.channel,
  functions: config.functions,
  fn: config.fn,
});

const checking = ref(false);
const result = ref(null);

const isDefault = () =>
  Object.keys(form.value).every((k) => String(form.value[k]).replace(/\/+$/, "") === String(DEFAULTS[k]).replace(/\/+$/, ""));

/** Where the function would be reached, given what is in the form. Shown because it is
 *  derived rather than typed, and a surprise here is the whole failure. */
function apiPreview() {
  const base = form.value.baseUrl.replace(/\/+$/, "");
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base);
  return local ? `${base}/fn/${form.value.functions}/${form.value.fn}` : `https://${form.value.functions}-fn.altengine.app/${form.value.fn}`;
}

/**
 * Try the two things that have to work, and say which one did not.
 *
 * Saving a typo here produces a console that loads and then fails every call with a CORS
 * error in a place that does not name the cause. One request each answers it up front:
 * the auth instance has to serve its sign-up config to this origin, and the function has
 * to answer /health.
 */
async function check() {
  checking.value = true;
  result.value = null;
  const base = form.value.baseUrl.replace(/\/+$/, "");
  const out = { auth: null, authWarn: "", api: null };
  try {
    const res = await fetch(`${base}/v1/auth/${encodeURIComponent(form.value.auth)}/config`);
    const cfg = await res.json().catch(() => ({}));
    if (!res.ok) {
      out.auth = `answered ${res.status}`;
    } else {
      // A 200 is not enough. An emulator creates an instance the moment it is named, so a
      // typo answers perfectly with a blank instance — and the first thing anyone would
      // notice is duties with no author on them. What it COLLECTS is the real answer.
      const fields = (cfg.signup?.fields || cfg.fields || []).map((f) => f.key || f.name).filter(Boolean);
      out.auth = fields.length ? `ok — collects ${fields.join(", ")}` : "ok, but it collects nothing";
      if (!fields.includes("name")) {
        out.authWarn =
          "No 'name' field. Sign-up works, but every duty and answer you post is recorded " +
          "without an author name. Add it to the instance's sign-up form (backend/signup.json).";
      }
    }
  } catch (err) {
    out.auth = err.message || "unreachable";
  }
  try {
    const res = await fetch(`${apiPreview()}/health`);
    const body = await res.json().catch(() => ({}));
    out.api = res.ok && body.ok ? `ok (${body.service} ${body.version || ""})`.trim() : `answered ${res.status}`;
  } catch (err) {
    out.api = err.message || "unreachable";
  }
  result.value = out;
  checking.value = false;
}

function save() {
  saveOverrides(form.value);
  // A full reload, not a route change. Every module in the app read the old config when it
  // was imported — the socket, the datastore URLs, the API base — and there is no honest
  // way to swap that underneath them.
  location.assign(import.meta.env.BASE_URL + "#/signin");
  location.reload();
}

function reset() {
  clearOverrides();
  location.assign(import.meta.env.BASE_URL + "#/signin");
  location.reload();
}

onMounted(check);
</script>

<template>
  <div class="wrap wrap--narrow stack">
    <div>
      <h1>Connect your altengine</h1>
      <p class="muted" style="margin: 0">
        This console is a static page. It talks to <strong>your</strong> altengine account
        directly — your boards, duties and agent tokens live in your own instances, and
        nothing about them reaches whoever served you this page.
      </p>
    </div>

    <form class="panel panel--form stack" @submit.prevent="save">
      <h2 class="section-h">Where your instances are</h2>

      <div class="field">
        <label for="c-url">altengine API</label>
        <input id="c-url" v-model="form.baseUrl" required inputmode="url" placeholder="https://api.altengine.net" />
        <p class="hint">The API origin. A local emulator is <code>http://127.0.0.1:9191</code>.</p>
      </div>

      <div class="field">
        <label for="c-auth">Auth instance</label>
        <input id="c-auth" v-model="form.auth" required placeholder="dutyboard-auth" />
        <p class="hint">Where your account lives. Sign-up and sign-in go here.</p>
      </div>

      <div class="field">
        <label for="c-ds">Datastore instance</label>
        <input id="c-ds" v-model="form.datastore" required placeholder="dutyboard" />
      </div>

      <div class="field">
        <label for="c-ch">Channel instance</label>
        <input id="c-ch" v-model="form.channel" required placeholder="dutyboard-live" />
        <p class="hint">Live board updates. Everything works without it, just not instantly.</p>
      </div>

      <div class="field">
        <label for="c-fn">Functions instance</label>
        <input id="c-fn" v-model="form.functions" required placeholder="dutyboard" />
      </div>

      <div class="field">
        <label for="c-fnname">Function name</label>
        <input id="c-fnname" v-model="form.fn" required placeholder="board" />
        <p class="hint">
          The state machine will be called at <code>{{ apiPreview() }}</code>
        </p>
      </div>

      <div
        v-if="result"
        class="notice"
        :class="{ 'notice--error': !String(result.auth).startsWith('ok') || !String(result.api).startsWith('ok') }"
        role="status"
      >
        <strong>Auth instance:</strong> {{ result.auth }}<br />
        <strong>Function:</strong> {{ result.api }}
        <p v-if="result.authWarn" class="small" style="margin: 0.5rem 0 0">{{ result.authWarn }}</p>
        <p v-if="!String(result.auth).startsWith('ok')" class="small" style="margin: 0.5rem 0 0">
          If that is a network or CORS error, add this page's origin
          (<code class="mono">{{ typeof window !== "undefined" ? window.location.origin : "" }}</code>) to the auth
          instance's allowed origins and to the functions instance's CORS origins.
        </p>
      </div>

      <div class="row">
        <button class="primary" type="submit">Save and reload</button>
        <button type="button" :disabled="checking" @click="check">{{ checking ? "Checking…" : "Test connection" }}</button>
        <span class="spacer"></span>
        <button v-if="!isDefault()" type="button" @click="reset">Reset to default</button>
      </div>
    </form>

    <p class="small muted">
      Not set up yet? <a :href="'https://github.com/altlimit/dutyboard#deploying-to-hosted-altengine'">Provision it in one command</a>,
      then come back here. Or
      <router-link :to="{ name: 'signin' }">go back to signing in</router-link>.
    </p>
  </div>
</template>
