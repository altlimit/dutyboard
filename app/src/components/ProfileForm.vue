<script setup>
import { DEPLOY_METHODS, EFFORTS, GIT_MODES, PERMISSION_MODES, PROJECT_TYPES } from "../lib/runners.js";

// The questions a board is created with, and edited with later: what the project is, how its work
// lands, and how agents run on it. The model is a draft from lib/runners.js `profileDraft`; the
// parent sends `profilePayload(draft)` to the function.
//
// `idPrefix` keeps label/input ids unique when the form could appear twice on one page.

const draft = defineModel({ type: Object, required: true });
defineProps({ idPrefix: { type: String, default: "pf" }, disabled: { type: Boolean, default: false } });
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
      <input :id="`${idPrefix}-repo`" v-model="draft.repo_url" maxlength="500" placeholder="git@github.com:you/project.git" />
      <p class="hint">What a machine clones when you set the board up on it from the console.</p>
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
    <div v-if="draft.deploy_method === 'command'" class="field">
      <label :for="`${idPrefix}-cmd`">Deploy command</label>
      <input :id="`${idPrefix}-cmd`" v-model="draft.deploy_command" class="mono" placeholder="npm run deploy" />
    </div>
  </fieldset>

  <fieldset class="stack" :disabled="disabled">
    <legend class="label">How agents run on it</legend>
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
      <input :id="`${idPrefix}-model`" v-model="draft.model" maxlength="80" placeholder="Claude Code's default" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-effort`">Effort</label>
      <select :id="`${idPrefix}-effort`" v-model="draft.effort">
        <option v-for="e in EFFORTS" :key="e" :value="e">{{ e || "Claude Code's default" }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-perm`">Permissions</label>
      <select :id="`${idPrefix}-perm`" v-model="draft.permission_mode">
        <option v-for="p in PERMISSION_MODES" :key="p.key" :value="p.key">{{ p.label }}</option>
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
</template>
