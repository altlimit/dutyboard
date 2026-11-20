<script setup>
// The MCP servers a board's sessions get: part of the board's profile, edited on its own tab in board
// settings and inline when a board is made (where a board run through its MCP servers needs one).
import { computed, reactive } from "vue";
import { mcpServerDraft } from "../lib/runners.js";

const draft = defineModel({ type: Object, required: true });
// `titled`: the page already headed it "MCP servers", so the fieldset's own legend is for screen readers only.
defineProps({ idPrefix: { type: String, default: "pf" }, disabled: { type: Boolean, default: false }, titled: { type: Boolean, default: false } });

const service = computed(() => draft.value.workspace === "service");

// Each server is a card that shows one line until opened. One just added opens, since it is empty.
const open = reactive(new WeakSet());
const toggle = (s) => (open.has(s) ? open.delete(s) : open.add(s));
const addServer = () => {
  const s = reactive(mcpServerDraft());
  open.add(s);
  draft.value.mcp_servers = [...(draft.value.mcp_servers || []), s];
};
const removeServer = (i) => {
  draft.value.mcp_servers = draft.value.mcp_servers.filter((_, j) => j !== i);
};

const lines = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The closed card's line: where it runs, and what it asks for. */
function summary(s) {
  const where = s.kind === "url" ? s.url : [s.command, ...lines(s.args)].join(" ");
  const secrets = lines(s.secrets).length;
  const tools = lines(s.tools).length;
  return [where || "not set up yet", secrets ? plural(secrets, "secret", "secrets") : "", tools ? plural(tools, "tool", "tools") : "all tools"].filter(Boolean);
}
</script>

