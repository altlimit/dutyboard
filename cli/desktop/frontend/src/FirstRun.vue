<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Events } from "@wailsio/runtime";
import { Machine, Setup } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import type { Provisioned, SetupDefaults, SetupPairing } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import type { Snapshot } from "../bindings/github.com/altlimit/dutyboard/cli/desktop/host";
import SetupProgress from "./SetupProgress.vue";
import mark from "./mark.svg";

// The first run. Two ways in, and they meet at the same last step:
//
//   Set up my own   sign in to altengine (or paste a key) → provisioning (live) → create your account → connect this machine
//   Join one        its address                                     → connect this machine
//
// Connecting is a code the person approves in the console; once it is approved the machine starts
// working, the app's status changes, and App.vue swaps this screen for the machine's.
defineProps<{ status: Snapshot }>();

type Step = "welcome" | "own" | "signin" | "progress" | "account" | "join" | "pairing";
const step = ref<Step>("welcome");
const defaults = ref<SetupDefaults | null>(null);
const problem = ref("");

// Set up my own.
const key = ref("");
const altengine = ref("");
const advanced = ref(false);
const made = ref<Provisioned | null>(null);
// Signing in is the way in; a pasted key is for the emulator, an altengine of your own, or a person
// who would rather make one.
const pasting = ref(false);
const org = ref("");

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

const local = computed(() => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(altengine.value.trim()));
// Only altengine itself has "Sign in with altengine"; an emulator takes any key.
const canSignIn = computed(() => {
  const a = altengine.value.trim().replace(/\/+$/, "");
  return !a || a === defaults.value?.hosted;
});
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

/** "Sign in with altengine": the browser opens altengine's consent page, and the key it ends in is kept
 *  on this machine — so provisioning, and every upgrade after it, needs nothing pasted. */
async function signIn() {
  go("signin");
  cancelled = false;
  const call = Setup.SignIn();
  running = call;
  try {
    const result = await call;
    org.value = result?.org ?? "";
    key.value = "";
    go("progress");
  } catch (e) {
    go("own");
    // Declining in the browser is an answer, not a failure: back to where it started, quietly.
    const text = message(e);
    if (!cancelled && !/cancelled in the browser/i.test(text)) problem.value = text;
  } finally {
    running = null;
  }
}

function provisioned(result: unknown) {
  made.value = result as Provisioned;
  server.value = made.value.server;
  key.value = "";
  go("account");
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
          <span>Creates it in your altengine account, then makes this its first machine. You sign in with altengine to allow it.</span>
        </button>
        <button id="choose-join" class="choice" @click="go('join')">
          <strong>Join a DutyBoard</strong>
          <span>Someone has set one up already. This machine becomes one of the machines that work its boards.</span>
        </button>
      </div>
      <p class="first__foot"><button class="link" @click="Machine.Quit()">Quit</button></p>
    </section>

    <!-- Set up my own: signing in to altengine, or a key -->
    <section v-else-if="step === 'own'" class="panel stack">
      <h2>Set up my own DutyBoard</h2>
      <template v-if="canSignIn && !pasting">
        <p>
          DutyBoard runs in your own altengine account: its data, its console and its API are yours. Sign in to altengine
          and approve DutyBoard to create them.
        </p>
        <p class="hint">
          It asks only for instances whose names start with <code>dutyboard</code>. Nothing else in your account is
          visible to it. You can revoke it any time under Settings → API keys in the altengine console.
        </p>
        <p v-if="problem" class="notice notice--error">{{ problem }}</p>
        <div class="row">
          <button id="signin" class="primary" @click="signIn">Sign in with altengine</button>
          <button id="back" @click="go('welcome')">Back</button>
        </div>
        <p>
          <button id="paste" class="link" @click="pasting = true">Paste an API key instead</button>
          ·
          <button id="advanced" class="link" @click="advanced = !advanced">{{ advanced ? "Hide" : "Use a different altengine" }}</button>
        </p>
      </template>
      <template v-else>
        <p>
          DutyBoard runs in your own altengine account: its data, its console and its API are yours. To create them, this
          needs an altengine API key that may create instances and deploy functions.
        </p>
        <ol v-if="!local" class="how">
          <li>
            Open the <button class="link" @click="Setup.Open('https://console.altengine.net')">altengine console</button> and
            go to Settings → API keys.
          </li>
          <li>Create a key with <strong>Instances &amp; data: Write</strong> and <strong>Functions: Write</strong>.</li>
          <li>Paste it here.</li>
        </ol>
        <div class="field">
          <label for="key">altengine API key</label>
          <input id="key" v-model="key" type="password" autocomplete="off" spellcheck="false" :placeholder="local ? 'not needed for an emulator' : 'ae_…'" />
          <p class="hint">Used now to create your DutyBoard. You are asked afterwards whether to keep it on this machine.</p>
        </div>
        <p>
          <button v-if="canSignIn" id="signin-instead" class="link" @click="pasting = false">Sign in with altengine instead</button>
          <template v-if="canSignIn"> · </template>
          <button id="advanced" class="link" @click="advanced = !advanced">{{ advanced ? "Hide" : "Use a different altengine" }}</button>
        </p>
      </template>
      <div v-if="advanced" class="field">
        <label for="altengine">altengine address</label>
        <input id="altengine" v-model="altengine" type="url" spellcheck="false" :placeholder="defaults?.hosted" />
        <p class="hint">Leave empty for altengine itself. A local emulator is usually http://127.0.0.1:9191.</p>
      </div>
      <template v-if="!canSignIn || pasting">
        <p v-if="problem" class="notice notice--error">{{ problem }}</p>
        <div class="row">
          <button id="provision" class="primary" :disabled="!key.trim() && !local" @click="go('progress')">Set it up</button>
          <button id="back" @click="go('welcome')">Back</button>
        </div>
      </template>
    </section>

    <!-- Set up my own: waiting for the person in the browser -->
    <section v-else-if="step === 'signin'" class="panel stack">
      <h2>Sign in with altengine</h2>
      <p>
        altengine has opened in your browser. Sign in, choose the organization for your DutyBoard, and click
        <strong>Authorize</strong>. This window carries on by itself once you have.
      </p>
      <div class="row">
        <button id="signin-cancel" @click="cancel">Cancel</button>
      </div>
    </section>

    <!-- Set up my own: what it is doing -->
    <SetupProgress
      v-else-if="step === 'progress'"
      :title="org ? `Setting up your DutyBoard in ${org}…` : 'Setting up your DutyBoard…'"
      :run="() => Setup.Provision(altengine, key)"
      @done="provisioned"
      @back="go('own')"
    />

    <!-- Set up my own: the first account, then this machine -->
    <section v-else-if="step === 'account'" class="panel stack">
      <h2>Your DutyBoard is ready</h2>
      <p>
        Version {{ made?.version }}, at <code>{{ made?.server }}</code>
      </p>
      <ol class="how">
        <li>
          <strong>Create your account.</strong> Open your console and sign up. The first account is the owner.
          <div class="row how__act">
            <button id="open-console" :disabled="!made?.console" @click="Setup.Open(made!.console)">Open your console</button>
            <code v-if="made?.console">{{ made.console }}</code>
          </div>
        </li>
        <li>
          <strong>Connect this machine</strong>, so its agents can work your boards. You approve it in the console you just
          signed in to.
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
        <button id="connect-own" class="primary" @click="connect('account')">Connect this machine</button>
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
