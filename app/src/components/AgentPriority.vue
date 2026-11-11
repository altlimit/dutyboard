<script setup>
import { computed, ref } from "vue";
import { optionKey, optionLabel, availableOptions } from "../lib/runners.js";
const draft = defineModel({ type: Object, required: true });
const props = defineProps({ machines: { type: Array, default: () => [] }, idPrefix: { type: String, default: "priority" }, disabled: Boolean });
const selected = ref("");
const available = computed(() => availableOptions(props.machines));
const choices = computed(() => draft.value.options ?? [{ agent: draft.value.agent, model: draft.value.model, effort: draft.value.effort }]);
const unused = computed(() => available.value.filter((o) => !choices.value.some((c) => optionKey(c) === optionKey(o))));
function saveChoices(next) { draft.value.options = next; }
function add() {
  const o = unused.value.find((o) => optionKey(o) === selected.value);
  if (o) saveChoices([...choices.value, { agent: o.agent, model: o.model, effort: o.effort }]);
  selected.value = "";
}
function move(i, delta) {
  const next = [...choices.value];
  [next[i], next[i + delta]] = [next[i + delta], next[i]];
  saveChoices(next);
}
function availability(o) {
  const entry = available.value.find((a) => optionKey(a) === optionKey(o));
  return entry ? `Enabled on ${entry.machines.join(", ")}` : "Not enabled on a linked machine";
}
</script>

<template>
  <div class="stack">
    <p class="hint">Run the first available combination, in this order. If it reaches its usage limit, continue the duty with the next option and keep its existing work.</p>
    <p v-if="draft.options == null" class="notice small">This board still uses its previous single-agent setting. Enable matching combinations on Machines before editing this list.</p>
    <ol v-if="choices.length" class="stack" style="padding-left: 1.5rem">
      <li v-for="(o, i) in choices" :key="optionKey(o)">
        <div class="stack" style="gap: 0.3rem">
          <strong style="display: block; overflow-wrap: anywhere">{{ optionLabel(o) }}</strong>
          <p class="hint" style="margin: 0.3rem 0">{{ availability(o) }}</p>
          <div class="row">
            <button type="button" :disabled="disabled || i === 0" :aria-label="`Move ${optionLabel(o)} up`" @click="move(i, -1)">Move up</button>
            <button type="button" :disabled="disabled || i === choices.length - 1" :aria-label="`Move ${optionLabel(o)} down`" @click="move(i, 1)">Move down</button>
            <button type="button" class="link small" :disabled="disabled" :aria-label="`Remove ${optionLabel(o)}`" @click="saveChoices(choices.filter((_, j) => i !== j))">Remove</button>
          </div>
        </div>
      </li>
    </ol>
    <p v-else class="notice small">Choose at least one combination to run duties on this board.</p>
    <div class="field">
      <label :for="`${idPrefix}-choice`">Add an agent, model and effort</label>
      <select :id="`${idPrefix}-choice`" v-model="selected" :disabled="disabled || choices.length >= 30">
        <option value="">Choose an enabled combination</option>
        <option v-for="o in unused" :key="optionKey(o)" :value="optionKey(o)">{{ optionLabel(o) }} — {{ o.machines.join(", ") }}</option>
      </select>
      <p v-if="!available.length" class="hint">Enable combinations on <router-link :to="{ name: 'runners' }">Machines</router-link> and link a machine to this board.</p>
    </div>
    <div><button type="button" :disabled="disabled || !selected || choices.length >= 30" @click="add">Add to priority list</button></div>
    <p class="hint">A machine skips combinations it has not enabled. When all its choices are exhausted, it waits for a reset. Priorities apply within each machine.</p>
  </div>
</template>
