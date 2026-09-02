<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, getDocs, query, subscribeLive } from "../lib/altengine.js";
import { ALL_STATUSES, PRIORITIES, THREAD_KIND_LABELS, ago, exactTime, priorityLabel, statusLabel } from "../lib/duties.js";

const props = defineProps({ projectId: { type: String, required: true }, dutyId: { type: String, required: true } });
const router = useRouter();

const duty = ref(null);
const entries = ref([]);
const error = ref("");
const notice = ref("");
const loading = ref(true);
const answer = ref("");
const posting = ref(false);
const editing = ref(false);
const edit = ref({ title: "", brief: "", priority: "next", status: "queued" });

let socket = null;
let refreshTimer = null;

const flat = (doc) => ({ ...doc.data, key: String(doc.key) });

const needsAnswer = computed(() => duty.value && duty.value.status === "needs_decision");
/** The options an agent offered, if it offered any — answering with one click is the
 *  difference between a question answered in seconds and one answered tomorrow. */
const options = computed(() => {
  for (let i = entries.value.length - 1; i >= 0; i--) {
    const e = entries.value[i];
    if (e.kind === "resolution") return [];
    if (e.metadata && Array.isArray(e.metadata.suggested_options)) return e.metadata.suggested_options;
  }
  return [];
});

async function load() {
  error.value = "";
  try {
    const [dutyRes, threadRes] = await Promise.all([
      getDocs("duties", [props.dutyId]),
      query("threads", {
        where: [{ field: "duty_id", op: "=", value: props.dutyId }],
        order: [{ field: "created_at", dir: "asc" }],
        limit: 200,
      }),
    ]);
    duty.value = (dutyRes.documents || []).map(flat)[0] || null;
    entries.value = (threadRes.documents || []).map(flat);
    if (duty.value) {
      edit.value = {
        title: duty.value.title,
        brief: duty.value.brief,
        priority: duty.value.priority,
        status: duty.value.status,
      };
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    load();
  }, 400);
}

function connect() {
  if (socket) socket.close();
  socket = subscribeLive({ projectId: props.projectId, dutyIds: [props.dutyId] }, () => scheduleRefresh());
}

async function act(fn, message) {
  posting.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    notice.value = message || "";
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    posting.value = false;
  }
}

const resolve = (text) =>
  act(
    async () => {
      await api("/duty/resolve", { duty_id: props.dutyId, resolution_text: text ?? answer.value });
      answer.value = "";
    },
    "Answered. The duty is back at the front of the queue with your answer attached.",
  );

const saveEdits = () =>
  act(async () => {
    await api("/duty/update", { duty_id: props.dutyId, ...edit.value });
    editing.value = false;
  }, "Saved.");

async function remove() {
  if (!confirm(`Delete "${duty.value.title}" and its thread? This cannot be undone.`)) return;
  await act(async () => {
    await api("/duty/delete", { duty_id: props.dutyId });
    router.push({ name: "board", params: { projectId: props.projectId } });
  });
}

watch(
  () => props.dutyId,
  () => {
    loading.value = true;
    load();
    connect();
  },
  { immediate: true },
);

