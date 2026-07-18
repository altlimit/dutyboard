<script setup>
import { ref, reactive, onMounted } from "vue";
import { useRouter } from "vue-router";
import { query, getDocs, putDocs, ApiError } from "../lib/altengine.js";
import { slugify } from "../lib/slug.js";

const router = useRouter();
const cities = ref([]);
const loading = ref(true);
const error = ref("");
const form = reactive({ name: "" });
const creating = ref(false);
const formError = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await query("cities", { order: [{ field: "name", dir: "asc" }], limit: 200 });
    cities.value = res.documents || [];
  } catch (e) {
    error.value = e.message || "Failed to load cities.";
  } finally {
    loading.value = false;
  }
}

async function createCity() {
  formError.value = "";
  const name = form.name.trim();
  const slug = slugify(name);
  if (!slug) {
    formError.value = "Please enter a city name.";
    return;
  }
  creating.value = true;
  try {
    // A city is keyed by its slug so names don't duplicate. If it already exists,
    // just go there (a plain upsert would hit the owner-guard for someone else's row).
    const existing = await getDocs("cities", [slug]);
    if (!existing.documents || !existing.documents.length) {
      await putDocs("cities", [{ key: slug, data: { name, slug } }]);
    }
    form.name = "";
    router.push({ name: "city", params: { slug } });
  } catch (e) {
    formError.value = e instanceof ApiError ? e.message : "Couldn't create the city.";
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <h1>Cities</h1>
  <p class="muted">Pick a city to see the duties people have posted — or start a new one.</p>

  <form class="card" @submit.prevent="createCity" novalidate>
    <div class="field">
      <label for="city-name">Add a city</label>
      <input id="city-name" v-model="form.name" type="text" placeholder="e.g. Portland" :aria-invalid="!!formError" aria-describedby="city-name-err" />
      <p v-if="formError" id="city-name-err" class="field__error" role="alert">{{ formError }}</p>
    </div>
    <div class="btn-row">
      <button class="btn" type="submit" :disabled="creating">
        <span v-if="creating" class="spin" aria-hidden="true">⏳</span> Add city
      </button>
    </div>
  </form>

  <div aria-live="polite">
    <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
  </div>

  <p v-if="loading" class="muted">Loading cities…</p>
  <p v-else-if="!cities.length" class="muted">No cities yet — add the first one above.</p>

  <ul v-else class="list">
    <li v-for="c in cities" :key="c.key" class="card">
      <RouterLink class="card__title" :to="{ name: 'city', params: { slug: c.key } }">
        {{ c.data.name }}
      </RouterLink>
    </li>
  </ul>
</template>
