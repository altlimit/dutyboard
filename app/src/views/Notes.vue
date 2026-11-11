<script setup>
import BoardNav from "../components/BoardNav.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import { api, putSigned, subscribeLive } from "../lib/altengine.js";
import { plain } from "../lib/markdown.js";
import { pastedFiles } from "../lib/paste.js";
import { statusLabel } from "../lib/duties.js";

const props = defineProps({ projectId: { type: String, required: true } });
const board = ref(null), notes = ref([]), review = ref(null);
const loading = ref(true), error = ref(""), notice = ref(""), busy = ref(false), saving = ref(false);
const showForm = ref(false), title = ref(""), brief = ref(""), files = ref([]), upload = ref("");
const dragging = ref(null), moving = ref(new Set()), clearing = ref(new Set());
let socket, timer, generation = 0;
const eligible = computed(() => notes.value.filter(n => !n.has_suggestions));
const position = (n, i) => n.note_position || { x: 24 + (i % 3) * 300, y: 24 + Math.floor(i / 3) * 300 };
const canvasSize = computed(() => ({
  width: `${Math.max(920, ...notes.value.map((n, i) => position(n, i).x + 300))}px`,
  height: `${Math.max(560, ...notes.value.map((n, i) => position(n, i).y + 300))}px`,
}));
function cardStyle(n, i) { const p = position(n, i); return { left: `${p.x}px`, top: `${p.y}px` }; }

async function load() {
  const current = generation, projectId = props.projectId;
  try {
    const rows = [];
    let cursor, latest;
    do {
      const res = await api("/note/list", { project_id: projectId, cursor });
      rows.push(...res.notes); cursor = res.cursor; latest = res.review;
    } while (cursor);
    if (current !== generation) return;
    if (!dragging.value && !moving.value.size) notes.value = rows;
    review.value = latest;
  } catch (err) { if (current === generation) error.value = err.message; }
  finally { if (current === generation) loading.value = false; }
}
function refreshSoon() { clearTimeout(timer); timer = setTimeout(load, 200); }
watch(() => props.projectId, async () => {
  const current = ++generation;
  socket?.close(); clearTimeout(timer);
  board.value = null; notes.value = []; review.value = null; loading.value = true;
  error.value = notice.value = ""; showForm.value = false; title.value = brief.value = ""; files.value = [];
  dragging.value = null; moving.value = new Set();
  await load();
  try {
    const res = await api("/board/open", { project_id: props.projectId });
    if (current !== generation) return;
    board.value = res.project;
    socket = subscribeLive({ projectId: props.projectId, mint: res.live }, refreshSoon);
  } catch (err) { if (current === generation) error.value = err.message; }
}, { immediate: true });
onUnmounted(() => { generation++; socket?.close(); clearTimeout(timer); });

