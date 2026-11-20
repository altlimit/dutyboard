<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { Events } from "@wailsio/runtime";
import { Machine, Setup } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import type { SetupDefaults, SetupPairing } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import type { Snapshot } from "../bindings/github.com/altlimit/dutyboard/cli/desktop/host";
import mark from "./mark.svg";

// The first run. Two ways in, and they meet at the same last step:
//
//   Set up my own   deploy it from the browser → create your account → connect this machine
//   Join one        its address                                    → connect this machine
//
// Deploying is altengine's own page, where the person signs in and deploys DutyBoard as themselves:
// nothing on this machine holds a key to do it.
//
// Connecting is a code the person approves in the console; once it is approved the machine starts
// working, the app's status changes, and App.vue swaps this screen for the machine's.
defineProps<{ status: Snapshot }>();

type Step = "welcome" | "own" | "join" | "pairing";
const step = ref<Step>("welcome");
const defaults = ref<SetupDefaults | null>(null);
const problem = ref("");

// Connecting, from either way in.
const server = ref("");
const machineName = ref("");
const projects = ref("");
const autostart = ref(false);
const pairing = ref<SetupPairing | null>(null);
const cameFrom = ref<Step>("join");

// The call in progress, kept so that Cancel can stop it — and so its rejection can be told from a failure.
let running: { cancel: () => void } | null = null;
let cancelled = false;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function go(to: Step) {
  problem.value = "";
  step.value = to;
}

async function browse() {
  try {
    const chosen = await Setup.ChooseFolder(projects.value);
    if (chosen) projects.value = chosen;
  } catch (e) {
    problem.value = message(e);
  }
}

function cancel() {
  cancelled = true;
  running?.cancel();
}

/** Set up my own: altengine's deploy page, in the browser. */
async function deploy() {
  problem.value = "";
  try {
    await Setup.OpenDeploy();
  } catch (e) {
    problem.value = message(e);
  }
}

async function connect(from: Step) {
  cameFrom.value = from;
  go("pairing");
  pairing.value = null;
  cancelled = false;
  const call = Setup.Join(server.value, machineName.value, projects.value, autostart.value);
  running = call;
  try {
    await call;
    // Nothing to do here: the machine has started, and its status takes this screen away.
  } catch (e) {
    go(from);
    if (!cancelled) problem.value = message(e);
  } finally {
    running = null;
  }
}

const off: Array<() => void> = [];
onMounted(async () => {
  off.push(Events.On("setup:pairing", (e) => (pairing.value = e.data)));
  const d = await Setup.Defaults();
  defaults.value = d;
  machineName.value = d.machineName;
  projects.value = d.projects;
  autostart.value = d.autostart;
  server.value = d.server;
});
onUnmounted(() => {
  off.forEach((f) => f());
  running?.cancel();
});
</script>

