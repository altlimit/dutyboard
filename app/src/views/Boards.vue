<script setup>
import { nextTick, onMounted, ref } from "vue";
import { api } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";

const boards = ref([]);
const loading = ref(true);
const error = ref("");
const creating = ref(false);
const showForm = ref(false);
const name = ref("");
const slug = ref("");
const nameInput = ref(null);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    boards.value = (await api("/projects/list")).projects;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** Opening the form moves focus into it. A button that reveals fields somewhere below,
 *  leaving focus on itself, is a form a keyboard user has to go looking for. */
async function openForm() {
  showForm.value = true;
  await nextTick();
  if (nameInput.value) nameInput.value.focus();
}

async function create() {
  creating.value = true;
  error.value = "";
  try {
    await api("/projects/create", { name: name.value, project_id: slug.value || undefined });
    name.value = "";
    slug.value = "";
    showForm.value = false;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="wrap stack">
    <div class="row row--between">
      <div>
        <h1>Your boards</h1>
        <p class="muted" style="margin: 0">
          A board is one stream of work. Agents connect to it with a token and only ever see
          the duties on it.
        </p>
      </div>
      <button
        class="primary page-action"
        type="button"
        :aria-expanded="showForm"
        @click="showForm ? (showForm = false) : openForm()"
      >
        {{ showForm ? "Cancel" : "New board" }}
      </button>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <!-- Behind a button, like "Add duty" on the board. Someone who already has boards came
         here to open one, and a permanent form pushes what they came for down the page. -->
    <form v-if="showForm" class="panel panel--form stack" @submit.prevent="create">
      <h2 style="margin: 0">New board</h2>
      <div class="field">
        <label for="b-name">Name</label>
        <input id="b-name" ref="nameInput" v-model="name" required maxlength="120" placeholder="Backend rewrite" />
      </div>
      <div class="field">
        <label for="b-slug">Board id <span class="muted">(optional)</span></label>
        <input id="b-slug" v-model="slug" maxlength="60" placeholder="derived from the name" />
        <p class="hint">Agents refer to the board by this id, so keep it short and stable. It cannot be changed later.</p>
      </div>
      <div>
        <button class="primary" type="submit" :disabled="creating || !name">
          {{ creating ? "Creating…" : "Create board" }}
        </button>
      </div>
    </form>

    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else>
      <!-- The whole card is the link. Two targets on one row — open, and settings — meant
           the obvious tap did the less likely thing about half the time; the board's own
           nav carries Agents & tokens, which is where you go once you are inside it. -->
      <ul v-if="boards.length" class="cards">
        <li v-for="b in boards" :key="b.project_id">
          <router-link class="boardcard" :to="{ name: 'board', params: { projectId: b.project_id } }">
            <span class="boardcard__name">{{ b.name }}</span>
            <span class="boardcard__meta mono">{{ b.project_id }}</span>
            <span class="boardcard__meta">created {{ ago(b.created_at) }}</span>
          </router-link>
        </li>
      </ul>

      <p v-else class="empty">
        No boards yet. Create one and mint a token for your first agent.
      </p>
    </template>
  </div>
</template>
