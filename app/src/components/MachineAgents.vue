<script setup>
import { computed, ref, watch } from "vue";
import { AGENTS, optionKey, optionLabel } from "../lib/runners.js";
const props = defineProps({ machine: { type: Object, required: true }, disabled: Boolean });
const emit = defineEmits(["save", "refresh"]);
const options = ref([]);
const dirty = ref(false);
const agent = ref("codex");
const model = ref("");
const effort = ref("");
watch(() => JSON.stringify(props.machine.agent_options), () => {
  if (!dirty.value) options.value = (props.machine.agent_options || []).map((o) => ({ ...o }));
}, { immediate: true });
const items = computed(() => props.machine.readiness?.items || []);
const item = computed(() => items.value.find((it) => it.key === agent.value));
const models = computed(() => item.value?.models || []);
const efforts = computed(() => models.value.find((m) => m.id === model.value)?.efforts || []);
watch(agent, () => { model.value = ""; effort.value = ""; });
watch(model, () => { effort.value = ""; });
const choice = computed(() => ({ agent: agent.value, model: model.value, effort: effort.value }));
const canAdd = computed(() => item.value && item.value.state !== "todo" && options.value.length < 30 && !options.value.some((o) => optionKey(o) === optionKey(choice.value)));
function add() { options.value.push({ ...choice.value }); dirty.value = true; }
function remove(i) { options.value.splice(i, 1); dirty.value = true; }
function save() { emit("save", options.value.map((o) => ({ ...o }))); }
// Only acknowledge a successful save; failed requests leave the draft intact.
watch(() => JSON.stringify(props.machine.agent_options), (value) => {
  if (value === JSON.stringify(options.value)) dirty.value = false;
});
</script>

<template>
  <section class="stack" :aria-labelledby="`options-${machine.machine_id}`">
    <div class="row row--between">
      <h3 :id="`options-${machine.machine_id}`" style="margin: 0">Available agents and models</h3>
      <button type="button" class="link small" :disabled="disabled || !machine.online" @click="emit('refresh')">Refresh models</button>
    </div>
    <p class="hint">Enable the combinations this machine may run. Boards choose their order of preference.</p>
    <p v-if="machine.agent_options == null" class="notice small">Existing boards still use their previous agent settings. Saving here makes this list the machine's allowed combinations.</p>
    <ul v-if="options.length" class="stack" style="padding-left: 1.25rem">
      <li v-for="(o, i) in options" :key="optionKey(o)">
        <div class="row row--between">
          <span style="overflow-wrap: anywhere; min-width: 0">{{ optionLabel(o) }}</span>
          <button type="button" class="link small" :disabled="disabled" :aria-label="`Remove ${optionLabel(o)}`" @click="remove(i)">Remove</button>
        </div>
      </li>
    </ul>
    <p v-else class="muted small">No combinations enabled. Saving an empty list stops this machine from starting new agent sessions.</p>
    <fieldset class="stack" :disabled="disabled">
      <legend class="sr-only">Add an available combination</legend>
      <div class="field">
        <label :for="`agent-${machine.machine_id}`">Agent</label>
        <select :id="`agent-${machine.machine_id}`" v-model="agent">
          <option v-for="a in AGENTS" :key="a.key" :value="a.key">{{ a.label }}</option>
        </select>
      </div>
      <p v-if="!item || item.state === 'todo'" class="hint">Install and sign in to this agent using the checklist above, then refresh models.</p>
      <p v-if="item?.models_error" class="notice notice--warn small">{{ item.models_error }} Saved choices are kept.</p>
      <div class="field">
        <label :for="`model-${machine.machine_id}`">Model from this CLI</label>
        <select :id="`model-${machine.machine_id}`" v-model="model">
          <option value="">CLI default</option>
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label || m.id }} ({{ m.id }})</option>
        </select>
      </div>
      <div class="field">
        <label :for="`effort-${machine.machine_id}`">Effort</label>
        <select :id="`effort-${machine.machine_id}`" v-model="effort">
          <option value="">CLI default</option>
          <option v-for="e in efforts" :key="e" :value="e">{{ e }}</option>
        </select>
        <p class="hint">Only effort levels reported by this CLI are offered.</p>
      </div>
      <div class="row">
        <button type="button" :disabled="!canAdd" @click="add">Add combination</button>
        <button type="button" class="btn--primary" :disabled="!dirty && machine.agent_options != null" @click="save">Save availability</button>
      </div>
    </fieldset>
  </section>
</template>