<template>
  <main class="first">
    <header class="first__head">
      <img class="first__mark" :src="mark" alt="" width="40" height="40" />
      <div>
        <h1>DutyBoard</h1>
        <p class="muted">Agents on this machine work your boards, and ask you when they need a decision.</p>
      </div>
    </header>

    <!-- Where to start -->
    <section v-if="step === 'welcome'" class="stack">
      <p v-if="status.error" id="why" class="notice notice--warn">{{ status.error }}</p>
      <div v-if="defaults?.server" class="notice">
        <p>
          A DutyBoard is already set up at <code>{{ defaults.server }}</code
          >, and this machine is not connected to it yet.
        </p>
        <button id="continue" class="primary" @click="go('join')">Connect this machine to it</button>
      </div>
      <div class="choices">
        <button id="choose-own" class="choice" @click="go('own')">
          <strong>Set up my own DutyBoard</strong>
          <span>Deploy it into your altengine account from your browser, then make this its first machine.</span>
        </button>
        <button id="choose-join" class="choice" @click="go('join')">
          <strong>Join a DutyBoard</strong>
          <span>Someone has set one up already. This machine becomes one of the machines that work its boards.</span>
        </button>
      </div>
      <p class="first__foot"><button class="link" @click="Machine.Quit()">Quit</button></p>
    </section>

    <!-- Set up my own: deploy it in the browser, sign up, connect this machine -->
    <section v-else-if="step === 'own'" class="panel stack">
      <h2>Set up my own DutyBoard</h2>
      <p>
        DutyBoard runs in your own altengine account: its data, its console and its API are yours. You deploy it from
        your browser, as yourself, and nothing is kept on this machine to do it.
      </p>
      <ol class="how">
        <li>
          <strong>Deploy it.</strong> Sign in to altengine, choose the organization for your DutyBoard, and click
          <strong>Deploy</strong>.
          <div class="row how__act">
            <button id="deploy" class="primary" @click="deploy">Open altengine</button>
          </div>
        </li>
        <li>
          <strong>Create your account.</strong> When it is deployed, open its console from that page and sign up. The
          first account is the owner.
        </li>
        <li>
          <strong>Connect this machine</strong>, so its agents can work your boards.
          <div class="field how__act">
            <label for="server-own">Your console's address</label>
            <input id="server-own" v-model="server" type="url" spellcheck="false" placeholder="https://your-console.altengine.app" />
            <p class="hint">The page you just signed up on.</p>
          </div>
          <div class="field how__act">
            <label for="name-own">Name for this machine</label>
            <input id="name-own" v-model="machineName" type="text" spellcheck="false" />
          </div>
          <div class="field how__act">
            <label for="projects-own">Folder for this machine's projects</label>
            <div class="row folder">
              <input id="projects-own" v-model="projects" type="text" spellcheck="false" />
              <button type="button" id="browse-own" @click="browse">Browse…</button>
            </div>
            <p class="hint">Each board's repository is cloned here, and agents work in it. You can change it later.</p>
          </div>
          <div class="how__act">
            <label class="check" for="autostart-own">
              <input id="autostart-own" v-model="autostart" type="checkbox" />
              <span>Start DutyBoard when I sign in, so this machine is working without my opening it</span>
            </label>
          </div>
        </li>
      </ol>
      <p v-if="problem" class="notice notice--error">{{ problem }}</p>
      <div class="row">
        <button id="connect-own" class="primary" :disabled="!server.trim()" @click="connect('own')">Connect this machine</button>
        <button @click="go('welcome')">Back</button>
      </div>
    </section>

    <!-- Join one: its address -->
    <section v-else-if="step === 'join'" class="panel stack">
      <h2>Join a DutyBoard</h2>
      <div class="field">
        <label for="server">DutyBoard address</label>
        <input id="server" v-model="server" type="url" spellcheck="false" placeholder="https://your-console.altengine.app" />
        <p class="hint">The address of its console, the one you open in your browser. Its API address, from the console's Machines page, works too.</p>
      </div>
      <div class="field">
        <label for="name-join">Name for this machine</label>
        <input id="name-join" v-model="machineName" type="text" spellcheck="false" />
        <p class="hint">What this machine is called on the board.</p>
      </div>
      <div class="field">
        <label for="projects-join">Folder for this machine's projects</label>
        <div class="row folder">
          <input id="projects-join" v-model="projects" type="text" spellcheck="false" />
          <button type="button" id="browse-join" @click="browse">Browse…</button>
        </div>
        <p class="hint">Each board's repository is cloned here, and agents work in it. You can change it later.</p>
      </div>
      <label class="check" for="autostart-join">
        <input id="autostart-join" v-model="autostart" type="checkbox" />
        <span>Start DutyBoard when I sign in, so this machine is working without my opening it</span>
      </label>
      <p v-if="problem" class="notice notice--error">{{ problem }}</p>
      <div class="row">
        <button id="connect-join" class="primary" :disabled="!server.trim()" @click="connect('join')">Connect this machine</button>
        <button @click="go('welcome')">Back</button>
      </div>
    </section>

    <!-- Either way: the code to approve -->
    <section v-else-if="step === 'pairing'" class="panel stack pairing">
      <template v-if="pairing">
        <h2>Approve this machine</h2>
        <p v-if="pairing.link">Your console has opened in your browser. Check that it shows this code, and approve it.</p>
        <p v-else>Open your DutyBoard console, go to <strong>Pair a machine</strong>, and enter this code.</p>
        <p id="code" class="code">{{ pairing.code }}</p>
        <p class="muted">Waiting for you to approve it. The code expires in {{ pairing.minutes }} minutes.</p>
        <div class="row pairing__act">
          <button v-if="pairing.link" id="open-approval" @click="Setup.Open(pairing.link)">Open the approval page again</button>
          <button id="cancel-pairing" @click="cancel">Cancel</button>
        </div>
      </template>
      <template v-else>
        <h2>Connecting…</h2>
        <p class="muted">Asking <code>{{ server }}</code> for a code.</p>
        <div class="row pairing__act"><button @click="cancel">Cancel</button></div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.first {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-height: 100vh;
  max-width: 46rem;
  margin: 0 auto;
  padding: 1.5rem 1.25rem;
  box-sizing: border-box;
}
.first__head {
  display: flex;
  gap: 0.9rem;
  align-items: center;
}
.first__head p {
  margin: 0;
}
.first__mark {
  border-radius: 9px;
  flex: none;
}
.first__foot {
  text-align: center;
}
.choices {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
}
.choice {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: flex-start;
  text-align: left;
  padding: 1.1rem;
  height: 100%;
  white-space: normal;
}
.choice strong {
  font-size: 1.05rem;
}
.choice span {
  color: var(--text-dim);
  font-weight: 400;
  line-height: 1.45;
}
.choice:hover {
  border-color: var(--accent);
}
.how {
  margin: 0;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  line-height: 1.5;
}
.how__act {
  margin-top: 0.5rem;
}
.check {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  font-weight: 400;
  margin: 0;
}
.check input {
  width: auto;
  flex: none;
  margin-top: 0.2rem;
}
.folder input {
  flex: 1;
  min-width: 14rem;
}
code {
  font-family: var(--mono);
  font-size: 0.85em;
  word-break: break-all;
}
.pairing {
  text-align: center;
}
.pairing__act {
  justify-content: center;
}
.code {
  font-family: var(--mono);
  font-size: 2.6rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  margin: 0.5rem 0;
  user-select: all;
}
</style>
