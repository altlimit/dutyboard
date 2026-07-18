<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { authConfig, passwordlessStart } from "../lib/altengine.js";
import { session } from "../lib/session.js";

const route = useRoute();
const router = useRouter();

// mode: "signin" | "signup" | "passwordless" | "mfa"
const mode = ref("signin");
const cfg = ref(null);
const loadError = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");

const form = reactive({}); // dynamic: identity field + extra fields + password
const identifier = ref("");
const password = ref("");
const code = ref("");
const mfaToken = ref("");

const identityField = computed(() => (cfg.value ? cfg.value.identity_field : "identifier"));
const identityLabel = computed(() => {
  const f = cfg.value && cfg.value.fields.find((x) => x.key === identityField.value);
  return (f && f.label) || labelFor(identityField.value);
});
const extraFields = computed(() =>
  cfg.value ? cfg.value.fields.filter((f) => f.key !== identityField.value) : []
);
const methods = computed(() => (cfg.value && cfg.value.methods) || {});
const canSignup = computed(() => cfg.value && cfg.value.allow_signup);

function labelFor(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}
function inputType(field) {
  if (field.type === "email") return "email";
  if (field.key === "password") return "password";
  return "text";
}

onMounted(async () => {
  try {
    cfg.value = await authConfig();
    for (const f of cfg.value.fields) form[f.key] = "";
  } catch (e) {
    loadError.value =
      "Couldn't reach the DutyBoard backend. Check that the altengine API URL and the auth instance name are configured (see the site README).";
  }
});

function goNext() {
  const next = route.query.next;
  router.push(typeof next === "string" ? next : { name: "cities" });
}

async function submit() {
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    if (mode.value === "signin") {
      const res = await session.signIn(identifier.value.trim(), password.value);
      if (res.mfaRequired) {
        mfaToken.value = res.mfaToken;
        mode.value = "mfa";
        notice.value = "Enter your two-factor code to finish signing in.";
      } else {
        goNext();
      }
    } else if (mode.value === "signup") {
      const payload = { ...form, password: password.value };
      await session.signUp(payload);
      goNext();
    } else if (mode.value === "passwordless") {
      if (!code.value) {
        await passwordlessStart(identifier.value.trim());
        notice.value = "If that account exists, we emailed a sign-in code. Enter it below.";
      } else {
        const res = await session.passwordlessVerify(identifier.value.trim(), code.value.trim());
        if (res.mfaRequired) {
          mfaToken.value = res.mfaToken;
          mode.value = "mfa";
          notice.value = "Enter your two-factor code to finish signing in.";
        } else {
          goNext();
        }
      }
    } else if (mode.value === "mfa") {
      await session.verifyMfa(mfaToken.value, code.value.trim());
      goNext();
    }
  } catch (e) {
    error.value = e.message || "Something went wrong. Please try again.";
  } finally {
    busy.value = false;
  }
}

function switchMode(m) {
  mode.value = m;
  error.value = "";
  notice.value = "";
  code.value = "";
}
</script>

<template>
  <h1>Sign in to DutyBoard</h1>

  <p v-if="loadError" class="alert alert--error" role="alert">{{ loadError }}</p>

  <template v-else>
    <!-- aria-live region announces async validation + notices to screen readers -->
    <div aria-live="polite">
      <p v-if="notice" class="alert alert--info">{{ notice }}</p>
      <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
    </div>

    <form v-if="cfg" @submit.prevent="submit" novalidate>
      <!-- SIGN UP: render all configured fields -->
      <template v-if="mode === 'signup'">
        <div class="field" v-for="f in cfg.fields" :key="f.key">
          <label :for="'f-' + f.key">{{ f.label || labelFor(f.key) }}<span v-if="f.required" aria-hidden="true"> *</span></label>
          <input
            :id="'f-' + f.key"
            v-model="form[f.key]"
            :type="inputType(f)"
            :required="f.required"
            :autocomplete="f.type === 'email' ? 'email' : 'off'"
          />
        </div>
        <div class="field">
          <label for="f-password">Password *</label>
          <input id="f-password" v-model="password" type="password" required autocomplete="new-password" />
          <p class="field__hint">At least 8 characters.</p>
        </div>
      </template>

      <!-- SIGN IN (password) -->
      <template v-else-if="mode === 'signin'">
        <div class="field">
          <label for="f-id">{{ identityLabel }}</label>
          <input id="f-id" v-model="identifier" :type="cfg && identityField === 'email' ? 'email' : 'text'" required autocomplete="username" />
        </div>
        <div class="field">
          <label for="f-pw">Password</label>
          <input id="f-pw" v-model="password" type="password" required autocomplete="current-password" />
        </div>
      </template>

      <!-- PASSWORDLESS -->
      <template v-else-if="mode === 'passwordless'">
        <div class="field">
          <label for="f-idl">{{ identityLabel }}</label>
          <input id="f-idl" v-model="identifier" type="text" required autocomplete="username" />
        </div>
        <div class="field" v-if="notice">
          <label for="f-code">Emailed code</label>
          <input id="f-code" v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" />
        </div>
      </template>

      <!-- MFA -->
      <template v-else-if="mode === 'mfa'">
        <div class="field">
          <label for="f-mfa">Two-factor code</label>
          <input id="f-mfa" v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" required />
        </div>
      </template>

      <div class="btn-row">
        <button class="btn" type="submit" :disabled="busy">
          <span v-if="busy" class="spin" aria-hidden="true">⏳</span>
          <span v-if="mode === 'signup'">Create account</span>
          <span v-else-if="mode === 'passwordless'">{{ notice ? "Verify code" : "Email me a code" }}</span>
          <span v-else-if="mode === 'mfa'">Verify</span>
          <span v-else>Sign in</span>
        </button>
      </div>
    </form>

    <p v-else class="muted">Loading sign-in options…</p>

    <!-- mode switches -->
    <nav v-if="cfg && mode !== 'mfa'" class="btn-row" aria-label="Other sign-in options" style="margin-top: 1rem">
      <button v-if="mode !== 'signin'" type="button" class="btn btn--ghost btn--sm" @click="switchMode('signin')">Password sign-in</button>
      <button v-if="methods.passwordless && mode !== 'passwordless'" type="button" class="btn btn--ghost btn--sm" @click="switchMode('passwordless')">
        Email me a code
      </button>
      <button v-if="canSignup && mode !== 'signup'" type="button" class="btn btn--ghost btn--sm" @click="switchMode('signup')">Create an account</button>
    </nav>
  </template>
</template>
