<script setup>
import { computed } from "vue";

// The GitHub repository a board starts with when it has none: what to call it, whose it is, and which
// of your machines makes it — with its own GitHub CLI, so nothing here holds a GitHub credential.
// The model is `newRepoDraft()` from lib/runners.js.

const draft = defineModel({ type: Object, required: true });
const props = defineProps({
  idPrefix: { type: String, default: "nr" },
  machines: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
});

const online = computed(() => props.machines.filter((m) => m.online !== false));
</script>

<template>
  <div class="stack">
    <div class="field">
      <label :for="`${idPrefix}-name`">Repository name</label>
      <input :id="`${idPrefix}-name`" v-model="draft.name" required maxlength="100" class="mono" pattern="[A-Za-z0-9._\-]+" placeholder="todo-app" :disabled="disabled" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-owner`">Owner <span class="muted">(optional)</span></label>
      <input :id="`${idPrefix}-owner`" v-model="draft.owner" maxlength="39" class="mono" placeholder="your GitHub account" :disabled="disabled" />
      <p class="hint">A GitHub organization to make it in. Empty is the account the machine's GitHub CLI is signed in as.</p>
    </div>
    <label class="choice">
      <input v-model="draft.private" type="checkbox" :disabled="disabled" />
      Private
    </label>
    <div class="field">
      <label :for="`${idPrefix}-machine`">Made by</label>
      <select :id="`${idPrefix}-machine`" v-model="draft.machine_id" :disabled="disabled || !machines.length">
        <option v-if="!machines.length" value="">no paired machines yet</option>
        <option v-for="m in machines" :key="m.machine_id" :value="m.machine_id">
          {{ m.name }}{{ m.online === false ? " (offline)" : "" }}
        </option>
      </select>
      <p class="hint">
        It needs the GitHub CLI signed in (<code class="mono">gh auth login</code>). It makes the repository, puts a
        first commit in it, and then works the board: its first duty builds the project's first version from the
        description above.
        <template v-if="machines.length && !online.length"> None of your machines is online — it starts when the one you choose is back.</template>
      </p>
    </div>
  </div>
</template>
