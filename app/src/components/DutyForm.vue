<script setup>
// Filing a duty: title, brief, which models may work it, its priority, how long it stays once done,
// and the files that come with it. The same form on a board's Duties page and in the office.
//
// It files on `projectId`, or — given `boards` — on whichever of them is chosen. What it needs about
// a board (its runner for the model choices, its default for how long finished duties stay, the
// machines that work it) it is handed when the page already has it, and reads for itself otherwise.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { api, putSigned } from "../lib/altengine.js";
import { PRIORITIES, expiryChoices } from "../lib/duties.js";
import { pastedFiles } from "../lib/paste.js";
import DutyAgentPriority from "./DutyAgentPriority.vue";

const props = defineProps({
  projectId: { type: String, default: "" },
  // `[{ project_id, name }]`: offer a choice of board. With one or none, it files on `projectId`.
  boards: { type: Array, default: () => [] },
  // What the page already knows about the board; read here when not given.
  runner: { type: Object, default: undefined },
  profile: { type: Object, default: undefined },
  machines: { type: Array, default: undefined },
  idPrefix: { type: String, default: "d" },
  heading: { type: String, default: "Add a duty" },
});
// `added` carries the new duty and any files that did not make it onto it.
const emit = defineEmits(["added", "cancel"]);

const board = ref(props.projectId || (props.boards[0] && props.boards[0].project_id) || "");
watch(() => props.projectId, (id) => id && (board.value = id));
const choosing = computed(() => props.boards.length > 1);
const boardName = computed(() => (props.boards.find((b) => b.project_id === board.value) || {}).name || "");

// --- the board it files on ----------------------------------------------------------------------

const loaded = reactive({ runner: null, profile: null, machines: [] });
const runner = computed(() => (props.runner !== undefined ? props.runner : loaded.runner));
const profile = computed(() => (props.profile !== undefined ? props.profile : loaded.profile));
const machines = computed(() => (props.machines !== undefined ? props.machines : loaded.machines));

async function loadBoard(id) {
  if (!id || (props.runner !== undefined && props.machines !== undefined)) return;
  const [p, r] = await Promise.allSettled([api("/board/profile", { project_id: id }), api("/board/runners", { project_id: id })]);
  if (id !== board.value) return; // another board was chosen meanwhile
  loaded.runner = p.status === "fulfilled" ? p.value.runner || null : null;
  loaded.profile = p.status === "fulfilled" ? p.value.profile || null : null;
  loaded.machines = r.status === "fulfilled" ? r.value.runners || [] : [];
  if (!draft.value.title && !draft.value.brief) draft.value.expire_after_days = defaultExpiry();
}
watch(board, loadBoard);

// --- the draft ----------------------------------------------------------------------------------

/** How long a finished duty stays, as the board's settings say a new one should start. */
const defaultExpiry = () => (profile.value && profile.value.expire_after_days) || 0;
const blankDraft = () => ({ title: "", brief: "", priority: "next", agent_options: null, expire_after_days: defaultExpiry() });
const draft = ref(blankDraft());
watch(profile, () => {
  if (!draft.value.title && !draft.value.brief) draft.value.expire_after_days = defaultExpiry();
});
const adding = ref(false);
const error = ref("");
const titleInput = ref(null);

// Files chosen while writing the duty, uploaded once it exists. A screenshot of the bug is often the
// clearest brief there is, and making someone add the duty, open it, and attach from there is how
// the screenshot ends up described in words instead.
const files = ref([]); // File[]
const uploading = ref([]); // [{ name, pct }], reactive, while bytes are in flight

const human = (bytes) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

function pickFiles(event) {
  files.value = [...files.value, ...(event.target.files || [])];
  event.target.value = ""; // so the same file can be chosen again after removing it
}
const dropFile = (file) => (files.value = files.value.filter((f) => f !== file));

// While the form is open, a pasted screenshot or file joins the list as if it had been chosen.
function onPaste(event) {
  if (adding.value) return;
  const pasted = pastedFiles(event);
  if (pasted.length) files.value = [...files.value, ...pasted];
}
onMounted(() => {
  document.addEventListener("paste", onPaste);
  loadBoard(board.value);
});
onUnmounted(() => document.removeEventListener("paste", onPaste));

/**
 * Attach files to a duty that has just been created. Returns a line per file that failed.
 *
 * EVERY ROW IS RESERVED BEFORE ANY BYTES MOVE. The duty is claimable the moment it exists, and an
 * agent reads `attachment_count` to decide whether to look — so the count has to be right as early as
 * possible, not after the slowest upload. Reserving is one small call per file; a video can take a
 * minute. An agent that claims in that minute sees the file listed as uploading rather than a duty
 * that appears to have none.
 */
