<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, getDocs, query, subscribeLive } from "../lib/altengine.js";
import { ALL_STATUSES, PRIORITIES, THREAD_KIND_LABELS, ago, exactTime, originLabel, priorityLabel, statusLabel } from "../lib/duties.js";
import Attachments from "../components/Attachments.vue";
import { user } from "../lib/session.js";

const props = defineProps({ projectId: { type: String, required: true }, dutyId: { type: String, required: true } });
const router = useRouter();

/** One page of the decision log. Newest first, because almost every visit is about the
 *  last thing that happened, and older pages are fetched only if someone asks for them. */
const PAGE = 25;

const duty = ref(null);
const entries = ref([]);
const attachments = ref([]);
const olderCursor = ref(null);
const loadingOlder = ref(false);
const error = ref("");
const notice = ref("");
const loading = ref(true);
const answer = ref("");
const note = ref("");
const sendBack = ref("");
const posting = ref(false);
const editing = ref(false);
const edit = ref({ title: "", brief: "", priority: "next", status: "queued" });

let socket = null;
let refreshTimer = null;

const flat = (doc) => ({ ...doc.data, key: String(doc.key) });

const needsAnswer = computed(() => duty.value && duty.value.status === "needs_decision");

/** Deleting a duty is the board owner's alone; a member does the work but does not remove it.
 *  The row names its board's owner, so this needs no request. */
const canDelete = computed(() => !!(duty.value && user.value && duty.value.owner_uid === user.value.uid));

/** Finished, one way or the other — the only state a duty can be sent back from. */
const finished = computed(() => duty.value && (duty.value.status === "done" || duty.value.status === "failed"));

/** The options an agent offered, if it offered any — answering with one click is the
 *  difference between a question answered in seconds and one answered tomorrow.
 *
 *  `entries` is newest-first, so this walks forward from the most recent entry and stops
 *  at a resolution: once a question has been answered its options are history. */
const options = computed(() => {
  for (const e of entries.value) {
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
        order: [{ field: "created_at", dir: "desc" }],
        limit: PAGE,
      }),
    ]);
    duty.value = (dutyRes.documents || []).map(flat)[0] || null;
    // Only when the duty says there is something to list. The count is maintained with the
    // rows, so an empty duty costs nothing — and listing mints a signed URL per file, which
    // is not work to do on the chance that someone attached one.
    loadAttachments();
    const rows = (threadRes.documents || []).map(flat);
    entries.value = rows;
    // A full page means there may be another. Only then is there anything to offer —
    // a "show more" over rows already in memory hides them for no reason.
    olderCursor.value = rows.length === PAGE ? threadRes.cursor || null : null;
    // Only reset the edit form when it is not open: a live refresh landing mid-sentence
    // must not overwrite what someone is typing.
    if (duty.value && !editing.value) resetEdit();
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** The page before this one, fetched. Appended rather than replacing, so reading back
 *  through a long log does not lose your place. */
async function loadOlder() {
  loadingOlder.value = true;
  try {
    const res = await query("threads", {
      where: [{ field: "duty_id", op: "=", value: props.dutyId }],
      order: [{ field: "created_at", dir: "desc" }],
      limit: PAGE,
      cursor: olderCursor.value,
    });
    const rows = (res.documents || []).map(flat);
    entries.value = [...entries.value, ...rows];
    olderCursor.value = rows.length === PAGE ? res.cursor || null : null;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingOlder.value = false;
  }
}

async function loadAttachments() {
  if (!duty.value || !duty.value.attachment_count) {
    attachments.value = [];
    return;
  }
  try {
    const res = await api("/duty/attachments", { duty_id: props.dutyId });
    attachments.value = res.attachments || [];
  } catch (err) {
    error.value = err.message;
  }
}

function resetEdit() {
  edit.value = {
    title: duty.value.title,
    brief: duty.value.brief,
    priority: duty.value.priority,
    status: duty.value.status,
  };
}

