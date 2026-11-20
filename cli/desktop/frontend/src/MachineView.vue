<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { Events } from "@wailsio/runtime";
import { Machine, Setup, Updates } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import type { DeploymentStatus, UpdateStatus } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import { Snapshot, State } from "../bindings/github.com/altlimit/dutyboard/cli/desktop/host";

// The machine once it is connected: what it is doing, and its log.
const props = defineProps<{ status: Snapshot }>();
const status = computed(() => props.status);
const lines = ref<string[]>([]);
const busy = ref(false);
const problem = ref("");
const logEl = ref<HTMLElement | null>(null);

// The DutyBoard this machine works for, next to the version this app carries. When the app's is later,
// the machine says so and links to where whoever deployed it upgrades it, in their browser.
const deployment = ref<DeploymentStatus | null>(null);

async function checkDeployment() {
  try {
    deployment.value = await Setup.Deployment();
  } catch {
    deployment.value = null;
  }
}

// The folder its boards' repositories are kept in. Changing it restarts the machine, because the
// folder is read when it starts; nothing is moved.
async function changeProjects() {
  const chosen = await Setup.ChooseFolder(status.value.projects);
  if (chosen && chosen !== status.value.projects) await Machine.SetProjects(chosen);
}

// The app's own updates. It finds, downloads and checks them by itself, and installs one when no
// agent is working; this only says where that stands, and lets a person hurry it.
const update = ref<UpdateStatus | null>(null);
const updateText = computed(() => {
  const u = update.value;
  if (!u || !u.enabled) return "This build does not update itself.";
  switch (u.state) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading DutyBoard ${u.version}…`;
    case "ready":
      return `DutyBoard ${u.version} is downloaded.`;
    case "current":
      return "Up to date. Updates install by themselves.";
    case "error":
      return u.error;
    default:
      return "Updates install by themselves.";
  }
});

// Whether the app starts, in the tray, when the person signs in.
const autostart = ref(false);
async function setAutostart(on: boolean) {
  await Machine.SetAutostart(on);
  autostart.value = await Machine.Autostart();
}


const labels: Record<string, string> = {
  [State.Unpaired]: "Not set up",
  [State.Starting]: "Starting",
  [State.Working]: "Working",
  [State.Paused]: "Paused",
  [State.Stopping]: "Stopping",
  [State.External]: "Running elsewhere",
  [State.Failed]: "Needs attention",
};
const badges: Record<string, string> = {
  [State.Working]: "badge--done",
  [State.Starting]: "badge--active",
  [State.Stopping]: "badge--active",
  [State.Failed]: "badge--failed",
  [State.External]: "badge--needs_decision",
  [State.Unpaired]: "badge--needs_decision",
};

const label = computed(() => labels[status.value.state] ?? "…");
const running = computed(() => status.value.state === State.Working || status.value.state === State.Starting);

async function scrollLog() {
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
}

async function act(what: () => Promise<unknown>) {
  busy.value = true;
  problem.value = "";
  try {
    await what();
  } catch (e) {
    problem.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

// The log is always read whole from the app, and a line arriving is only the cue to read it again.
// Keeping lines as they arrive and adding them to a first read would race: the machine starts logging
// at the moment this view first appears, so a line can land between that read being answered and its
// answer being used — and be lost, or shown twice. Reads are numbered so a slow one cannot undo a
// newer one.
let asked = 0;
let due: ReturnType<typeof setTimeout> | undefined;
async function readLog() {
  const mine = ++asked;
  const all = await Machine.Logs();
  if (mine !== asked) return;
  lines.value = all;
  scrollLog();
}

const off: Array<() => void> = [];
onMounted(() => {
  off.push(
    Events.On("machine:log", () => {
      clearTimeout(due);
      due = setTimeout(readLog, 80);
    }),
    Events.On("update:status", (e) => (update.value = e.data)),
  );
  Updates.Status().then((u) => (update.value = u));
  readLog();
  checkDeployment();
  Machine.Autostart().then((on) => (autostart.value = on));
});
onUnmounted(() => {
  off.forEach((f) => f());
  clearTimeout(due);
});
</script>

<template>
  <main class="shell">
    <header class="head">
      <div>
        <h1>This machine</h1>
        <p class="muted">
          <template v-if="status.machine">{{ status.machine }} · </template>dutyboard {{ status.version }}
        </p>
      </div>
      <span id="state" class="badge" :class="badges[status.state]" :data-state="status.state">{{ label }}</span>
    </header>

    <section v-if="update?.state === 'ready'" id="update-ready" class="notice upgrade">
      <div>
        <strong>DutyBoard {{ update.version }} is ready to install.</strong>
        <p v-if="update.waiting">
          It installs by itself as soon as no agent is working. Installing it now restarts the app and stops the
          sessions that are running; their duties are resumed afterwards.
        </p>
        <p v-else>It installs by itself in a moment, and the app restarts.</p>
      </div>
      <button id="update-now" class="primary" :disabled="busy" @click="act(Updates.RestartNow)">Install and restart now</button>
    </section>

    <section v-if="deployment?.behind" id="upgrade" class="notice upgrade">
      <div>
        <strong>DutyBoard v{{ deployment.ours }} is out.</strong>
        <p>
          Your DutyBoard is on v{{ deployment.version }}. Whoever deployed it upgrades it in altengine, from their browser;
          it changes the board and the console for everyone on it, and this machine keeps working meanwhile.
        </p>
      </div>
      <button id="upgrade-now" class="primary" @click="Setup.Open(deployment.upgradeLink)">Open the upgrade</button>
    </section>
    <p v-else-if="deployment?.appIsOlder" id="app-older" class="notice notice--warn">
      Your DutyBoard is on v{{ deployment.version }} and this app is v{{ deployment.ours }}. Update the app to match it.
    </p>

    <section class="panel">
      <p v-if="status.state === State.External">
        Another dutyboard is already running on this machine, started by the command-line install. This app can take
        over from it.
      </p>
      <p v-else-if="status.state === State.Working">
        Agents on this machine are working your boards. Closing this window leaves them working; the app stays in the
        system tray.
      </p>
      <p v-else-if="status.state === State.Paused">Paused. The duties this machine holds are resumed when it starts again.</p>
      <p v-if="status.error" class="error">{{ status.error }}</p>
      <p v-if="problem" class="error">{{ problem }}</p>

      <dl class="facts">
        <dt>Projects folder</dt>
        <dd>
          <code id="projects">{{ status.projects }}</code>
          <button id="change-projects" class="link" :disabled="busy" @click="act(changeProjects)">Change…</button>
          <span class="hint">Each board's repository is cloned here. Changing it restarts this machine; what is in the old folder stays there.</span>
        </dd>
        <dt>Starting</dt>
        <dd>
          <label class="check" for="autostart">
            <input id="autostart" type="checkbox" :checked="autostart" :disabled="busy" @change="act(() => setAutostart(($event.target as HTMLInputElement).checked))" />
            <span>Start when I sign in, in the system tray</span>
          </label>
          <span class="hint">It starts from where the app is now, so keep the file where it is.</span>
        </dd>
        <dt>Updates</dt>
        <dd>
          <span id="update-text" :class="{ error: update?.state === 'error' }">{{ updateText }}</span>
          <button
            v-if="update?.enabled && update.state !== 'ready' && update.state !== 'checking' && update.state !== 'downloading'"
            id="check-updates"
            class="link"
            :disabled="busy"
            @click="act(() => Updates.Check())"
          >
            Check now
          </button>
        </dd>
      </dl>

      <div class="actions">
        <button v-if="running" id="pause" :disabled="busy" @click="act(Machine.Pause)">Pause</button>
        <button
          v-else-if="status.state === State.Paused || status.state === State.Failed"
          id="resume"
          class="primary"
          :disabled="busy"
          @click="act(Machine.Resume)"
        >
          Resume
        </button>
        <button v-if="status.state === State.External" id="takeover" class="primary" :disabled="busy" @click="act(Machine.TakeOver)">
          Run it here instead
        </button>
        <button id="console" :disabled="!status.console" @click="act(Machine.OpenConsole)">Open console</button>
        <button id="quit" class="danger quit" :disabled="busy" @click="act(Machine.Quit)">Quit DutyBoard</button>
      </div>
    </section>

    <section class="panel log">
      <div class="panel__head">
        <h2>Log</h2>
        <span class="muted">{{ status.home }}</span>
      </div>
      <pre ref="logEl" id="log"><template v-if="lines.length">{{ lines.join("\n") }}</template><span v-else class="muted">Nothing logged yet.</span></pre>
    </section>
  </main>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  /* At least the window, and more when there is more to say: the log keeps a readable height and the
     page scrolls, rather than the log being squeezed to a line. */
  min-height: 100vh;
  padding: 1.25rem;
  box-sizing: border-box;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.head p {
  margin: 0;
}
.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.75rem;
}
.quit {
  margin-left: auto;
}
.facts {
  margin: 0.75rem 0 0;
}
.facts dt {
  font-weight: 550;
  font-size: 0.9rem;
}
.facts dd + dt {
  margin-top: 0.6rem;
}
.check {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-weight: 400;
  margin: 0;
}
.check input {
  width: auto;
  flex: none;
}
.facts dd {
  margin: 0.15rem 0 0;
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  flex-wrap: wrap;
}
.facts code {
  font-family: var(--mono);
  font-size: 0.85rem;
  word-break: break-all;
}
.facts .hint {
  flex-basis: 100%;
  margin: 0;
}
.upgrade {
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}
.upgrade p {
  margin: 0.25rem 0 0;
}
.upgrade button {
  flex: none;
}
.error {
  color: var(--danger);
}
.log {
  flex: 1;
  min-height: 13rem;
  display: flex;
  flex-direction: column;
}
.log h2 {
  font-size: 1rem;
}
pre {
  flex: 1 1 8rem;
  min-height: 8rem;
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 0.75rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--mono);
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
