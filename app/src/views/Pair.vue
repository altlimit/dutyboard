<script setup>
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../lib/altengine.js";

// Approving a machine: the `dutyboard` program printed a code in a terminal, and this is where a
// signed-in person says "yes, that is mine". What they approve is shown first — its name and OS —
// because a code typed from a message somebody else sent is how a stranger's machine would ask for
// a key to your boards.

const route = useRoute();
const router = useRouter();
const code = ref(String(route.query.code || ""));
const pairing = ref(null);
const name = ref("");
const busy = ref(false);
const error = ref("");
const done = ref("");

async function lookup() {
  busy.value = true;
  error.value = "";
  pairing.value = null;
  try {
    pairing.value = await api("/connect/lookup", { user_code: code.value });
    name.value = pairing.value.machine_name;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function decide(approve) {
  busy.value = true;
  error.value = "";
  try {
    if (approve) {
      const res = await api("/connect/approve", { user_code: pairing.value.user_code, name: name.value });
      done.value = `${res.machine_name} is paired. It will start working in a moment — you can close this page.`;
    } else {
      await api("/connect/deny", { user_code: pairing.value.user_code });
      done.value = "Refused. That code no longer works.";
    }
    pairing.value = null;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  if (code.value) lookup();
});
</script>

<template>
  <div class="wrap wrap--narrow stack">
    <div>
      <h1>Pair a machine</h1>
      <p class="muted">
        Running <code class="mono">dutyboard</code> on a computer prints a code. Enter it here to let that
        computer work on your boards.
      </p>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <div v-if="done" class="notice stack" role="status">
      <p style="margin: 0">{{ done }}</p>
      <p style="margin: 0"><router-link :to="{ name: 'runners' }">See your machines</router-link></p>
    </div>

    <form v-if="!pairing && !done" class="panel stack" @submit.prevent="lookup">
      <div class="field">
        <label for="p-code">Code</label>
        <input id="p-code" v-model="code" required autocomplete="off" autocapitalize="characters" placeholder="KQTR-8841" class="mono" />
      </div>
      <div><button class="primary" type="submit" :disabled="busy || !code.trim()">Continue</button></div>
    </form>

    <section v-if="pairing" class="panel stack" aria-labelledby="approve-h">
      <h2 id="approve-h" style="margin: 0">Is this your machine?</h2>
      <dl class="facts">
        <dt>Name it gave</dt>
        <dd>{{ pairing.machine_name }}</dd>
        <dt>System</dt>
        <dd>{{ pairing.os || "unknown" }} {{ pairing.arch }}</dd>
        <dt>Program</dt>
        <dd>dutyboard {{ pairing.cli_version || "" }}</dd>
      </dl>
      <p class="notice notice--warn" style="margin: 0">
        Approve only a machine you started yourself. It will be able to work — and change code — on every
        board you link to it.
      </p>
      <div class="field">
        <label for="p-name">Call it</label>
        <input id="p-name" v-model="name" maxlength="60" />
      </div>
      <div class="row">
        <button class="primary" type="button" :disabled="busy" @click="decide(true)">Approve</button>
        <button type="button" class="danger" :disabled="busy" @click="decide(false)">Refuse</button>
        <button type="button" class="link" @click="router.push({ name: 'boards' })">Not now</button>
      </div>
    </section>
  </div>
</template>
