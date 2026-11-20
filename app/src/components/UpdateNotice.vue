<script setup>
// "A newer DutyBoard is out", under the top bar, with the link that updates this deployment. Whoever
// opens it signs in to altengine and updates it as themselves; for anyone else on the board it is
// just news. Hidden for a version once dismissed, and shown again for the next one.
import { onMounted, ref } from "vue";
import { config } from "../config.js";
import { deployLink, releaseStatus } from "../lib/version.js";

const status = ref(null);
const KEY = "dutyboard.update.dismissed";

function dismissed(version) {
  try {
    return localStorage.getItem(KEY) === version;
  } catch {
    return false;
  }
}
function dismiss() {
  try {
    localStorage.setItem(KEY, status.value.latest);
  } catch {
    /* storage refused: it is hidden for this page load anyway */
  }
  status.value = null;
}

onMounted(async () => {
  const s = await releaseStatus();
  if (s && s.update_available && !dismissed(s.latest)) status.value = s;
});
</script>

<template>
  <div v-if="status" class="update" role="status">
    <div class="update__inner">
      <span>
        <strong>DutyBoard v{{ status.latest }} is out.</strong>
        This one is v{{ status.current }}.
      </span>
      <a class="btn btn--primary update__go" :href="deployLink(status.app || config.app)" target="_blank" rel="noopener noreferrer">Update</a>
      <button type="button" class="link small" @click="dismiss">Not now</button>
    </div>
  </div>
</template>

<style scoped>
.update { background: var(--accent-soft); border-bottom: 1px solid var(--border); }
.update__inner {
  max-width: 1200px; margin: 0 auto; padding: 0.5rem var(--gutter);
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.9rem; font-size: 0.9rem;
}
.update__go { padding: 0.3rem 0.8rem; font-size: 0.85rem; }
</style>