function pick(event) { files.value.push(...event.target.files); event.target.value = ""; }
function paste(event) { if (!saving.value) files.value.push(...pastedFiles(event)); }
async function add() {
  saving.value = true; error.value = notice.value = "";
  try {
    const res = await api("/note/create", { project_id: props.projectId, title: title.value, brief: brief.value, expect_files: files.value.length });
    const failed = [];
    for (const file of files.value) {
      upload.value = file.name;
      try {
        const minted = await api("/duty/attach", { duty_id: res.duty_id, name: file.name, size: file.size, content_type: file.type || "application/octet-stream" });
        await putSigned(minted.upload_url, minted.required_headers, file);
      } catch (err) { failed.push(`${file.name}: ${err.message}`); }
    }
    if (failed.length) error.value = `Note saved, but some files failed. Open the note to retry: ${failed.join("; ")}`;
    title.value = brief.value = ""; files.value = []; showForm.value = false;
    await load();
  } catch (err) { error.value = err.message; }
  finally { saving.value = false; upload.value = ""; }
}
async function clearLink(n) {
  const current = generation;
  clearing.value.add(n.id); error.value = notice.value = "";
  try {
    await api("/note/clear", { note_id: n.id });
    if (current === generation) await load();
  } catch (err) { if (current === generation) error.value = err.message; }
  finally { clearing.value.delete(n.id); }
}
async function suggest() {
  busy.value = true; error.value = notice.value = "";
  try {
    await api("/note/process", { project_id: props.projectId });
    notice.value = "Review requested. An agent will consider notes without linked suggestions together; suggested duties will wait in Needs you for approval.";
    await load();
  } catch (err) { error.value = err.message; }
  finally { busy.value = false; }
}
function startDrag(event, n, i) {
  if (event.button !== 0 || moving.value.has(n.id) || !matchMedia("(min-width: 701px)").matches) return;
  const before = { ...position(n, i) };
  dragging.value = { id: n.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, before };
  event.currentTarget.setPointerCapture(event.pointerId);
}
function drag(event, n) {
  const d = dragging.value;
  if (!d || d.id !== n.id || event.pointerId !== d.pointer) return;
  n.note_position = { x: Math.round(Math.max(0, Math.min(10000, d.before.x + event.clientX - d.x))), y: Math.round(Math.max(0, Math.min(50000, d.before.y + event.clientY - d.y))) };
}
async function savePosition(n, before) {
  const current = generation;
  moving.value.add(n.id); error.value = "";
  try { await api("/note/move", { note_id: n.id, ...n.note_position }); }
  catch (err) { if (current === generation) { n.note_position = before; error.value = `Could not save this position: ${err.message}`; } }
  finally { if (current === generation) { moving.value.delete(n.id); refreshSoon(); } }
}
function drop(event, n, cancel = false) {
  const d = dragging.value;
  if (!d || d.id !== n.id || d.pointer !== event.pointerId) return;
  dragging.value = null;
  if (cancel) n.note_position = d.before;
  else if (n.note_position) savePosition(n, d.before);
}
function nudge(event, n, i) {
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!arrows[event.key] || moving.value.has(n.id)) return;
  event.preventDefault();
  const before = { ...position(n, i) }, [x, y] = arrows[event.key], step = event.shiftKey ? 40 : 10;
  n.note_position = { x: Math.max(0, Math.min(10000, before.x + x * step)), y: Math.max(0, Math.min(50000, before.y + y * step)) };
  savePosition(n, before);
}
</script>

<template>
  <div class="wrap wrap--board stack notes-page">
    <BoardNav :project-id="projectId" :name="board?.name" active="notes" />
    <div class="row row--between">
      <div><h1>Notes</h1><p class="muted">Ideas, references and files for {{ board?.name || 'this board' }}.</p></div>
      <div class="row">
        <button @click="load" :disabled="loading">Refresh</button>
        <button class="primary" @click="showForm = !showForm" :aria-expanded="showForm" :disabled="saving">{{ showForm ? 'Cancel' : 'Add note' }}</button>
        <button v-if="eligible.length" @click="suggest()" :disabled="busy || saving || !!review || !!clearing.size">{{ busy ? 'Requesting…' : 'Suggest duties' }}</button>
      </div>
    </div>
    <p v-if="notes.length" class="hint">Suggest duties reviews notes without a linked suggestion. Related notes can become one duty, which waits for your approval in Needs you. Clear a note’s link to include it again; existing duties and source history stay.</p>
    <p v-if="notes.length && !review" class="hint">{{ eligible.length ? `${eligible.length} ${eligible.length === 1 ? 'note ready' : 'notes ready'} for suggestions.` : 'All notes have linked suggestions. Add a note or clear a link to suggest again.' }}</p>
    <p v-if="notes.length && review" class="notice"><router-link :to="{ name: 'duty', params: { projectId, dutyId: review.id } }">{{ review.title }}</router-link> · {{ statusLabel(review.status) }}. Notes added now will be included in the next review.</p>
    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notes.length && notice && review" class="notice" role="status">{{ notice }}</p>
    <form v-if="showForm" class="panel stack note-form" @submit.prevent="add" @paste="paste">
      <div class="field"><label for="note-title">Title</label><input id="note-title" v-model="title" required maxlength="200" :disabled="saving" /></div>
      <div class="field"><label for="note-body">Note</label><textarea id="note-body" v-model="brief" maxlength="4000" :required="!files.length" :disabled="saving" placeholder="An idea, a question, or something the board should know…"></textarea></div>
      <div class="field"><label for="note-files">Files (optional)</label><input id="note-files" type="file" multiple @change="pick" :disabled="saving" /></div>
      <ul v-if="files.length"><li v-for="(file, i) in files" :key="i">{{ file.name }} <button type="button" class="link" @click="files.splice(i, 1)" :disabled="saving">Remove</button></li></ul>
      <p class="hint">You can also paste files here. Saving a note does not start work.</p>
      <p v-if="upload" role="status">Uploading {{ upload }}…</p>
      <div><button class="primary" :disabled="saving || !title.trim() || (!brief.trim() && !files.length)">{{ saving ? 'Saving…' : 'Save note' }}</button></div>
    </form>
    <p v-if="loading" role="status">Loading notes…</p>
    <div v-else-if="!notes.length" class="panel empty">Your notes board is empty. Add an idea, reference or file to get started.</div>
    <template v-else>
      <p class="hint drag-hint">Drag a card by its handle to arrange it. You can also focus the handle and use arrow keys; hold Shift for larger steps. Positions are saved for everyone on the board.</p>
      <div class="notes-scroll" aria-label="Notes board">
        <div class="notes-canvas" :style="canvasSize">
          <article v-for="(n, i) in notes" :key="n.id" class="sticky" :class="[`sticky--${i % 4}`, { 'sticky--moving': dragging?.id === n.id }]" :style="cardStyle(n, i)">
            <button class="sticky__handle" :aria-disabled="moving.has(n.id) || undefined" :aria-label="`Move ${n.title}. Use arrow keys to arrange.`" @pointerdown="startDrag($event, n, i)" @pointermove="drag($event, n)" @pointerup="drop($event, n)" @pointercancel="drop($event, n, true)" @keydown="nudge($event, n, i)"><span aria-hidden="true">⠿</span></button>
            <h2><router-link :to="{ name: 'duty', params: { projectId, dutyId: n.id } }">{{ n.title }}</router-link></h2>
            <p class="sticky__body">{{ plain(n.brief) }}</p>
            <div class="sticky__footer"><span v-if="n.attachment_count">{{ n.attachment_count }} {{ n.attachment_count === 1 ? 'file' : 'files' }} · </span><router-link :to="{ name: 'duty', params: { projectId, dutyId: n.id } }">Open note &amp; suggestions →</router-link>
              <div v-if="n.has_suggestions" class="sticky__links"><span>Linked</span><button class="sticky__clear" :aria-label="`Clear suggestion link for ${n.title}`" :disabled="!!review || clearing.has(n.id)" @click="clearLink(n)">Clear link</button></div>
            </div>
          </article>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.note-form { max-width: 700px; }
