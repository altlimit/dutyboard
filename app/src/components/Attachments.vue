<script setup>
// Files on a duty: pick, upload, look at, remove.
//
// The bytes go straight from this page to storage. `/duty/attach` decides whether they may
// and how big, and answers with a URL to PUT to — nothing passes through the function,
// which is what makes a video attachment possible rather than a 413.
//
// Only images and video are rendered inline. Anything else is a link, deliberately: the
// download URL points at a storage origin, and inlining arbitrary content from one is how
// an attachment stops being an attachment.

import { computed, ref } from "vue";
import { api, putSigned } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";
import { user } from "../lib/session.js";

const props = defineProps({
  dutyId: { type: String, required: true },
  items: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(["changed"]);

const input = ref(null);
const uploads = ref([]); // [{ name, pct, error }]
const error = ref("");

const isImage = (a) => (a.content_type || "").startsWith("image/");
const isVideo = (a) => (a.content_type || "").startsWith("video/");
const busyNow = computed(() => uploads.value.length > 0);

function human(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function pick(event) {
  const files = [...(event.target.files || [])];
  event.target.value = ""; // so the same file can be chosen twice in a row
  for (const file of files) await upload(file);
  if (files.length) emit("changed");
}

async function upload(file) {
  const entry = { name: file.name, pct: 0, error: "" };
  uploads.value = [...uploads.value, entry];
  error.value = "";
  try {
    const minted = await api("/duty/attach", {
      duty_id: props.dutyId,
      name: file.name,
      size: file.size,
      content_type: file.type || "application/octet-stream",
    });
    await putSigned(minted.upload_url, minted.required_headers, file, (pct) => (entry.pct = pct));
  } catch (err) {
    // The row exists but the bytes did not arrive. It shows as pending and is swept an
    // hour later, so the failure here is worth reporting and not worth cleaning up by hand.
    error.value = `${file.name}: ${err.message}`;
  } finally {
    uploads.value = uploads.value.filter((u) => u !== entry);
  }
}

async function remove(a) {
  if (!confirm(`Remove "${a.name}"? The file is deleted, not just unlinked.`)) return;
  error.value = "";
  try {
    await api("/duty/attachment/delete", { attachment_id: a.id });
    emit("changed");
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <section class="panel stack" aria-labelledby="att-h">
    <div class="panel__head">
      <h2 id="att-h">Files</h2>
      <div>
        <input
          ref="input"
          id="att-input"
          class="sr-only"
          type="file"
          multiple
          :disabled="busy || busyNow"
          @change="pick"
        />
        <label class="btn" for="att-input" :aria-disabled="busy || busyNow">
          {{ busyNow ? "Uploading…" : "Add files" }}
        </label>
      </div>
    </div>

    <p v-if="error" class="notice notice--error" role="alert" style="margin: 0">{{ error }}</p>

    <ul v-if="uploads.length" class="uploads" aria-live="polite">
      <li v-for="u in uploads" :key="u.name">
        <span class="mono small">{{ u.name }}</span>
        <progress :value="u.pct" max="100">{{ u.pct }}%</progress>
        <span class="muted small">{{ u.pct }}%</span>
      </li>
    </ul>

    <p v-if="!items.length && !uploads.length" class="muted small" style="margin: 0">
      Screenshots, recordings, logs — anything an agent or a person should look at rather than
      read about. Agents can add them too, and read the ones you add.
    </p>

    <ul v-else-if="items.length" class="files">
      <li v-for="a in items" :key="a.id" class="file">
        <a v-if="isImage(a) && a.url" :href="a.url" target="_blank" rel="noopener" class="file__shot">
          <img :src="a.url" :alt="a.name" loading="lazy" />
        </a>
        <video v-else-if="isVideo(a) && a.url" class="file__shot" controls preload="metadata" :src="a.url"></video>

        <div class="file__meta">
          <a v-if="a.url" :href="a.url" target="_blank" rel="noopener">{{ a.name }}</a>
          <span v-else>{{ a.name }}</span>
          <span class="muted small">
            {{ human(a.size) }} ·
            {{ a.author_type === "agent" ? a.author_id : user && a.author_id === user.uid ? "you" : a.author_name || "someone" }} ·
            {{ ago(a.created_at) }}
            <template v-if="a.pending"> · <strong>uploading…</strong></template>
          </span>
        </div>

        <button type="button" class="link small" :disabled="busy" @click="remove(a)">Remove</button>
      </li>
    </ul>
  </section>
</template>
