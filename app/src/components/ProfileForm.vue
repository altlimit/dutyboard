<script setup>
import { computed } from "vue";
import { AGENTS, CODEX_PERMISSION_MODES, DEPLOY_METHODS, EFFORTS, GIT_MODES, PERMISSION_MODES, PROJECT_TYPES, agentLabel, mcpServerDraft } from "../lib/runners.js";

// The questions a board is created with, and edited with later: what the project is, how its work
// lands, and how agents run on it. The model is a draft from lib/runners.js `profileDraft`; the
// parent sends `profilePayload(draft)` to the function.
//
// `idPrefix` keeps label/input ids unique when the form could appear twice on one page.

const draft = defineModel({ type: Object, required: true });
defineProps({ idPrefix: { type: String, default: "pf" }, disabled: { type: Boolean, default: false } });

const modes = computed(() => (draft.value.agent === "codex" ? CODEX_PERMISSION_MODES : PERMISSION_MODES));
const agentName = computed(() => agentLabel(draft.value.agent));
const agentNeeds = computed(() => (AGENTS.find((a) => a.key === draft.value.agent) || AGENTS[0]).install);

const addServer = () => {
  draft.value.mcp_servers = [...(draft.value.mcp_servers || []), mcpServerDraft()];
};
const removeServer = (i) => {
  draft.value.mcp_servers = draft.value.mcp_servers.filter((_, j) => j !== i);
};
</script>