.notes-scroll { overflow: auto; max-height: 78vh; border: 1px solid var(--border); border-radius: 12px; background-color: var(--bg); background-image: radial-gradient(var(--border) 1px, transparent 1px); background-size: 20px 20px; }
.notes-canvas { position: relative; }
.sticky { position: absolute; width: 274px; height: 274px; padding: 14px 18px 18px; box-sizing: border-box; border-radius: 3px 3px 20px 3px; background: #f5e8a6; color: #30291d; box-shadow: 2px 5px 12px #0003; display: flex; flex-direction: column; overflow: hidden; }
.sticky--1 { background: #cce7d1; }.sticky--2 { background: #f1cfce; }.sticky--3 { background: #ded5ef; }
.sticky--moving { z-index: 5; box-shadow: 3px 10px 20px #0005; }
.sticky:focus-within { z-index: 4; }
.sticky a { color: inherit; }.sticky h2 { font-size: 1.12rem; line-height: 1.35; margin: 6px 0 8px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sticky h2 a { text-decoration: none; }.sticky h2 a:hover { text-decoration: underline; }
.sticky__handle { background: transparent; color: #514a3b; border: 0; padding: 0; width: 32px; min-height: 28px; align-self: flex-start; cursor: grab; touch-action: none; font-size: 1.1rem; }
.sticky__handle:hover:not(:disabled), .sticky__handle:active { background: #30291d14; color: #30291d; }
.sticky__handle:active { cursor: grabbing; }.sticky__handle:focus-visible { outline: 2px solid #514a3b; outline-offset: 2px; }
.sticky__body { margin: 0; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.sticky__links { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
.sticky__clear { color: inherit; background: transparent; border: 0; padding: 2px 0; font-size: inherit; text-decoration: underline; min-height: 28px; }
.sticky__clear:hover:not(:disabled) { color: #30291d; background: #30291d14; }
.sticky__footer { margin-top: auto; padding-top: 12px; font-size: .8rem; }
@media (max-width: 700px) {
  .drag-hint, .sticky__handle { display: none; }
  .notes-scroll { overflow: visible; max-height: none; background: none; border: 0; }
  .notes-canvas { width: 100% !important; height: auto !important; display: flex; flex-direction: column; gap: 16px; }
  .sticky { position: static; width: 100%; height: auto; min-height: 180px; padding: 20px; }
  .sticky__body { -webkit-line-clamp: 8; }
}
</style>