function startEdit() {
  resetEdit();
  editing.value = true;
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

/** Run a write, then reload — unless the write already told us everything that changed,
 *  in which case `reload: false` and the handler has updated what it needs to. */
async function act(fn, message, { reload = true } = {}) {
  posting.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    notice.value = message || "";
    if (reload) await load();
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

/** Done was wrong. The note is required, and it is the whole point: it goes on the record
 *  and rides the row, so the next agent to claim this reads why it came back before it
 *  reads the brief. */
const reopen = () =>
  act(async () => {
    await api("/duty/reopen", { duty_id: props.dutyId, note: sendBack.value });
    sendBack.value = "";
  }, "Back in the queue, at the front, with your note attached.");

/** A person's own entry on the record. Not an answer to anything — a note goes on a duty
 *  in any state, and does not move it.
 *
 *  Nothing is re-read afterwards. A note changes exactly one thing — the log gains an
 *  entry — and the server hands that entry back, so the page has the truth already. The
 *  duty row is untouched, which is why re-fetching it was the plainest waste here. */
const addNote = () =>
  act(
    async () => {
      const res = await api("/duty/checkpoint", { duty_id: props.dutyId, kind: "note", message: note.value });
      if (res.entry) entries.value = [{ ...res.entry, key: res.entry.id }, ...entries.value];
      note.value = "";
    },
    "Added to the log. The next agent to pick this up will read it.",
    { reload: false },
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
    editing.value = false;
    olderCursor.value = null;
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
    <p style="margin: 0">
      <router-link :to="{ name: 'board', params: { projectId } }">← Back to the board</router-link>
    </p>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-else-if="!duty" class="empty">That duty does not exist, or is not on a board you own.</p>

    <template v-else>
      <div>
        <h1>{{ duty.title }}</h1>
        <p class="row small muted" style="margin: 0">
          <span class="badge" :class="`badge--${duty.status}`">{{ statusLabel(duty.status) }}</span>
          <span class="badge" :class="`badge--${duty.priority}`">{{ priorityLabel(duty.priority) }}</span>
          <span>{{ originLabel(duty, user, "raised by") }}</span>
          <span v-if="duty.assigned_agent_id">
            {{ duty.status === "active" ? "held by" : "last worked by" }} {{ duty.assigned_agent_id }}
          </span>
          <span :title="exactTime(duty.updated_at)">updated {{ ago(duty.updated_at) }}</span>
        </p>
      </div>

      <!-- The brief, and the same panel in edit mode. Editing a duty happens where the
           duty is written, not in a disclosure below the thread. -->
      <div class="panel">
        <div class="panel__head">
          <h2>Brief</h2>
          <button v-if="!editing" type="button" class="btn" @click="startEdit">Edit</button>
        </div>

        <p v-if="!editing" class="prose">{{ duty.brief }}</p>

        <form v-else class="stack" @submit.prevent="saveEdits">
          <div class="field">
            <label for="e-title">Title</label>
            <input id="e-title" v-model="edit.title" required maxlength="200" />
          </div>
          <div class="field">
            <label for="e-brief">Brief</label>
            <textarea id="e-brief" v-model="edit.brief" required maxlength="4000" rows="7"></textarea>
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
            <p class="hint">
              Moving a duty off "In progress" releases whichever agent was holding it. To send
              finished work back, use <strong>Did not work?</strong> instead — it records why,
              and that note is the first thing the next agent reads.
            </p>
          </div>
          <div class="row">
            <button class="primary" type="submit" :disabled="posting">Save</button>
            <button type="button" :disabled="posting" @click="editing = false">Cancel</button>
            <span class="spacer"></span>
            <button v-if="canDelete" class="danger" type="button" :disabled="posting" @click="remove">Delete</button>
          </div>
        </form>
      </div>

      <Attachments :duty-id="dutyId" :items="attachments" :busy="posting" @changed="load" />

      <div v-if="duty.outcome_summary" class="panel" style="border-left: 3px solid var(--ok)">
        <div class="panel__head"><h2>Outcome</h2></div>
        <p class="prose">{{ duty.outcome_summary }}</p>
      </div>

      <!-- Why it came back. Shown while it is unfinished again — once it is completed a
           second time the Outcome panel above is the current answer, and this would be two
           panels arguing about the same duty. -->
      <div v-if="duty.reopen_note && !finished" class="panel" style="border-left: 3px solid var(--danger)">
        <div class="panel__head">
          <h2>Sent back</h2>
          <span v-if="duty.reopen_count > 1" class="badge">{{ duty.reopen_count }} times</span>
        </div>
        <p class="prose">{{ duty.reopen_note }}</p>
        <p v-if="duty.previous_outcome" class="muted small" style="margin: 0">
          Previously reported as {{ duty.reopened_from === "failed" ? "failed" : "done" }}:
          “{{ duty.previous_outcome }}”
        </p>
      </div>

      <!-- Done is an agent's claim, not a fact. This is how you disagree with it. -->
      <form v-if="finished" class="panel stack" @submit.prevent="reopen">
        <h2 class="section-h">Did not work?</h2>
        <p class="muted small" style="margin: 0">
          Send it back to the front of the queue with a note saying what is wrong. The note
          goes on the record and is the first thing the next agent reads — along with what
          this attempt claimed it had done.
        </p>
        <div class="field">
          <label for="send-back">What is wrong</label>
          <textarea
            id="send-back"
            v-model="sendBack"
            maxlength="4000"
            required
            rows="3"
            placeholder="The export button still 500s on a board with no duties."
          ></textarea>
        </div>
        <div>
          <button class="primary" type="submit" :disabled="posting || !sendBack.trim()">
            {{ posting ? "Sending…" : "Send back to the queue" }}
          </button>
        </div>
      </form>

      <p v-if="duty.parent_id" class="small muted rel">
        Spawned from
        <router-link :to="{ name: 'duty', params: { projectId, dutyId: duty.parent_id } }">the parent duty</router-link>.
      </p>
      <p v-if="duty.blocked_by" class="small muted rel">
        Blocked behind
        <router-link :to="{ name: 'duty', params: { projectId, dutyId: duty.blocked_by } }">a child duty</router-link>.
        Finishing that one puts this back in the queue automatically.
      </p>

      <!-- The human half of the loop. -->
      <form v-if="needsAnswer" class="panel stack" @submit.prevent="resolve()">
        <h2 class="section-h">Answer this</h2>
        <p class="muted small" style="margin: 0">
          An agent parked this and moved on to other work. Your answer goes on the record and
          rides along the next time any agent picks the duty up.
        </p>
        <div v-if="options.length" class="options">
          <button v-for="opt in options" :key="opt" type="button" :disabled="posting" @click="resolve(opt)">
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
        <h2 id="thread-h" class="section-h">Decision log</h2>

        <!-- Newest first, so the composer and the last thing that happened are next to
             each other rather than a scroll apart. -->
        <form class="panel composer" @submit.prevent="addNote">
          <label for="note">Add a note</label>
          <textarea
            id="note"
            v-model="note"
            maxlength="4000"
            placeholder="Anything an agent picking this up should know."
          ></textarea>
          <div class="composer__row">
            <button type="submit" :disabled="posting || !note.trim()">
              {{ posting ? "Posting…" : "Add note" }}
            </button>
            <span class="muted small">Goes on the record. It does not change the duty's status.</span>
          </div>
        </form>

        <p v-if="!entries.length" class="empty">Nothing on the record yet.</p>
        <ul v-else class="thread">
          <li v-for="e in entries" :key="e.key" class="entry" :class="`entry--${e.kind}`">
            <div class="entry__head">
              <span class="entry__who">{{ e.author_type === "human" ? e.author_name || "You" : e.author_id }}</span>
              <span class="badge">{{ THREAD_KIND_LABELS[e.kind] || e.kind }}</span>
              <span class="muted small" :title="exactTime(e.created_at)">{{ ago(e.created_at) }}</span>
            </div>
            <p class="entry__body prose">{{ e.message }}</p>
            <div v-if="e.metadata && e.metadata.suggested_options" class="options">
              <span v-for="o in e.metadata.suggested_options" :key="o" class="badge">{{ o }}</span>
            </div>
          </li>
        </ul>

        <button v-if="olderCursor" type="button" style="width: 100%" :disabled="loadingOlder" @click="loadOlder">
          {{ loadingOlder ? "Loading…" : "Load earlier entries" }}
        </button>
      </section>
    </template>
  </div>
</template>
