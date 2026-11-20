<script setup>
// Starting DutyBoard on a computer, one tab per system: the desktop app on Windows, `alt` and a
// terminal on macOS and Linux, and the headless form for a server. Each ends the same way — the
// program shows a code — and `then` says where that code goes from wherever this is shown.
import { computed, ref } from "vue";
import { config } from "../config.js";
import { ALT_INSTALL, DESKTOP_DOWNLOAD, INSTALL_COMMAND, guessOS, headlessCommand } from "../lib/runners.js";

defineProps({
  then: { type: String, default: "It shows a code. Enter it under Pair a machine, on your Machines page." },
});

const SYSTEMS = [
  { key: "windows", label: "Windows" },
  { key: "mac", label: "macOS" },
  { key: "linux", label: "Linux" },
];
const uid = `os-${Math.random().toString(36).slice(2, 8)}`;
const os = ref(guessOS());
const headless = computed(() => headlessCommand(config.api));

function tabKey(event) {
  const keys = SYSTEMS.map((s) => s.key);
  const at = keys.indexOf(os.value);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: keys.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  os.value = keys[(to + keys.length) % keys.length];
  document.getElementById(`${uid}-tab-${os.value}`)?.focus();
}

const copied = ref("");
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = text;
    setTimeout(() => copied.value === text && (copied.value = ""), 1500);
  } catch {
    /* selectable on screen anyway */
  }
}
</script>

<template>
  <div class="install stack">
    <div class="tabs" role="tablist" aria-label="Your computer's system" @keydown="tabKey">
      <button
        v-for="s in SYSTEMS"
        :id="`${uid}-tab-${s.key}`"
        :key="s.key"
        type="button"
        role="tab"
        class="tabs__tab"
        :aria-selected="os === s.key"
        :aria-controls="`${uid}-panel`"
        :tabindex="os === s.key ? 0 : -1"
        @click="os = s.key"
      >
        {{ s.label }}
      </button>
    </div>

    <div :id="`${uid}-panel`" role="tabpanel" :aria-labelledby="`${uid}-tab-${os}`" tabindex="0">
      <ol v-if="os === 'windows'" class="install__steps">
        <li>
          <p>Download the DutyBoard app and open it. It installs for you alone — no administrator.</p>
          <a class="btn btn--primary" :href="DESKTOP_DOWNLOAD">Download DutyBoard-Setup.exe</a>
        </li>
        <li>
          <p>Choose <strong>Join a DutyBoard</strong> and give it this address:</p>
          <div class="install__line">
            <code class="mono">{{ config.api }}</code>
            <button type="button" class="link small" @click="copy(config.api)">{{ copied === config.api ? "Copied" : "Copy" }}</button>
          </div>
        </li>
        <li><p>Pick the folder it keeps projects in. {{ then }}</p></li>
      </ol>

      <ol v-else class="install__steps">
        <li>
          <p>
            Open {{ os === "mac" ? "Terminal" : "a terminal" }} and install <code class="mono">alt</code>, once per computer. Open a
            new terminal after, so it is on your path.
          </p>
          <div class="install__code">
            <pre class="token">{{ ALT_INSTALL.unix }}</pre>
            <button type="button" class="install__copy" @click="copy(ALT_INSTALL.unix)">{{ copied === ALT_INSTALL.unix ? "Copied" : "Copy" }}</button>
          </div>
        </li>
        <li>
          <p>Install DutyBoard and run it:</p>
          <div class="install__code">
            <pre class="token">{{ INSTALL_COMMAND }}</pre>
            <button type="button" class="install__copy" @click="copy(INSTALL_COMMAND)">{{ copied === INSTALL_COMMAND ? "Copied" : "Copy" }}</button>
          </div>
        </li>
        <li>
          <p>When it asks which DutyBoard to connect to, give it this address:</p>
          <div class="install__line">
            <code class="mono">{{ config.api }}</code>
            <button type="button" class="link small" @click="copy(config.api)">{{ copied === config.api ? "Copied" : "Copy" }}</button>
          </div>
          <p class="small muted">{{ then }} It then sets itself to start {{ os === "mac" ? "when you log in" : "by itself" }}.</p>
        </li>
      </ol>

      <details class="install__more">
        <summary class="small">
          {{ os === "windows" ? "From PowerShell instead, or on a Windows server" : "A machine with no screen — a server, or over SSH" }}
        </summary>
        <div class="stack">
          <template v-if="os === 'windows'">
            <p class="small">Install <code class="mono">alt</code> once, open a new window, then run DutyBoard:</p>
            <div class="install__code">
              <pre class="token">{{ ALT_INSTALL.windows }}</pre>
              <button type="button" class="install__copy" @click="copy(ALT_INSTALL.windows)">{{ copied === ALT_INSTALL.windows ? "Copied" : "Copy" }}</button>
            </div>
          </template>
          <p class="small">
            With <code class="mono">alt</code> installed, this pairs it without asking anything, prints the code and a link, and sets it to start at boot:
          </p>
          <div class="install__code">
            <pre class="token">{{ headless }}</pre>
            <button type="button" class="install__copy" @click="copy(headless)">{{ copied === headless ? "Copied" : "Copy" }}</button>
          </div>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.install [role="tabpanel"] { padding-top: 0.25rem; }
.install__steps { margin: 0; padding-left: 1.4rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
.install__steps li > * + * { margin-top: 0.45rem; }
.install__steps p { margin: 0; }
/* A command scrolls sideways rather than breaking mid-word, with its Copy button in its corner. */
.install__code { position: relative; }
.install pre.token { white-space: pre; overflow-x: auto; word-break: normal; margin: 0; padding-right: 5.5rem; }
.install__copy { position: absolute; top: 0.35rem; right: 0.35rem; padding: 0.25rem 0.6rem; font-size: 0.8rem; }
.install__line { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
.install__line code { overflow-wrap: anywhere; }
.install__more { margin-top: 1rem; }
.install__more > .stack { margin-top: 0.6rem; }
.install__more p { margin: 0; }
</style>
