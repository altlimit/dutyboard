<script setup>
import { computed, ref } from "vue";
import { availableOptions, optionKey, optionLabel } from "../lib/runners.js";

const options = defineModel({ default: null });
const props = defineProps({
  machines: { type: Array, default: () => [] },
  runner: { type: Object, default: null },
  idPrefix: { type: String, default: "duty-models" },
  disabled: Boolean,
});
const selected = ref("");
const saved = ref(null);
const boardChoices = computed(() => props.runner?.options ?? [{ agent: props.runner?.agent || "claude-code", model: props.runner?.model || "", effort: props.runner?.effort || "" }]);
const available = computed(() => availableOptions(props.machines));
const unused = computed(() => available.value.filter((o) => !options.value?.some((c) => optionKey(c) === optionKey(o))));
const copy = (list) => list.map(({ agent, model, effort }) => ({ agent, model: model || "", effort: effort || "" }));
function useDefaults() {
  if (options.value != null) saved.value = copy(options.value);
  options.value = null;
  selected.value = "";
}
function override() {
  if (options.value != null) return;
  const r = props.runner;
  const defaults = r?.use_machine_defaults ? available.value : boardChoices.value;
  options.value = copy(saved.value ?? defaults).slice(0, 30);
  selected.value = "";
}
function add() {
  const choice = unused.value.find((o) => optionKey(o) === selected.value);
  if (choice) options.value = [...options.value, ...copy([choice])];
  selected.value = "";
}
function move(i, delta) {
  const next = [...options.value];
  [next[i], next[i + delta]] = [next[i + delta], next[i]];
  options.value = next;
}
function availability(o) {
  const entry = available.value.find((a) => optionKey(a) === optionKey(o));
  return entry ? `Enabled on ${entry.machines.join(", ")}` : "Not enabled on a linked machine. Enable it on Machines to use it here.";
}
</script>

<template>
  <fieldset class="stack" :disabled="disabled">
    <legend>Agent, model and effort</legend>
    <div class="row">
      <button type="button" :class="{ 'btn--primary': options == null }" :aria-pressed="options == null" @click="useDefaults">Use board defaults</button>
      <button type="button" :class="{ 'btn--primary': options != null }" :aria-pressed="options != null" @click="override">Override for this duty</button>
    </div>
    <template v-if="options == null">
      <p class="hint">Follows the board's model priority, including future changes. If the board uses machine defaults, each machine uses its own enabled list.</p>
      <details>
        <summary>View inherited priority</summary>
        <template v-if="runner?.use_machine_defaults">
          <div v-for="machine in machines" :key="machine.machine_id || machine.name" class="stack">
            <strong>{{ machine.machine_name || machine.name || machine.machine_id }}</strong>
            <ol v-if="machine.agent_options?.some((o) => !o.disabled)">
              <li v-for="o in machine.agent_options.filter((o) => !o.disabled)" :key="optionKey(o)">{{ optionLabel(o) }}</li>
            </ol>
            <p v-else class="hint">No combinations enabled on this machine.</p>
          </div>
          <p v-if="!machines.length" class="hint">Link a machine to see its defaults.</p>
        </template>
        <ol v-else-if="boardChoices.length">
          <li v-for="o in boardChoices" :key="optionKey(o)">{{ optionLabel(o) }}</li>
        </ol>
        <p v-else class="hint">The board has no model combinations selected.</p>
      </details>
    </template>
    <template v-else>
      <p class="hint">Use these combinations in order for this duty. At a usage limit, continue with the next enabled choice, keeping the existing work. Each machine must have the combination enabled.</p>
      <ol v-if="options.length" class="stack" style="padding-left: 1.5rem">
        <li v-for="(o, i) in options" :key="optionKey(o)">
          <strong style="overflow-wrap: anywhere">{{ optionLabel(o) }}</strong>
          <p class="hint">{{ availability(o) }}</p>
          <div class="row">
            <button type="button" :disabled="i === 0" :aria-label="`Move ${optionLabel(o)} up`" @click="move(i, -1)">Move up</button>
            <button type="button" :disabled="i === options.length - 1" :aria-label="`Move ${optionLabel(o)} down`" @click="move(i, 1)">Move down</button>
            <button type="button" class="link small" :aria-label="`Remove ${optionLabel(o)}`" @click="options = options.filter((_, j) => i !== j)">Remove</button>
          </div>
        </li>
      </ol>
      <p v-else class="notice small">Add at least one combination, or use board defaults.</p>
      <div class="field">
        <label :for="`${idPrefix}-choice`">Add an agent, model and effort</label>
        <select :id="`${idPrefix}-choice`" v-model="selected" :disabled="options.length >= 30">
          <option value="">Choose an enabled combination</option>
          <option v-for="o in unused" :key="optionKey(o)" :value="optionKey(o)">{{ optionLabel(o) }} — {{ o.machines.join(", ") }}</option>
        </select>
      </div>
      <div><button type="button" :disabled="!selected || options.length >= 30" @click="add">Add to priority list</button></div>
      <p class="hint">Add or enable more model/effort combinations on <router-link :to="{ name: 'runners' }">Machines</router-link>. Duty overrides require dutyboard 2.30.0 or later on the machine.</p>
    </template>
  </fieldset>
</template>