<template>
  <fieldset class="stack" :disabled="disabled">
    <legend class="label">What kind of project is it?</legend>
    <div class="choices" role="radiogroup">
      <label v-for="t in PROJECT_TYPES" :key="t.key" class="choice">
        <input v-model="draft.type" type="radio" :name="`${idPrefix}-type`" :value="t.key" />
        {{ t.label }}
      </label>
    </div>
    <div v-if="draft.type === 'other'" class="field">
      <label :for="`${idPrefix}-other`">Describe it</label>
      <input :id="`${idPrefix}-other`" v-model="draft.type_other" maxlength="60" placeholder="Firmware, data pipeline, …" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-desc`">About it <span class="muted">(optional)</span></label>
      <textarea :id="`${idPrefix}-desc`" v-model="draft.description" maxlength="2000" placeholder="A music theory game for kids, built in Godot, web first." />
      <p class="hint">Every agent on the board reads this, and it shapes the rules and setup it writes.</p>
    </div>
  </fieldset>

  <fieldset class="stack" :disabled="disabled">
    <legend class="label">Where the code is</legend>
    <div class="field">
      <label :for="`${idPrefix}-repo`">Repository URL</label>
      <input :id="`${idPrefix}-repo`" v-model="draft.repo_url" required maxlength="500" placeholder="git@github.com:you/project.git" />
      <p class="hint">
        Each machine working the board keeps its own clone of this, in its projects folder — your own checkout
        is never touched. Change it and machines clone the new one; duties already under way finish where they
        started.
      </p>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-branch`">Main branch <span class="muted">(optional)</span></label>
      <input :id="`${idPrefix}-branch`" v-model="draft.default_branch" maxlength="100" placeholder="the repository's default" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-stack`">Stack <span class="muted">(optional, comma-separated)</span></label>
      <input :id="`${idPrefix}-stack`" v-model="draft.stack" placeholder="Godot 4, GDScript, Playwright" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-test`">Test command <span class="muted">(optional)</span></label>
      <input :id="`${idPrefix}-test`" v-model="draft.test_command" maxlength="500" class="mono" placeholder="npm test" />
      <p class="hint">Run before any work lands. Setup fills this in when it finds one.</p>
    </div>
  </fieldset>

  <fieldset class="stack" :disabled="disabled">
    <legend class="label">When a duty is done, its work is</legend>
    <label v-for="g in GIT_MODES" :key="g.key" class="choice choice--block">
      <input v-model="draft.git_mode" type="radio" :name="`${idPrefix}-git`" :value="g.key" />
      <span>{{ g.label }} <span class="hint" style="display: block; margin: 0">{{ g.hint }}</span></span>
    </label>
    <div class="field">
      <label :for="`${idPrefix}-deploy`">And it ships by</label>
      <select :id="`${idPrefix}-deploy`" v-model="draft.deploy_method">
        <option v-for="d in DEPLOY_METHODS" :key="d.key" :value="d.key">{{ d.label }}</option>
      </select>
    </div>
    <div v-if="draft.deploy_method === 'ci' || draft.deploy_method === 'ci-dispatch'" class="field">
      <label :for="`${idPrefix}-wf`">Workflow file</label>
      <input :id="`${idPrefix}-wf`" v-model="draft.deploy_workflow" class="mono" placeholder="deploy.yml" />
    </div>
    <div v-if="draft.deploy_method === 'altengine'" class="field">
      <label :for="`${idPrefix}-instances`">altengine instances it may deploy to</label>
      <input :id="`${idPrefix}-instances`" v-model="draft.deploy_instances" class="mono" placeholder="cadence" />
      <p class="hint">Comma-separated. A session can deploy to these and nothing else, with the machine's stored key.</p>
    </div>
    <details class="stack">
      <summary>Commit author and SSH key <span class="muted small">(optional)</span></summary>
      <p class="hint">
        Set in each machine's clone of this board only. Left empty, commits are made as the machine's own git user,
        with its default key.
      </p>
      <div class="field">
        <label :for="`${idPrefix}-author`">Commit as (name)</label>
        <input :id="`${idPrefix}-author`" v-model="draft.git_author_name" maxlength="80" placeholder="the machine's git user.name" />
      </div>
      <div class="field">
        <label :for="`${idPrefix}-email`">Commit as (email)</label>
        <input :id="`${idPrefix}-email`" v-model="draft.git_author_email" type="email" maxlength="254" placeholder="the machine's git user.email" />
      </div>
      <div class="field">
        <label :for="`${idPrefix}-ssh`">SSH command</label>
        <input :id="`${idPrefix}-ssh`" v-model="draft.git_ssh_command" maxlength="300" class="mono" placeholder="ssh -i ~/.ssh/work_ed25519" />
        <p class="hint">For a board whose repository needs another key or account than the machine's default.</p>
      </div>
    </details>
    <p v-if="draft.git_mode === 'pr'" class="hint">
      Opening pull requests needs the GitHub CLI signed in on each machine (<code class="mono">gh auth login</code>).
      A machine without it says so here and takes no duties from this board.
    </p>
    <div v-if="draft.deploy_method === 'command'" class="field">
      <label :for="`${idPrefix}-cmd`">Deploy command</label>
      <input :id="`${idPrefix}-cmd`" v-model="draft.deploy_command" class="mono" placeholder="npm run deploy" />
    </div>
  </fieldset>

  <fieldset class="stack" :disabled="disabled">
    <legend class="label">How agents run on it</legend>
    <div class="choices" role="radiogroup" aria-label="Which agent works its duties">
      <label v-for="a in AGENTS" :key="a.key" class="choice">
        <input v-model="draft.agent" type="radio" :name="`${idPrefix}-agent`" :value="a.key" />
        {{ a.label }}
      </label>
    </div>
    <p class="hint">Each machine working this board needs {{ agentNeeds }}. One without it says so on the Machines page.</p>
    <div class="field">
      <label :for="`${idPrefix}-parallel`">Duties at once</label>
      <input :id="`${idPrefix}-parallel`" v-model.number="draft.parallel" type="number" min="1" max="10" />
      <p class="hint">
        Each duty works in its own git worktree, so several can run side by side. Start with 1, and raise it
        once the board has rules and a test command to check merges against.
      </p>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-model`">Model <span class="muted">(optional)</span></label>
      <input :id="`${idPrefix}-model`" v-model="draft.model" maxlength="80" :placeholder="`${agentName}'s default`" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-effort`">Effort</label>
      <select :id="`${idPrefix}-effort`" v-model="draft.effort">
        <option v-for="e in EFFORTS" :key="e" :value="e">{{ e || `${agentName}'s default` }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-perm`">Permissions</label>
      <select :id="`${idPrefix}-perm`" v-model="draft.permission_mode">
        <option v-for="p in modes" :key="p.key" :value="p.key">{{ p.label }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-minutes`">Session limit, in minutes</label>
      <input :id="`${idPrefix}-minutes`" v-model.number="draft.session_minutes" type="number" min="5" max="600" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-instr`">Anything else agents should always know <span class="muted">(optional)</span></label>
      <textarea :id="`${idPrefix}-instr`" v-model="draft.instructions" maxlength="4000" placeholder="Deploy only after the owner says so. Screens must fit a 320px phone." />
    </div>
  </fieldset>

  <fieldset class="stack" :disabled="disabled">
    <legend class="label">MCP servers <span class="muted">(optional)</span></legend>
    <p class="hint">
      More tools for this board's sessions — a browser to take screenshots with, an issue tracker, docs. Each machine
      starts or connects to them for every duty it works here. Only what you list is connected, and only the tools
      you name, if you name any.
    </p>
    <p class="hint">
      <strong>Nothing here is private:</strong> everyone on the board can read it. Name a server's credentials under
      secrets, and set their values on each machine with <code class="mono">dutyboard --mcp-secrets</code>.
    </p>
    <div v-for="(s, i) in draft.mcp_servers" :key="i" class="stack mcp-server">
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
    <div class="row">
      <button type="button" :disabled="(draft.mcp_servers || []).length >= 8" @click="addServer">Add an MCP server</button>
    </div>
  </fieldset>
</template>