onUnmounted(() => {
  if (socket) socket.close();
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="wrap wrap--narrow stack">
    <p>
      <router-link :to="{ name: 'board', params: { projectId } }">← Back to the board</router-link>
    </p>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-else-if="!duty" class="empty">That duty does not exist, or is not on a board you own.</p>

    <template v-else>
      <div class="stack">
        <div>
          <h1>{{ duty.title }}</h1>
          <p class="row small muted">
            <span class="badge" :class="`badge--${duty.status}`">{{ statusLabel(duty.status) }}</span>
            <span class="badge" :class="`badge--${duty.priority}`">{{ priorityLabel(duty.priority) }}</span>
            <span class="badge">{{ duty.origin === "agent" ? "raised by an agent" : "raised by you" }}</span>
            <span v-if="duty.assigned_agent_id">
              {{ duty.status === "active" ? "held by" : "last worked by" }} {{ duty.assigned_agent_id }}
            </span>
            <span :title="exactTime(duty.updated_at)">updated {{ ago(duty.updated_at) }}</span>
          </p>
        </div>

        <div class="panel">
          <h2>Brief</h2>
          <p style="white-space: pre-wrap; margin: 0">{{ duty.brief }}</p>
        </div>

        <div v-if="duty.outcome_summary" class="panel" style="border-left: 3px solid var(--ok)">
          <h2>Outcome</h2>
          <p style="white-space: pre-wrap; margin: 0">{{ duty.outcome_summary }}</p>
        </div>

        <p v-if="duty.parent_id" class="small muted">
          Spawned from
          <router-link :to="{ name: 'duty', params: { projectId, dutyId: duty.parent_id } }">the parent duty</router-link
          >.
        </p>
        <p v-if="duty.blocked_by" class="small muted">
          Blocked behind
          <router-link :to="{ name: 'duty', params: { projectId, dutyId: duty.blocked_by } }">a child duty</router-link
          >. Finishing that one puts this back in the queue automatically.
        </p>
      </div>

      <!-- The human half of the loop. -->
      <form v-if="needsAnswer" class="panel stack" @submit.prevent="resolve()">
        <h2>Answer this</h2>
        <p class="muted small" style="margin: 0">
          An agent parked this and moved on to other work. Your answer goes on the record and
          rides along the next time any agent picks the duty up.
        </p>
        <div v-if="options.length" class="options">
          <button
            v-for="opt in options"
            :key="opt"
            type="button"
            :disabled="posting"
            @click="resolve(opt)"
          >
            {{ opt }}
          </button>
        </div>
        <div class="field">
          <label for="answer">Your answer</label>
          <textarea id="answer" v-model="answer" maxlength="4000" required></textarea>
        </div>
        <div>
          <button class="primary" type="submit" :disabled="posting || !answer">
            {{ posting ? "Sending…" : "Send answer" }}
          </button>
        </div>
      </form>

      <section aria-labelledby="thread-h" class="stack">
        <h2 id="thread-h">Decision log</h2>
        <p v-if="!entries.length" class="empty">Nothing on the record yet.</p>
        <ul v-else class="thread">
          <li v-for="e in entries" :key="e.key" class="entry" :class="`entry--${e.kind}`">
            <div class="entry__head">
              <span class="entry__who">{{ e.author_type === "human" ? e.author_name || "You" : e.author_id }}</span>
              <span class="badge">{{ THREAD_KIND_LABELS[e.kind] || e.kind }}</span>
              <span class="muted small" :title="exactTime(e.created_at)">{{ ago(e.created_at) }}</span>
            </div>
            <p class="entry__body" style="margin: 0">{{ e.message }}</p>
            <div v-if="e.metadata && e.metadata.suggested_options" class="options">
              <span v-for="o in e.metadata.suggested_options" :key="o" class="badge">{{ o }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section aria-labelledby="edit-h" class="panel stack">
        <div class="row row--between">
          <h2 id="edit-h" style="margin: 0">Edit</h2>
          <button type="button" @click="editing = !editing" :aria-expanded="editing">
            {{ editing ? "Cancel" : "Change this duty" }}
          </button>
        </div>

        <form v-if="editing" class="stack" @submit.prevent="saveEdits">
          <div class="field">
            <label for="e-title">Title</label>
            <input id="e-title" v-model="edit.title" required maxlength="200" />
          </div>
          <div class="field">
            <label for="e-brief">Brief</label>
            <textarea id="e-brief" v-model="edit.brief" required maxlength="4000"></textarea>
          </div>
          <div class="field">
            <label for="e-priority">Priority</label>
            <select id="e-priority" v-model="edit.priority">
              <option v-for="p in PRIORITIES" :key="p.key" :value="p.key">{{ p.label }}</option>
            </select>
          </div>
          <div class="field">
            <label for="e-status">Status</label>
            <select id="e-status" v-model="edit.status">
              <option v-for="s in ALL_STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
            <p class="hint">Moving a duty off "In progress" releases whichever agent was holding it.</p>
          </div>
          <div class="row">
            <button class="primary" type="submit" :disabled="posting">Save</button>
            <button class="danger" type="button" :disabled="posting" @click="remove">Delete duty</button>
          </div>
        </form>
      </section>
    </template>
  </div>
</template>
