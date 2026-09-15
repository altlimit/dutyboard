<script setup>
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { authConfig, signIn, signUp, passwordlessStart, passwordlessVerify } from "../lib/altengine.js";
import { config } from "../config.js";

const route = useRoute();
const router = useRouter();

const mode = ref("signin"); // signin | signup | code
const cfg = ref(null);
const email = ref("");
const password = ref("");
const name = ref("");
const code = ref("");
const busy = ref(false);
const error = ref("");
const status = ref("");

/**
 * What the auth instance actually offers. Read from its own config rather than assumed,
 * because both of these are per-instance and getting them wrong is silent: an offer to
 * create an account that the instance will refuse, or a sign-in method that exists and is
 * never shown.
 *
 * The shape is the API's: `allow_signup` at the top, methods nested under `methods`. This
 * page used to read `cfg.passwordless`, which is never set — so the mailed-code button, the
 * only way in for an account created by an agent, did not render at all.
 */
const canSignUp = computed(() => !cfg.value || cfg.value.allow_signup !== false);
const canEmailCode = computed(() => !!(cfg.value && cfg.value.methods && cfg.value.methods.passwordless));

/**
 * A sign-in code carried in the link, verified without anyone typing anything.
 *
 * This is the last step of an agent-provisioned install: it created the account (so there is
 * no password anyone knows) and minted a one-time code (so nothing had to be emailed by an
 * instance that may not be able to send mail). Handing over a link is then the whole of
 * "here is your board".
 *
 * The code rides in the HASH, which browsers do not send to any server — not in the request
 * line, not in Referer. It is still a credential: single use, minutes long, and consumed the
 * moment this page loads. If it fails, say so plainly and leave the normal form underneath
 * rather than a dead end.
 */
async function trySignInLink() {
  const q = route.query || {};
  const code = typeof q.code === "string" ? q.code.trim() : "";
  const who = typeof q.identifier === "string" ? q.identifier : typeof q.email === "string" ? q.email : "";
  if (!code || !who) return false;
  email.value = who;
  busy.value = true;
  status.value = `Signing you in as ${who}…`;
  try {
    await passwordlessVerify(who, code);
    // Drop the code from the URL before navigating: it is spent, and a spent credential in
    // the address bar is something someone will paste to a colleague and be confused by.
    router.replace({ name: "signin", query: {} });
    go();
    return true;
  } catch (err) {
    status.value = "";
    error.value =
      `That sign-in link did not work (${err.message}). A link can only be used once and expires ` +
      `after a few minutes — ask for a new one, or sign in below.`;
    return false;
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    cfg.value = await authConfig();
    // A link straight to the sign-up form on an instance that is closed would otherwise
    // render a form whose only outcome is a refusal.
    if (!canSignUp.value && mode.value === "signup") mode.value = "signin";
    await trySignInLink();
  } catch (err) {
    // The one cause a person can fix from here: the page moved (a renamed site, a new host), and the
    // auth instance does not know its new address yet.
    error.value = /origin/i.test(err.message || "")
      ? `This page's address, ${location.origin}, is not on your deployment's allowed origins yet — ` +
        `run \`dutyboard --provision-only\` again (it adds wherever the console is now served), or add it ` +
        `to the auth instance's allowed origins and the functions instance's CORS list in the altengine console.`
      : `Could not reach the auth service (${err.message}). Check that the altengine this console points at is up.`;
  }
});

const go = () => router.push(route.query.next || { name: "boards" });

async function run(fn) {
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (err) {
    error.value = err.message || String(err);
  } finally {
    busy.value = false;
  }
}

const doSignIn = () =>
  run(async () => {
    const res = await signIn(email.value, password.value);
    if (res.mfaRequired) throw new Error("This account has two-factor enabled, which this console does not handle yet.");
    go();
  });

const doSignUp = () =>
  run(async () => {
    await signUp({ email: email.value, name: name.value, password: password.value });
    go();
  });

const doStartCode = () =>
  run(async () => {
    await passwordlessStart(email.value);
    mode.value = "code";
    // Deliberately vague: /start never reveals whether the account exists.
    status.value = `If ${email.value} has an account, a sign-in code is on its way.`;
  });

const doVerifyCode = () =>
  run(async () => {
    const res = await passwordlessVerify(email.value, code.value);
    if (res.mfaRequired) throw new Error("This account has two-factor enabled, which this console does not handle yet.");
    go();
  });
</script>

<template>
  <div class="wrap wrap--narrow stack">
    <div>
      <h1>Sign in to DutyBoard</h1>
      <p class="muted">
        Boards are private to the person who owns them. Agents connect separately, with a
        project token you mint once you are in.
      </p>
      <p class="small muted" style="margin: 0">
        This page talks to <code class="mono">{{ config.baseUrl }}</code> ·
        <router-link :to="{ name: 'connect' }">use your own altengine</router-link>
      </p>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="status" class="notice" role="status">{{ status }}</p>

    <form v-if="mode === 'signin'" class="panel stack" @submit.prevent="doSignIn">
      <h2>Sign in</h2>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" v-model="email" type="email" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" v-model="password" type="password" autocomplete="current-password" required />
      </div>
      <div class="row">
        <button class="primary" type="submit" :disabled="busy">{{ busy ? "Signing in…" : "Sign in" }}</button>
        <button v-if="canSignUp" type="button" class="link" @click="mode = 'signup'">Create an account</button>
        <button v-if="canEmailCode" type="button" class="link" :disabled="busy || !email" @click="doStartCode">
          Email me a code
        </button>
      </div>
      <p v-if="!canSignUp" class="hint" style="margin: 0">
        This altengine is not accepting new accounts. If yours was set up for you, sign in with
        the email address it was created with — <strong>Email me a code</strong> works without a
        password.
      </p>
    </form>

    <form v-else-if="mode === 'signup' && canSignUp" class="panel stack" @submit.prevent="doSignUp">
      <h2>Create an account</h2>
      <div class="field">
        <label for="su-name">Your name</label>
        <input id="su-name" v-model="name" required autocomplete="name" />
        <p class="hint">Shown on the answers you post to a duty's thread.</p>
      </div>
      <div class="field">
        <label for="su-email">Email</label>
        <input id="su-email" v-model="email" type="email" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="su-password">Password</label>
        <input id="su-password" v-model="password" type="password" autocomplete="new-password" required minlength="8" />
      </div>
      <div class="row">
        <button class="primary" type="submit" :disabled="busy">{{ busy ? "Creating…" : "Create account" }}</button>
        <button type="button" class="link" @click="mode = 'signin'">I already have one</button>
      </div>
    </form>

    <form v-else class="panel stack" @submit.prevent="doVerifyCode">
      <h2>Enter your code</h2>
      <div class="field">
        <label for="code">Six-digit code</label>
        <input id="code" v-model="code" inputmode="numeric" autocomplete="one-time-code" required />
        <p class="hint">Running the emulator? It prints the code to its own terminal.</p>
      </div>
      <div class="row">
        <button class="primary" type="submit" :disabled="busy">{{ busy ? "Checking…" : "Sign in" }}</button>
        <button type="button" class="link" @click="mode = 'signin'">Back</button>
      </div>
    </form>
  </div>
</template>