<template>
  <fieldset class="stack" :disabled="disabled">
    <legend :class="titled ? 'sr-only' : 'label'">MCP servers <span v-if="!service" class="muted">(optional)</span></legend>
    <p v-if="service" class="hint">
      <strong>The account's server goes here</strong> — it is how the board's sessions reach it, and the board needs at least
      one. A machine missing a server's secrets takes none of this board's duties until they are set.
    </p>
    <p class="hint">
      More tools for this board's sessions — a browser to take screenshots with, an issue tracker, docs. Each machine
      starts or connects to them for every duty it works here. Only what you list is connected, and only the tools
      you name, if you name any.
    </p>
    <p class="hint">
      <strong>Nothing here is private:</strong> everyone on the board can read it. Name a server's credentials under
      secrets, and give each machine their values: on the Machines page, where they are encrypted for that machine alone, or on the machine
      with <code class="mono">dutyboard --mcp-secrets</code>.
    </p>
    <div v-for="(s, i) in draft.mcp_servers" :key="i" class="mcp-server" :class="{ 'mcp-server--open': open.has(s) }">
      <button
        type="button"
        class="mcp-server__head"
        :aria-expanded="open.has(s)"
        :aria-controls="`${idPrefix}-mcp-${i}-body`"
        @click="toggle(s)"
      >
        <svg class="mcp-server__chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span class="mcp-server__title">
          <strong class="mono">{{ s.name || "New server" }}</strong>
          <span class="badge">{{ s.kind === "url" ? "URL" : "Command" }}</span>
        </span>
        <span class="mcp-server__summary small muted">
          <span v-for="(part, j) in summary(s)" :key="j" :class="{ mono: j === 0 }">{{ part }}</span>
        </span>
      </button>
      <div v-if="open.has(s)" :id="`${idPrefix}-mcp-${i}-body`" class="mcp-server__body stack">
        <div class="field">
          <label :for="`${idPrefix}-mcp-${i}-name`">Name</label>
          <input :id="`${idPrefix}-mcp-${i}-name`" v-model="s.name" required maxlength="32" class="mono" placeholder="playwright" pattern="[a-z0-9][a-z0-9\-]*" />
        </div>
        <div class="choices" role="radiogroup" :aria-label="`How ${s.name || 'this server'} runs`">
          <label class="choice"><input v-model="s.kind" type="radio" :name="`${idPrefix}-mcp-${i}-kind`" value="command" /> A command each machine starts</label>
          <label class="choice"><input v-model="s.kind" type="radio" :name="`${idPrefix}-mcp-${i}-kind`" value="url" /> A URL to connect to</label>
        </div>
        <template v-if="s.kind === 'command'">
          <div class="field">
            <label :for="`${idPrefix}-mcp-${i}-cmd`">Command</label>
            <input :id="`${idPrefix}-mcp-${i}-cmd`" v-model="s.command" required maxlength="200" class="mono" placeholder="npx" />
          </div>
          <div class="field">
            <label :for="`${idPrefix}-mcp-${i}-args`">Arguments <span class="muted">(one per line)</span></label>
            <textarea :id="`${idPrefix}-mcp-${i}-args`" v-model="s.args" class="mono" rows="2" placeholder="@playwright/mcp@latest" />
          </div>
          <div class="field">
            <label :for="`${idPrefix}-mcp-${i}-env`">Settings <span class="muted">(KEY=value per line, not secrets)</span></label>
            <textarea :id="`${idPrefix}-mcp-${i}-env`" v-model="s.env" class="mono" rows="2" placeholder="BROWSER=chromium" />
          </div>
        </template>
        <div v-else class="field">
          <label :for="`${idPrefix}-mcp-${i}-url`">URL</label>
          <input :id="`${idPrefix}-mcp-${i}-url`" v-model="s.url" required maxlength="500" class="mono" placeholder="https://mcp.example.com/mcp" />
        </div>
        <div class="field">
          <label :for="`${idPrefix}-mcp-${i}-secrets`">Secrets <span class="muted">(names only, one per line)</span></label>
          <textarea :id="`${idPrefix}-mcp-${i}-secrets`" v-model="s.secrets" class="mono" rows="2" :placeholder="s.kind === 'url' ? 'Authorization' : 'GITHUB_TOKEN'" />
          <p class="hint">
            {{ s.kind === "url" ? "Headers sent to the server." : "Environment variables the command gets." }}
            A machine without their values leaves the server out and says so on the Machines page.
          </p>
        </div>
        <div class="field">
          <label :for="`${idPrefix}-mcp-${i}-tools`">Tools agents may use <span class="muted">(one per line; empty for all)</span></label>
          <textarea :id="`${idPrefix}-mcp-${i}-tools`" v-model="s.tools" class="mono" rows="2" placeholder="browser_navigate&#10;browser_take_screenshot" />
        </div>
        <div class="field">
          <label :for="`${idPrefix}-mcp-${i}-note`">What it is for</label>
          <input :id="`${idPrefix}-mcp-${i}-note`" v-model="s.note" maxlength="300" placeholder="Screenshots of every visual change, attached to the duty" />
          <p class="hint">Agents read this to know when to reach for it.</p>
        </div>
        <div class="row">
          <button type="button" @click="removeServer(i)">Remove {{ s.name || "this server" }}</button>
        </div>
      </div>
    </div>
    <div class="row">
      <button type="button" :disabled="(draft.mcp_servers || []).length >= 8" @click="addServer">Add an MCP server</button>
    </div>
  </fieldset>
</template>

<style scoped>
.mcp-server { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.mcp-server + .mcp-server { margin-top: 0.75rem; }
button.mcp-server__head {
  display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.2rem 0.6rem;
  width: 100%; padding: 0.8rem 0.9rem; margin: 0; border: 0; border-radius: var(--radius);
  background: none; color: inherit; font: inherit; text-align: left;
}
button.mcp-server__head:hover:not(:disabled) { background: var(--surface-2); }
.mcp-server__chevron { grid-row: span 2; color: var(--text-dim); transition: transform 0.15s ease; }
.mcp-server--open .mcp-server__chevron { transform: rotate(90deg); }
.mcp-server__title { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.mcp-server__summary { display: flex; flex-wrap: wrap; gap: 0 0.5rem; min-width: 0; }
.mcp-server__summary > span { overflow-wrap: anywhere; }
.mcp-server__summary > span + span::before { content: "·"; margin-right: 0.5rem; }
.mcp-server__body { padding: 0 0.9rem 0.9rem 2.6rem; }
@media (max-width: 700px) { .mcp-server__body { padding-left: 0.9rem; } }
</style>
