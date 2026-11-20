<script setup>
// A recurring duty read without leaving the office: what it files and how often, when it runs next,
// the check it runs first if it has one, and what its last runs did — each of which opens its duty.
// Changing it is in the board's settings, a link away.
import { computed, ref, watch } from "vue";
import { api } from "../lib/altengine.js";
import { ago, statusLabel, until } from "../lib/duties.js";
import { markdown } from "../lib/markdown.js";
import { repeatText, runText } from "../lib/schedules.js";
import { plainClick } from "../lib/clicks.js";
import { useRouter } from "vue-router";
import SidePanel from "./SidePanel.vue";

const props = defineProps({
  projectId: { type: String, required: true },
  scheduleId: { type: String, required: true },
});
const emit = defineEmits(["close", "open"]);
const router = useRouter();

const schedule = ref(null);
const runs = ref([]);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [list, history] = await Promise.all([
      api("/schedules/list", { project_id: props.projectId }),
      api("/schedules/history", { project_id: props.projectId, schedule_id: props.scheduleId, limit: 5 }).catch(() => ({ duties: [] })),
    ]);
    schedule.value = (list.schedules || []).find((s) => s.schedule_id === props.scheduleId) || null;
    runs.value = history.duties || [];
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
watch(() => props.scheduleId, load, { immediate: true });

const repeat = computed(() => (schedule.value ? repeatText(schedule.value) : ""));
const settingsLink = computed(() => ({ name: "settings", params: { projectId: props.projectId }, query: { tab: "recurring" } }));
const hrefOf = (dutyId) => router.resolve({ name: "duty", params: { projectId: props.projectId, dutyId } }).href;
/** A run's duty opens over the office, like any other; with a key held, in a new tab. */
function openRun(event, dutyId) {
  if (!plainClick(event)) return;
  event.preventDefault();
  emit("open", { projectId: props.projectId, dutyId });
}
</script>

<template>
  <SidePanel label="Recurring duty" @close="emit('close')">
    <template #bar>
      <router-link :to="settingsLink">Change it in the board's settings</router-link>
    </template>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-else-if="!schedule" class="empty">That recurring duty is gone — it may have been deleted.</p>

    <div v-else class="stack">
      <div>
        <h1 style="margin: 0">{{ schedule.title }}</h1>
        <p class="row small muted" style="margin: 0.3rem 0 0">
          <span class="badge" :class="schedule.enabled ? 'badge--active' : ''">{{ schedule.enabled ? "On" : "Paused" }}</span>
          <span>{{ repeat }}{{ schedule.tz ? ` (${schedule.tz})` : "" }}</span>
          <span v-if="schedule.runs">{{ schedule.runs }} {{ schedule.runs === 1 ? "run" : "runs" }} so far</span>
        </p>
      </div>

      <div v-if="schedule.enabled && schedule.next_due_at" class="panel next">
        <span class="next__when">{{ until(schedule.next_due_at) }}</span>
        <span class="muted">{{ runText(schedule.next_due_at, schedule.tz) }}</span>
      </div>
      <p v-else-if="schedule.disabled_reason" class="notice notice--warn" style="margin: 0">{{ schedule.disabled_reason }}</p>

      <section class="panel stack" aria-labelledby="sched-brief-h">
        <h2 id="sched-brief-h" class="section-h" style="margin: 0">What each run is asked</h2>
        <div class="md" v-html="markdown(schedule.brief)"></div>
      </section>

      <section v-if="schedule.check" class="panel stack" aria-labelledby="sched-check-h">
        <h2 id="sched-check-h" class="section-h" style="margin: 0">Checked first</h2>
        <p class="small muted" style="margin: 0">
          The machine runs this before waking an agent. When it finds nothing to do, no duty is filed{{ schedule.quiet_runs ? ` — ${schedule.quiet_runs} quiet so far` : "" }}.
        </p>
        <pre class="rules">{{ schedule.check }}</pre>
      </section>

      <section class="panel stack" aria-labelledby="sched-runs-h">
        <h2 id="sched-runs-h" class="section-h" style="margin: 0">Last runs</h2>
        <p v-if="!runs.length" class="muted small" style="margin: 0">It has not run yet.</p>
        <ul v-else class="feed">
          <li v-for="r in runs" :key="r.duty_id">
            <a class="feed__item" :href="hrefOf(r.duty_id)" @click="openRun($event, r.duty_id)">
              <span class="duty__title">{{ r.title }}</span>
              <span class="duty__meta">
                <span class="badge" :class="`badge--${r.status}`">{{ statusLabel(r.status) }}</span>
                <span>{{ ago(r.created_at) }}</span>
              </span>
              <span v-if="r.outcome_summary" class="duty__ask" style="border-left-color: var(--ok)">{{ r.outcome_summary }}</span>
            </a>
          </li>
        </ul>
      </section>
    </div>
  </SidePanel>
</template>

<style scoped>
.next { display: flex; align-items: baseline; gap: 0.8rem; flex-wrap: wrap; }
.next__when { font-size: 1.3rem; font-weight: 700; }
</style>
