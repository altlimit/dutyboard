<script setup>
import { ref, watch } from "vue";
import { api } from "../lib/altengine.js";
import { statusLabel } from "../lib/duties.js";
const props = defineProps({ note: { type: Object, required: true }, projectId: String, full: Boolean });
const emit = defineEmits(["changed"]);
const busy = ref(false);
const error = ref("");
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
  } catch (err) { if (current === generation) error.value = err.message; }
  finally { if (current === generation) loading.value = false; }
}
watch(() => props.note, () => load(), { immediate: true });
async function suggest(clear = false) {
  busy.value = true;
  error.value = "";
  let changed = false;
  try {
    if (clear) {
      await api("/note/clear", { note_id: props.note.key });
      changed = true;
    }
    await api("/note/process", { note_id: props.note.key });
    changed = true;
  } catch (err) { error.value = err.message; }
  finally { busy.value = false; if (changed) emit("changed"); }
}
</script>

<template>
  <div class="stack" style="gap: 0.5rem; margin-top: 0.5rem">
    <p v-if="full" class="hint">Notes are saved context. An agent reviews this note only when you ask; suggested duties wait for your approval in Needs you.</p>
    <div class="row">
      <router-link v-if="note.review_duty_id" :to="{ name: 'duty', params: { projectId, dutyId: note.review_duty_id } }">View review</router-link>
      <button v-else type="button" :disabled="busy" @click="suggest()">{{ busy ? "Requesting…" : "Suggest duties" }}</button>
      <button v-if="full && note.review_duty_id" type="button" :disabled="busy" @click="suggest(true)">{{ busy ? "Requesting…" : "Clear and suggest again" }}</button>
    </div>
    <p v-if="full && note.review_duty_id" class="hint">Finish or cancel the current review before trying again. Clearing its link keeps existing duties and their source links, so the next review can see what was already suggested.</p>
    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <template v-if="full">
      <h3>Suggested duties</h3>
      <p v-if="!suggestions.length" class="muted small">{{ loading ? "Loading suggestions…" : "No duties suggested from this note yet." }}</p>
      <ul v-else class="stack">
        <li v-for="d in suggestions" :key="d.id">
          <router-link :to="{ name: 'duty', params: { projectId, dutyId: d.id } }">{{ d.title }}</router-link>
          <span class="badge" style="margin-left: 0.4rem">{{ d.approval_required && d.status === 'needs_decision' ? 'Awaiting approval' : statusLabel(d.status) }}</span>
          <span v-if="d.review_duty_id !== note.review_duty_id" class="small muted"> · earlier review</span>
        </li>
      </ul>
      <button v-if="cursor" type="button" :disabled="loading" @click="load(true)">Show more suggestions</button>
    </template>
  </div>
</template>
