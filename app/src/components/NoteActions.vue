<script setup>
import { ref, watch } from "vue";
import { api } from "../lib/altengine.js";
import { statusLabel } from "../lib/duties.js";
const props = defineProps({ note: { type: Object, required: true }, projectId: String, full: Boolean });
const error = ref("");
const linked = ref(false), clearing = ref(false);
const suggestions = ref([]);
const cursor = ref(null);
const loading = ref(false);
let generation = 0;
async function load(append = false) {
  if (!props.full) return;
  const current = ++generation;
  loading.value = true;
  try {
    const res = await api("/duty/get", { duty_id: props.note.key, suggestions_cursor: append ? cursor.value : undefined });
    if (current !== generation) return;
    suggestions.value = append ? [...suggestions.value, ...(res.suggestions || [])] : res.suggestions || [];
    cursor.value = res.suggestions_cursor;
    linked.value = res.duty.has_suggestions;
  } catch (err) { if (current === generation) error.value = err.message; }
  finally { if (current === generation) loading.value = false; }
}
async function clearLink() {
  clearing.value = true; error.value = "";
  try { await api("/note/clear", { note_id: props.note.key }); await load(); }
  catch (err) { error.value = err.message; }
  finally { clearing.value = false; }
}
watch(() => props.note, () => load(), { immediate: true });
</script>

<template>
  <div class="stack" style="gap: 0.5rem; margin-top: 0.5rem">
    <p class="hint">This note is part of the board's shared context. <router-link :to="{ name: 'notes', params: { projectId } }">Open Notes</router-link> to arrange notes or suggest duties from notes without linked suggestions.</p>
    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <template v-if="full">
      <div v-if="linked"><button type="button" :disabled="clearing || loading" @click="clearLink">Clear link</button></div>
      <p v-if="!loading" class="hint">{{ linked ? "Clear this note’s link after its review finishes to include it in suggestions again. Existing duties and source history stay." : "This note is eligible for the next suggestion review. Earlier suggestions remain below for reference." }}</p>
      <h3>Suggestion history</h3>
      <p v-if="!suggestions.length" class="muted small">{{ loading ? "Loading suggestions…" : "No duties suggested from this note yet." }}</p>
      <ul v-else class="stack">
        <li v-for="d in suggestions" :key="d.id">
          <router-link :to="{ name: 'duty', params: { projectId, dutyId: d.id } }">{{ d.title }}</router-link>
          <span class="badge" style="margin-left: 0.4rem">{{ d.approval_required && d.status === 'needs_decision' ? 'Awaiting approval' : statusLabel(d.status) }}</span>

        </li>
      </ul>
      <button v-if="cursor" type="button" :disabled="loading" @click="load(true)">Show more suggestions</button>
    </template>
  </div>
</template>
