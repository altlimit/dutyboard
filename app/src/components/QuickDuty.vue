<script setup>
// A duty filed from the office: which board, a title and a brief. Everything else — priority, files,
// models, when it is removed — is on the board's Duties page; this is for "have them do this" while
// watching. It lands in the board's tray like any other new duty.
import { computed, nextTick, ref } from "vue";
import { api } from "../lib/altengine.js";

const props = defineProps({
  // `[{ project_id, name }]`: the boards it can be filed on. One means no choice is offered.
  boards: { type: Array, required: true },
});
const emit = defineEmits(["added"]);

const isOpen = ref(false);
const board = ref("");
const title = ref("");
const brief = ref("");
const sending = ref(false);
const error = ref("");
const notice = ref("");
const titleInput = ref(null);
const form = ref(null);

const single = computed(() => props.boards.length === 1);
const boardName = computed(() => (props.boards.find((b) => b.project_id === board.value) || {}).name || board.value);

/** Open the form, on a board if one is named, ready to type the title. */
async function open(projectId) {
  board.value = projectId || board.value || (props.boards[0] && props.boards[0].project_id) || "";
  isOpen.value = true;
  error.value = "";
  await nextTick();
  form.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  titleInput.value?.focus({ preventScroll: true });
}
defineExpose({ open });

async function add() {
  sending.value = true;
  error.value = "";
  try {
    const res = await api("/duty/enqueue", { project_id: board.value, title: title.value.trim(), brief: brief.value.trim() });
    notice.value = `Added “${title.value.trim()}” to ${boardName.value}.`;
    emit("added", { duty_id: res.duty_id, project_id: board.value });
    title.value = "";
    brief.value = "";
    isOpen.value = false;
  } catch (err) {
    error.value = err.message;
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <section class="quick" aria-labelledby="quick-h">
    <div class="row row--between">
      <h2 id="quick-h" class="quick__h">New duty</h2>
      <p v-if="notice && !isOpen" class="small muted" role="status" style="margin: 0">{{ notice }}</p>
      <button v-if="!isOpen" type="button" :disabled="!boards.length" @click="open()">Add a duty</button>
    </div>
    <form v-if="isOpen" ref="form" class="stack quick__form" @submit.prevent="add">
      <div v-if="!single" class="field">
        <label for="quick-board">Board</label>
        <select id="quick-board" v-model="board" required>
          <option v-for="b in boards" :key="b.project_id" :value="b.project_id">{{ b.name || b.project_id }}</option>
        </select>
      </div>
      <div class="field">
        <label for="quick-title">Title</label>
        <input id="quick-title" ref="titleInput" v-model="title" required maxlength="200" placeholder="A short name for what you want done" />
      </div>
      <div class="field">
        <label for="quick-brief">Brief</label>
        <textarea id="quick-brief" v-model="brief" required maxlength="4000" rows="3" placeholder="What should change, and how you will know it is done."></textarea>
        <p class="hint">
          It goes to the role that reads new duties first, who passes it on.
          <router-link v-if="board" :to="{ name: 'board', params: { projectId: board } }">Priority, files and models</router-link> are on the board's Duties page.
        </p>
      </div>
      <p v-if="error" class="notice notice--error small" role="alert" style="margin: 0">{{ error }}</p>
      <div class="row">
        <button class="primary" type="submit" :disabled="sending || !board || !title.trim() || !brief.trim()">{{ sending ? "Adding…" : single ? "Add to the queue" : `Add to ${boardName}` }}</button>
        <button type="button" :disabled="sending" @click="isOpen = false">Cancel</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.quick { display: flex; flex-direction: column; gap: 0.5rem; }
.quick__h { margin: 0; font-size: 1.05rem; }
.quick__form { border: 2px solid var(--accent); border-radius: 8px; background: var(--surface); padding: 0.8rem; }
</style>
