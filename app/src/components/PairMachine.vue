<script setup>
// Pairing a machine: how to start DutyBoard on it, then approving the code it prints — where a
// signed-in person says "yes, that is mine". What they approve is shown first — its name and OS —
// because a code typed from a message somebody else sent is how a stranger's machine would ask for
// a key to your boards.
//
// Shown in a panel over the Machines page, and as the page `dutyboard` opens with ?code= filled
// in, where the install steps are already behind you and are left out.
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../lib/altengine.js";
import MachineInstall from "./MachineInstall.vue";

const props = defineProps({
  code: { type: String, default: "" },
  inPanel: { type: Boolean, default: false },
});
const emit = defineEmits(["paired", "close"]);

const router = useRouter();
const code = ref(props.code);
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
      done.value = `${res.machine_name} is paired. It shows up in your machines within a few seconds, as soon as it checks in.`;
      emit("paired", res);
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

function notNow() {
  if (props.inPanel) emit("close");
  else router.push({ name: "runners" });
}

onMounted(() => {
  if (code.value) lookup();
});
</script>

<template>
  <div class="pair stack">
    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <div v-if="done" class="notice stack" role="status">
      <p style="margin: 0">{{ done }}</p>
      <p style="margin: 0">
        Back on that computer it sets itself to start by itself. Your Machines page shows what it still needs — an
        agent signed in, the GitHub CLI — and is where you put boards on it.
      </p>
      <p style="margin: 0">
        <button v-if="inPanel" type="button" class="primary" @click="emit('close')">Done</button>
        <router-link v-else :to="{ name: 'runners' }">See your machines</router-link>
      </p>
    </div>

    <template v-else-if="!pairing">
      <section v-if="!props.code" class="stack" aria-labelledby="pair-start-h">
        <h2 id="pair-start-h" class="pair__step"><span class="pair__num" aria-hidden="true">1</span> Start DutyBoard on the computer</h2>
        <p class="small muted" style="margin: 0">The one that should do the work, with the agents you want it to use installed and signed in.</p>
        <MachineInstall then="It shows a code — enter it in step 2." />
      </section>

      <form class="stack" aria-labelledby="pair-code-h" @submit.prevent="lookup">
        <h2 v-if="!props.code" id="pair-code-h" class="pair__step"><span class="pair__num" aria-hidden="true">2</span> Enter the code it shows</h2>
        <h2 v-else id="pair-code-h" class="sr-only">Enter the code</h2>
        <div class="field">
          <label for="p-code">Code</label>
          <input id="p-code" v-model="code" required autocomplete="off" autocapitalize="characters" placeholder="KQTR-8841" class="mono" />
        </div>
        <div><button class="primary" type="submit" :disabled="busy || !code.trim()">Continue</button></div>
      </form>
    </template>

    <section v-else class="stack" aria-labelledby="approve-h">
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
        <button type="button" class="link" @click="notNow">Not now</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pair__step { display: flex; align-items: center; gap: 0.55rem; margin: 0; font-size: 1.05rem; }
.pair__num {
  display: inline-grid; place-items: center; flex: none;
  width: 1.6rem; height: 1.6rem; border-radius: 50%;
  background: var(--surface-2); border: 1px solid var(--border);
  font-size: 0.85rem; font-weight: 700;
}
</style>