async function attachAll(dutyId, chosen) {
  const failed = [];
  const reserved = [];
  for (const file of chosen) {
    try {
      const minted = await api("/duty/attach", { duty_id: dutyId, name: file.name, size: file.size, content_type: file.type || "application/octet-stream" });
      reserved.push({ file, minted });
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  for (const { file, minted } of reserved) {
    const entry = reactive({ name: file.name, pct: 0 });
    uploading.value = [...uploading.value, entry];
    try {
      await putSigned(minted.upload_url, minted.required_headers, file, (pct) => (entry.pct = pct));
    } catch (err) {
      // The reservation stays behind as a pending row and is swept later, exactly as on the duty
      // page — reported, not cleaned up by hand.
      failed.push(`${file.name}: ${err.message}`);
    } finally {
      uploading.value = uploading.value.filter((u) => u !== entry);
    }
  }
  return failed;
}

async function add() {
  if (draft.value.agent_options?.length === 0) {
    error.value = "Add a model combination, or use board defaults.";
    return;
  }
  adding.value = true;
  error.value = "";
  try {
    const projectId = board.value;
    const created = await api("/duty/enqueue", {
      project_id: projectId,
      title: draft.value.title,
      brief: draft.value.brief,
      priority: draft.value.priority,
      agent_options: draft.value.agent_options,
      expire_after_days: draft.value.expire_after_days,
      // The files go up once it exists; a runner that claims it first waits for this many.
      expect_files: files.value.length,
    });
    // From here the duty EXISTS. A file that fails does not un-create it — rolling back work someone
    // has written because a screenshot timed out would lose the part that mattered.
    const failed = files.value.length ? await attachAll(created.duty_id, files.value) : [];
    const title = draft.value.title;
    draft.value = blankDraft();
    files.value = [];
    emit("added", { duty_id: created.duty_id, project_id: projectId, title, board: boardName.value, failed });
  } catch (err) {
    error.value = err.message;
  } finally {
    adding.value = false;
  }
}

/** Ready to type the title, on a board if one is named. */
function focus(projectId) {
  if (projectId) board.value = projectId;
  titleInput.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  titleInput.value?.focus({ preventScroll: true });
}
defineExpose({ focus });

const submitLabel = computed(() => {
  if (adding.value) return uploading.value.length ? "Uploading…" : "Adding…";
  const where = choosing.value && boardName.value ? ` to ${boardName.value}` : " to the queue";
  return files.value.length ? `Add${where} with ${files.value.length} file${files.value.length === 1 ? "" : "s"}` : `Add${where}`;
});
</script>

<template>
  <form class="panel panel--form stack" @submit.prevent="add">
    <h2 style="margin: 0">{{ heading }}</h2>
    <div v-if="choosing" class="field">
      <label :for="`${idPrefix}-board`">Board</label>
      <select :id="`${idPrefix}-board`" v-model="board" required :disabled="adding">
        <option v-for="b in boards" :key="b.project_id" :value="b.project_id">{{ b.name || b.project_id }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-title`">Title</label>
      <input :id="`${idPrefix}-title`" ref="titleInput" v-model="draft.title" required maxlength="200" placeholder="A short name for what you want done" />
    </div>
    <div class="field">
      <label :for="`${idPrefix}-brief`">Brief</label>
      <textarea :id="`${idPrefix}-brief`" v-model="draft.brief" required maxlength="4000" placeholder="What should change, and how you will know it is done."></textarea>
      <p class="hint">An agent may pick this up with no other context. Write it for that reader.</p>
    </div>
    <DutyAgentPriority v-model="draft.agent_options" :runner="runner" :machines="machines" :id-prefix="`${idPrefix}-models`" :disabled="adding" />
    <div class="field">
      <label :for="`${idPrefix}-priority`">Priority</label>
      <select :id="`${idPrefix}-priority`" v-model="draft.priority">
        <option v-for="p in PRIORITIES" :key="p.key" :value="p.key">{{ p.label }} — {{ p.hint }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-expire`">Once it is done</label>
      <select :id="`${idPrefix}-expire`" v-model.number="draft.expire_after_days">
        <option v-for="c in expiryChoices(draft.expire_after_days)" :key="c.days" :value="c.days">{{ c.label }}</option>
      </select>
      <p class="hint">For one-off work nobody needs the record of — it is removed with its thread and files.</p>
    </div>
    <div class="field">
      <span :id="`${idPrefix}-files-label`" class="label">Files <span class="muted">(optional)</span></span>
      <div>
        <input :id="`${idPrefix}-files`" class="sr-only" type="file" multiple :disabled="adding" @change="pickFiles" />
        <label class="btn" :for="`${idPrefix}-files`" :aria-disabled="adding">Choose files</label>
      </div>
      <ul v-if="files.length" class="draft-files" :aria-labelledby="`${idPrefix}-files-label`">
        <li v-for="f in files" :key="f.name + f.size + f.lastModified">
          <span class="mono small">{{ f.name }}</span>
          <span class="muted small">{{ human(f.size) }}</span>
          <button type="button" class="link small" :disabled="adding" :aria-label="`Remove ${f.name}`" @click="dropFile(f)">Remove</button>
        </li>
      </ul>
      <p class="hint">A screenshot of the bug, a recording, a log — choose them or paste them in. Uploaded with your duty and available to the agent when it reads it.</p>
      <ul v-if="uploading.length" class="uploads" aria-live="polite">
        <li v-for="u in uploading" :key="u.name">
          <span class="mono small">{{ u.name }}</span>
          <progress :value="u.pct" max="100">{{ u.pct }}%</progress>
          <span class="muted small">{{ u.pct }}%</span>
        </li>
      </ul>
    </div>
    <p v-if="error" class="notice notice--error" role="alert" style="margin: 0">{{ error }}</p>
    <div class="row">
      <button class="primary" type="submit" :disabled="adding || !board || !draft.title.trim() || !draft.brief.trim()">{{ submitLabel }}</button>
      <button type="button" :disabled="adding" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>
