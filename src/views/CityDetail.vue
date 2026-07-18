<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { query, getDocs, putDocs, subscribeLive, ApiError } from "../lib/altengine.js";
import { config } from "../config.js";
import { fmtTime } from "../lib/time.js";

const props = defineProps({ slug: { type: String, required: true } });

const cityName = ref(props.slug);
const duties = ref([]);
const loading = ref(true);
const error = ref("");
const filter = ref("all"); // all | open | resolved
const liveState = ref("idle");

const form = reactive({ title: "", body: "" });
const posting = ref(false);
const formError = ref("");

let sub = null;
let reloadTimer = null;

const shown = computed(() => {
  if (filter.value === "all") return duties.value;
  return duties.value.filter((d) => (d.data.status || "open") === filter.value);
});
const openCount = computed(() => duties.value.filter((d) => (d.data.status || "open") === "open").length);

async function loadCity() {
  try {
    const res = await getDocs("cities", [props.slug]);
    if (res.documents && res.documents.length) cityName.value = res.documents[0].data.name;
  } catch {
    /* keep the slug as a fallback title */
  }
}

async function loadDuties() {
  error.value = "";
  try {
    const res = await query("duties", {
      where: [{ field: "city_slug", op: "=", value: props.slug }],
      order: [{ field: "__created__", dir: "desc" }],
      limit: 100,
    });
    duties.value = res.documents || [];
  } catch (e) {
    error.value = e.message || "Failed to load duties.";
  } finally {
    loading.value = false;
  }
}

// A live event just tells us "something changed on this city" — coalesce a reload.
function scheduleReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadDuties();
  }, 300);
}

async function postDuty() {
  formError.value = "";
  const title = form.title.trim();
  if (!title) {
    formError.value = "Give the duty a short title.";
    return;
  }
  posting.value = true;
  try {
    // author_uid / author_name are stamped server-side from the token — not sent here.
    await putDocs("duties", [{ data: { city_slug: props.slug, title, body: form.body.trim(), status: "open" } }]);
    form.title = "";
    form.body = "";
    await loadDuties();
  } catch (e) {
    formError.value = e instanceof ApiError ? e.message : "Couldn't post the duty.";
  } finally {
    posting.value = false;
  }
}

onMounted(async () => {
  loading.value = true;
  await Promise.all([loadCity(), loadDuties()]);
  // Live: subscribe to this city's duty channel. Fails soft if the channel instance
  // isn't configured — the board still works, just without push updates.
  if (config.channel) {
    sub = subscribeLive(
      ["duties." + props.slug],
      () => scheduleReload(),
      (s) => (liveState.value = s)
    );
  }
});

onUnmounted(() => {
  if (sub) sub.close();
  if (reloadTimer) clearTimeout(reloadTimer);
});
</script>

<template>
  <p class="crumbs"><RouterLink :to="{ name: 'cities' }">← All cities</RouterLink></p>

  <div class="row-between">
    <h1>{{ cityName }}</h1>
    <span class="live-dot" :data-state="liveState" :title="'Live updates: ' + liveState">
      {{ liveState === "open" ? "Live" : "Updates" }}
    </span>
  </div>
  <p class="muted">{{ openCount }} open {{ openCount === 1 ? "duty" : "duties" }}</p>

  <form class="card" @submit.prevent="postDuty" novalidate>
    <h2 style="margin-top: 0">Post a duty</h2>
    <div class="field">
      <label for="d-title">Title</label>
      <input id="d-title" v-model="form.title" type="text" placeholder="e.g. Pothole on 4th & Main" :aria-invalid="!!formError" aria-describedby="d-title-err" />
      <p v-if="formError" id="d-title-err" class="field__error" role="alert">{{ formError }}</p>
    </div>
    <div class="field">
      <label for="d-body">Details <span class="muted">(optional)</span></label>
      <textarea id="d-body" v-model="form.body" placeholder="What needs doing? Any context?"></textarea>
    </div>
    <div class="btn-row">
      <button class="btn" type="submit" :disabled="posting">
        <span v-if="posting" class="spin" aria-hidden="true">⏳</span> Post duty
      </button>
    </div>
  </form>

  <div class="row-between">
    <h2>Duties</h2>
    <div class="btn-row" role="group" aria-label="Filter duties">
      <button type="button" class="btn btn--sm" :class="filter === 'all' ? '' : 'btn--ghost'" :aria-pressed="filter === 'all'" @click="filter = 'all'">All</button>
      <button type="button" class="btn btn--sm" :class="filter === 'open' ? '' : 'btn--ghost'" :aria-pressed="filter === 'open'" @click="filter = 'open'">Open</button>
      <button type="button" class="btn btn--sm" :class="filter === 'resolved' ? '' : 'btn--ghost'" :aria-pressed="filter === 'resolved'" @click="filter = 'resolved'">Resolved</button>
    </div>
  </div>

  <div aria-live="polite">
    <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
  </div>

  <p v-if="loading" class="muted">Loading duties…</p>
  <p v-else-if="!shown.length" class="muted">No {{ filter === "all" ? "" : filter }} duties here yet.</p>

  <ul v-else class="list">
    <li v-for="d in shown" :key="d.key" class="card">
      <div class="row-between">
        <RouterLink class="card__title" :to="{ name: 'duty', params: { slug: props.slug, dutyKey: d.key } }">
          {{ d.data.title }}
        </RouterLink>
        <span class="badge" :class="(d.data.status || 'open') === 'resolved' ? 'badge--resolved' : 'badge--open'">
          {{ (d.data.status || "open") === "resolved" ? "Resolved" : "Open" }}
        </span>
      </div>
      <p class="meta">by {{ d.data.author_name || "someone" }} · {{ fmtTime(d.created) }}</p>
    </li>
  </ul>
</template>
