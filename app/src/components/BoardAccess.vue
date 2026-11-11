<script setup>
import { computed, ref, watch } from "vue";
import { api } from "../lib/altengine.js";
const props = defineProps({ projectId: { type: String, required: true }, owner: Boolean });
const incoming = ref([]);
const outgoing = ref([]);
const boards = ref([]);
const source = ref("");
const level = ref("read");
const busy = ref(false);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const levels = [
  { key: "read", label: "READ — duties, notes, files, rules and schedules" },
  { key: "write", label: "WRITE — read and file duties" },
  { key: "full", label: "FULL — all existing agent actions" },
];
const choices = computed(() => boards.value.filter(b => b.project_id !== props.projectId && !incoming.value.some(l => l.source_project_id === b.project_id)));
let generation = 0;
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const links = await api("/board/access/list", { project_id: props.projectId });
    if (current !== generation) return;
    incoming.value = links.incoming || [];
    outgoing.value = links.outgoing || [];
    // The user's own boards can be paged; shared boards are included on the first page.
    const all = [];
    let cursor;
    do {
      const page = await api("/projects/list", { limit: 100, cursor });
      if (current !== generation) return;
      all.push(...(page.projects || []), ...(page.shared || []));
      cursor = page.projects?.length === 100 ? page.cursor : null;
    } while (cursor);
    boards.value = [...new Map(all.map(b => [b.project_id, b])).values()];
    if (!choices.value.some(b => b.project_id === source.value)) source.value = choices.value[0]?.project_id || "";
  } catch (err) { if (current === generation) error.value = err.message; }
  finally { if (current === generation) loading.value = false; }
}
watch(() => props.projectId, () => { notice.value = ""; source.value = ""; load(); }, { immediate: true });
async function change(sourceID, nextLevel) {
  busy.value = true;
  error.value = notice.value = "";
  try {
    await api(nextLevel ? "/board/access/set" : "/board/access/remove", {
      project_id: props.projectId, source_project_id: sourceID, ...(nextLevel ? { level: nextLevel } : {}),
    });
    notice.value = nextLevel ? `Saved: ${sourceID} → ${props.projectId}, ${nextLevel.toUpperCase()}. Reverse access needs a separate link.` : "Access removed. Further requests through this link are refused.";
    await load();
  } catch (err) { error.value = err.message; }
  finally { busy.value = false; }
}
const canOpen = id => boards.value.some(b => b.project_id === id);
</script>

<template>
  <div class="stack">
    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <section class="panel stack" aria-labelledby="access-in-h">
      <div class="panel__head">
        <h2 id="access-in-h">Boards that can access this board</h2>
        <button type="button" :disabled="loading || busy" @click="load">Refresh links</button>
      </div>
      <p class="hint">Adding Board A here gives A’s agents access to this board. To grant the reverse direction, add this board in A’s settings.</p>
      <p class="hint">READ reads duties, notes, files, rules, profiles and schedules. WRITE also files duties and attaches their input files. FULL permits existing agent actions; human approvals and owner-only settings still require a person.</p>
      <p v-if="!owner" class="hint">Only this board’s owner can grant or remove access.</p>
      <form v-if="owner" class="stack" @submit.prevent="change(source, level)">
        <div class="field">
          <label for="access-source">Allow this board</label>
          <select id="access-source" v-model="source" :disabled="loading || busy || !choices.length" required>
            <option v-if="!choices.length" value="">No other accessible boards to add</option>
            <option v-for="b in choices" :key="b.project_id" :value="b.project_id">{{ b.name }} ({{ b.project_id }})</option>
          </select>
        </div>
        <div class="field">
          <label for="access-level">Access level</label>
          <select id="access-level" v-model="level" :disabled="busy">
            <option v-for="l in levels" :key="l.key" :value="l.key">{{ l.label }}</option>
          </select>
        </div>
        <p class="hint">You must have access to the source board. If you lose that access, the link stops working.</p>
        <div><button class="primary" type="submit" :disabled="busy || loading || !source">{{ busy ? "Saving…" : "Add board access" }}</button></div>
      </form>
      <p v-if="!incoming.length" class="muted small">{{ loading ? "Loading links…" : "No other boards have access." }}</p>
      <ul v-else class="members">
        <li v-for="link in incoming" :key="link.source_project_id" class="access-row">
          <div>
            <strong>{{ link.source_name || link.source_project_id }} → this board</strong>
            <p class="hint mono">{{ link.source_project_id }}</p>
            <p v-if="!link.active" class="hint">Inactive: the grantor no longer has the required board access.</p>
          </div>
          <div class="row">
            <select v-if="owner" :value="link.level" :aria-label="`Access for ${link.source_name || link.source_project_id}`" :disabled="busy" @change="change(link.source_project_id, $event.target.value)">
              <option v-for="l in levels" :key="l.key" :value="l.key">{{ l.key.toUpperCase() }}</option>
            </select>
            <span v-else class="badge">{{ link.level.toUpperCase() }}</span>
            <button v-if="owner" type="button" class="link" :disabled="busy" @click="change(link.source_project_id, null)">Remove access</button>
          </div>
        </li>
      </ul>
    </section>
    <section class="panel stack" aria-labelledby="access-out-h">
      <h2 id="access-out-h">Boards this board can access</h2>
      <p class="hint">These grants are managed in each receiving board’s settings. Linking boards gives agents access; it does not add people as board members.</p>
      <p v-if="!outgoing.length" class="muted small">{{ loading ? "Loading links…" : "This board has no outgoing access." }}</p>
      <ul v-else class="members">
        <li v-for="link in outgoing" :key="link.target_project_id" class="access-row">
          <div><strong>This board → {{ link.target_name || link.target_project_id }}</strong><p class="hint mono">{{ link.target_project_id }}</p></div>
          <div class="row">
            <span class="badge">{{ link.level.toUpperCase() }}</span>
            <span v-if="!link.active" class="badge">Inactive</span>
            <router-link v-if="canOpen(link.target_project_id)" :to="{ name: 'settings', params: { projectId: link.target_project_id }, query: { tab: 'access' } }">Manage on that board</router-link>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.access-row { display: flex; justify-content: space-between; gap: 0.8rem; flex-wrap: wrap; }
.access-row > div { min-width: 0; }
.access-row strong, .access-row .mono { overflow-wrap: anywhere; }
.access-row select { width: auto; }
</style>
