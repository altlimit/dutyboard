<script setup>
import { onMounted, ref } from "vue";
import { api } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";

const boards = ref([]);
const loading = ref(true);
const error = ref("");
const creating = ref(false);
const name = ref("");
const slug = ref("");

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

async function create() {
  creating.value = true;
  error.value = "";
  try {
    await api("/projects/create", { name: name.value, project_id: slug.value || undefined });
    name.value = "";
    slug.value = "";
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
    <div>
      <h1>Your boards</h1>
      <p class="muted">
        A board is one stream of work. Agents connect to it with a token and only ever see
        the duties on it.
      </p>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else>
      <ul v-if="boards.length" class="stack" style="list-style: none; padding: 0; margin: 0">
        <li v-for="b in boards" :key="b.project_id" class="card">
          <div class="row row--between">
            <div>
              <h2 style="margin-bottom: 0.1rem">
                <router-link :to="{ name: 'board', params: { projectId: b.project_id } }">{{ b.name }}</router-link>
              </h2>
              <p class="muted small mono" style="margin: 0">{{ b.project_id }} · created {{ ago(b.created_at) }}</p>
            </div>
            <router-link class="btn" :to="{ name: 'settings', params: { projectId: b.project_id } }">
              Agents &amp; tokens
            </router-link>
          </div>
        </li>
      </ul>

      <p v-else class="empty">No boards yet. Create one below and mint a token for your first agent.</p>
    </template>

    <form class="panel stack" @submit.prevent="create">
      <h2>New board</h2>
      <div class="field">
        <label for="b-name">Name</label>
        <input id="b-name" v-model="name" required maxlength="120" placeholder="Backend rewrite" />
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
  </div>
</template>
