<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { query, getDocs, putDocs, deleteDocs, subscribeLive, ApiError } from "../lib/altengine.js";
import { config } from "../config.js";
import { session } from "../lib/session.js";
import { fmtTime } from "../lib/time.js";

const props = defineProps({
  slug: { type: String, required: true },
  dutyKey: { type: String, required: true },
});

const router = useRouter();
const duty = ref(null);
const comments = ref([]);
const loading = ref(true);
const error = ref("");
const notFound = ref(false);
const liveState = ref("idle");

const form = reactive({ body: "" });
const posting = ref(false);
const formError = ref("");
const acting = ref(false);

let sub = null;
let reloadTimer = null;

const isOwner = computed(() => duty.value && duty.value.data.author_uid && duty.value.data.author_uid === session.uid.value);
const resolved = computed(() => duty.value && (duty.value.data.status || "open") === "resolved");

async function loadDuty() {
  const res = await getDocs("duties", [props.dutyKey]);
  if (!res.documents || !res.documents.length) {
    notFound.value = true;
    duty.value = null;
    return;
  }
  duty.value = res.documents[0];
}

async function loadComments() {
  const res = await query("comments", {
    where: [{ field: "duty_key", op: "=", value: props.dutyKey }],
    order: [{ field: "__created__", dir: "asc" }],
    limit: 200,
  });
  comments.value = res.documents || [];
}

async function reloadAll() {
  try {
    await Promise.all([loadDuty(), loadComments()]);
  } catch (e) {
    error.value = e.message || "Failed to refresh.";
  }
}

function scheduleReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadAll();
  }, 300);
}

async function postComment() {
  formError.value = "";
  const body = form.body.trim();
  if (!body) {
    formError.value = "Write something first.";
    return;
  }
  posting.value = true;
  try {
    await putDocs("comments", [{ data: { duty_key: props.dutyKey, body } }]);
    form.body = "";
    await loadComments();
  } catch (e) {
    formError.value = e instanceof ApiError ? e.message : "Couldn't post your comment.";
  } finally {
    posting.value = false;
  }
}

// Owner toggles resolved/open. `put` replaces the doc, so resend the full data with
// only `status` changed — immutable fields (author_uid, city_slug, created) are
// resent unchanged, so the backend's immutable guard is satisfied.
async function toggleResolved() {
  if (!duty.value) return;
  acting.value = true;
  error.value = "";
  try {
    const next = resolved.value ? "open" : "resolved";
    await putDocs("duties", [{ key: props.dutyKey, data: { ...duty.value.data, status: next } }]);
    await loadDuty();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "Couldn't update the duty.";
  } finally {
    acting.value = false;
  }
}

async function removeDuty() {
  if (!duty.value) return;
  if (!confirm("Delete this duty and stop tracking it?")) return;
  acting.value = true;
  try {
    await deleteDocs("duties", [props.dutyKey]);
    router.push({ name: "city", params: { slug: props.slug } });
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "Couldn't delete the duty.";
    acting.value = false;
  }
}

onMounted(async () => {
  loading.value = true;
  await reloadAll();
  loading.value = false;
  if (config.channel) {
    sub = subscribeLive(
      ["comments." + props.dutyKey],
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
  <p class="crumbs">
    <RouterLink :to="{ name: 'cities' }">All cities</RouterLink>
    <span aria-hidden="true"> / </span>
    <RouterLink :to="{ name: 'city', params: { slug: props.slug } }">{{ props.slug }}</RouterLink>
  </p>

  <p v-if="loading" class="muted">Loading…</p>
  <p v-else-if="notFound" class="alert alert--info">That duty doesn't exist (or was deleted).</p>

  <template v-else-if="duty">
    <div class="row-between">
      <h1>{{ duty.data.title }}</h1>
      <span class="badge" :class="resolved ? 'badge--resolved' : 'badge--open'">{{ resolved ? "Resolved" : "Open" }}</span>
    </div>
    <p class="meta">Posted by {{ duty.data.author_name || "someone" }} · {{ fmtTime(duty.created) }}</p>

    <p v-if="duty.data.body" style="white-space: pre-wrap">{{ duty.data.body }}</p>

    <div v-if="isOwner" class="btn-row" style="margin: 0.75rem 0 0.25rem">
      <button type="button" class="btn btn--sm" :disabled="acting" @click="toggleResolved">
        {{ resolved ? "Reopen" : "Mark resolved" }}
      </button>
      <button type="button" class="btn btn--sm btn--danger" :disabled="acting" @click="removeDuty">Delete</button>
    </div>

    <div aria-live="polite">
      <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
    </div>

    <div class="row-between">
      <h2>Discussion</h2>
      <span class="live-dot" :data-state="liveState">{{ liveState === "open" ? "Live" : "Updates" }}</span>
    </div>

    <section :aria-busy="posting" class="card">
      <p v-if="!comments.length" class="muted">No comments yet. Start the conversation.</p>
      <ul v-else class="list">
        <li v-for="cmt in comments" :key="cmt.key" class="comment">
          <p style="margin: 0; white-space: pre-wrap">{{ cmt.data.body }}</p>
          <p class="meta" style="margin: 0.25rem 0 0">— {{ cmt.data.author_name || "someone" }} · {{ fmtTime(cmt.created) }}</p>
        </li>
      </ul>
    </section>

    <form @submit.prevent="postComment" novalidate>
      <div class="field">
        <label for="c-body">Add a comment</label>
        <textarea id="c-body" v-model="form.body" placeholder="Share an update or offer to help…" :aria-invalid="!!formError" aria-describedby="c-body-err"></textarea>
        <p v-if="formError" id="c-body-err" class="field__error" role="alert">{{ formError }}</p>
      </div>
      <div class="btn-row">
        <button class="btn" type="submit" :disabled="posting">
          <span v-if="posting" class="spin" aria-hidden="true">⏳</span> Comment
        </button>
      </div>
    </form>
  </template>
</template>
