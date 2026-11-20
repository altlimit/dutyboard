<script setup>
// The dashboard: everything across your boards in a few numbers, what is waiting on you, what is
// being worked, which roles' work holds up best, and what the schedules file next. The boards
// themselves are on the Boards page as a table, and on the Office page as a building.
import DutyLink from "../components/DutyLink.vue";
import { computed, ref } from "vue";
import { aggregate, query } from "../lib/altengine.js";
import { ago, localWhen, until } from "../lib/duties.js";
import { TREND_DAYS, finishesByDay, finishesRequest, lastDays, machinesOnline, runsByDuty, totals } from "../lib/boards.js";
import { plain } from "../lib/markdown.js";
import { MIN_JUDGED, RECORD_DAYS, duration, percent, roleRecord, roleRecordRequest, topRoles } from "../lib/team.js";
import { useBoards } from "../lib/useBoards.js";
import TrendBars from "../components/TrendBars.vue";
import DutyDrawer from "../components/DutyDrawer.vue";
import ScheduleDrawer from "../components/ScheduleDrawer.vue";
import { plainClick } from "../lib/clicks.js";
import { useDutyPanel } from "../lib/useDutyPanel.js";

/** Questions agents have asked, across every board, longest-waiting first. */
const waiting = ref([]);
const WAITING_SHOWN = 8;
/** Duties an agent holds right now, across every board, most recently heard from first. */
const running = ref([]);
const RUNNING_SHOWN = 6;
/** Finished work per day for the fortnight, or null when it could not be counted. */
const trend = ref(null);
const UPCOMING_SHOWN = 5;
/** The roles doing the best work across your boards, by how it held up — not by how much of it. */
const ROLES_SHOWN = 5;
const roles = ref([]);

const rowsOf = (res) => (res.documents || []).map((d) => ({ ...d.data, key: String(d.key) }));

/** What only this page shows, read with the counts each time. Each part is best-effort. */
async function loadDashboard() {
  const [asks, active, done, team] = await Promise.allSettled([
    query("duties", {
      where: [{ field: "status", op: "=", value: "needs_decision" }],
      order: [{ field: "updated_at", dir: "asc" }],
      limit: WAITING_SHOWN,
    }),
    query("duties", {
      where: [{ field: "status", op: "=", value: "active" }],
      order: [{ field: "updated_at", dir: "desc" }],
      limit: RUNNING_SHOWN,
    }),
    aggregate("finishes", finishesRequest()),
    aggregate("role_events", roleRecordRequest()),
  ]);
  if (asks.status === "fulfilled") waiting.value = rowsOf(asks.value);
  if (active.status === "fulfilled") running.value = rowsOf(active.value);
  if (done.status === "fulfilled") trend.value = finishesByDay(done.value.groups);
  // A DutyBoard from before teams has no record to read, and a board without a team adds no rows:
  // either way the panel is left out.
  if (team.status === "fulfilled") roles.value = topRoles(roleRecord(team.value.groups), ROLES_SHOWN);
}

const { all, nameOf, loading, error, counts, runners, upcoming } = useBoards({ onStatus: loadDashboard });
// A duty, or what is next on a schedule, read over the dashboard in a panel (see useDutyPanel).
const { reading, readingSchedule, openDuty, openSchedule, closeDuty, closeSchedule } = useDutyPanel();
/** "Up next": a plain click reads the recurring duty over the dashboard; a modified one opens its settings. */
function scheduleClick(event, s, navigate) {
  if (!plainClick(event)) return navigate(event);
  event.preventDefault();
  openSchedule({ projectId: s.project_id, scheduleId: s.schedule_id });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const waitingTotal = computed(() =>
  counts.value ? Object.values(counts.value).reduce((n, c) => n + (c.needs_decision || 0), 0) : waiting.value.length,
);
const sum = computed(() => (counts.value ? totals(counts.value) : null));
const runs = computed(() => runsByDuty(runners.value));
const online = computed(() => machinesOnline(runners.value));
const runnersKnown = computed(() => Object.keys(runners.value).length > 0);
const limitedCount = computed(() => running.value.filter((d) => runs.value[d.key]?.state === "limited").length);
const finished7 = computed(() => (trend.value ? lastDays(trend.value, 7, "done") : 0));
const failed7 = computed(() => (trend.value ? lastDays(trend.value, 7, "failed") : 0));
const finished14 = computed(() => (trend.value ? lastDays(trend.value, TREND_DAYS, "done") : 0));

/** What the machine holding a running duty says about it, where that is more than "working". */
function runNote(d) {
  const r = runs.value[d.key];
  if (!r) return null;
  if (r.state === "limited") return { tone: "warn", text: "waiting out a usage limit" };
  if (r.state === "waiting") return { tone: "warn", text: r.detail || "waiting" };
  if (r.state === "error") return { tone: "warn", text: r.detail || "the machine reported an error" };
  if (r.state === "integrating") return { tone: "live", text: `integrating on ${r.machine}` };
  if (r.state === "parked") return { tone: "off", text: `parked on ${r.machine}` };
  return { tone: "live", text: `on ${r.machine}` };
}
</script>

<template>
  <div class="wrap stack">
    <div class="row row--between">
      <div>
        <h1>Dashboard</h1>
        <p v-if="!loading && all.length < 2" class="muted" style="margin: 0">
          A board is one stream of work. A machine running <code class="mono">dutyboard</code> works it with
          Claude Code, Codex or Cursor, or an agent connects to it with a token — either way it only ever sees the duties on it.
        </p>
      </div>
      <router-link class="btn page-action" :to="{ name: 'boards' }">All boards</router-link>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else>
      <p v-if="!all.length" class="empty">
        No boards yet. <router-link :to="{ name: 'boards', query: { new: 1 } }">Create one</router-link>, then put it on a machine.
      </p>
      <!-- The whole of your boards in four numbers, before any one board. Each says what it counts
           in words under it; nothing here is a colour alone. -->
      <ul v-if="all.length" class="tiles" aria-label="Across your boards">
        <li class="tile" :class="{ 'tile--attention': waitingTotal }">
          <span class="tile__label">Needs you</span>
          <span class="tile__value">{{ counts || waiting.length ? waitingTotal : "–" }}</span>
          <span class="tile__foot">{{ waiting.length ? `oldest waiting ${ago(waiting[0].updated_at).replace(" ago", "")}` : "nothing waiting on you" }}</span>
        </li>
        <li class="tile">
          <span class="tile__label">Running</span>
          <span class="tile__value">{{ sum ? sum.active : "–" }}</span>
          <span class="tile__foot">
            <template v-if="limitedCount">{{ limitedCount }} at a usage limit</template>
            <template v-else-if="runnersKnown">{{ online ? `${plural(online, "machine")} online` : "no machine online" }}</template>
            <template v-else>&nbsp;</template>
          </span>
        </li>
        <li class="tile">
          <span class="tile__label">Queued</span>
          <span class="tile__value">{{ sum ? sum.queued : "–" }}</span>
          <span class="tile__foot">
            <template v-if="sum && sum.blocked">{{ sum.blocked }} more blocked behind other work</template>
            <template v-else-if="sum && sum.queued">waiting for an agent</template>
            <template v-else>nothing waiting to start</template>
          </span>
        </li>
        <li class="tile tile--trend">
          <span class="tile__label">Finished, last 7 days</span>
          <span class="tile__value">{{ trend ? finished7 : "–" }}</span>
          <span class="tile__foot">
            <template v-if="!trend">not counted on this server yet</template>
            <template v-else-if="!finished14">nothing finished in two weeks</template>
            <template v-else>{{ failed7 ? `${failed7} failed` : "none failed" }}</template>
          </span>
          <TrendBars v-if="trend && finished14" :days="trend" />
        </li>
      </ul>

      <!-- What wants you, and what is happening without you. Questions first and widest: an agent
           that asked one has stopped on that duty, and it is the one thing here blocked until you
           act. Beside them, what is being worked and what the schedules file next. -->
      <div v-if="all.length" class="overview">
        <section aria-labelledby="waiting-h" class="panel overview__main">
          <div class="panel__head">
            <h2 id="waiting-h">Needs you <span v-if="waitingTotal" class="badge badge--needs_decision">{{ waitingTotal }}</span></h2>
          </div>
          <ul v-if="waiting.length" class="feed feed--asks">
            <li v-for="d in waiting" :key="d.key">
              <DutyLink class="feed__item" :project-id="d.project_id" :duty-id="d.key">
                <span class="duty__title">{{ d.title }}</span>
                <span class="duty__meta">
                  <span class="badge">{{ nameOf[d.project_id] || d.project_id }}</span>
                  <span v-if="d.assigned_agent_id" class="nowrap">asked by {{ d.assigned_agent_id }}</span>
                  <span class="nowrap">waiting since {{ ago(d.updated_at) }}</span>
                </span>
                <span v-if="d.last_question" class="duty__ask">{{ plain(d.last_question) }}</span>
              </DutyLink>
            </li>
          </ul>
          <p v-else class="feed__empty">Nothing is waiting on you. Agents' questions and suggested duties land here.</p>
          <p v-if="waitingTotal > waiting.length" class="feed__more">
            {{ waitingTotal - waiting.length }} more — the boards below say where.
          </p>
        </section>

        <div class="overview__side">
          <section aria-labelledby="running-h" class="panel">
            <div class="panel__head">
              <h2 id="running-h">Running now</h2>
            </div>
            <ul v-if="running.length" class="feed">
              <li v-for="d in running" :key="d.key">
                <DutyLink class="feed__item" :project-id="d.project_id" :duty-id="d.key">
                  <span class="duty__title">{{ d.title }}</span>
                  <span class="duty__meta">
                    <span class="badge">{{ nameOf[d.project_id] || d.project_id }}</span>
                    <span v-if="d.assigned_agent_id" class="nowrap">{{ d.assigned_agent_id }}</span>
                    <span class="nowrap">{{ d.claimed_at ? `started ${ago(d.claimed_at)}` : `updated ${ago(d.updated_at)}` }}</span>
                  </span>
                  <span v-if="runNote(d)" class="livedot feed__note" :class="`livedot--${runNote(d).tone}`">{{ runNote(d).text }}</span>
                </DutyLink>
              </li>
            </ul>
            <p v-else class="feed__empty">Nothing is being worked right now.</p>
            <p v-if="sum && sum.active > running.length" class="feed__more">{{ sum.active - running.length }} more running.</p>
          </section>

          <section v-if="roles.length" aria-labelledby="roles-h" class="panel">
            <div class="panel__head">
              <h2 id="roles-h">Top roles</h2>
              <span class="muted feed__count">last {{ RECORD_DAYS }} days</span>
            </div>
            <ol class="feed toproles">
              <li v-for="r in roles" :key="`${r.project_id}:${r.role}`">
                <router-link class="feed__item feed__item--row" :to="{ name: 'office', params: { projectId: r.project_id } }">
                  <span class="toproles__rate" :class="{ 'toproles__rate--thin': !r.ranked }" :title="r.ranked ? '' : `Fewer than ${MIN_JUDGED} duties to judge by`">{{ r.judged ? percent(r.rate) : "—" }}</span>
                  <span class="feed__what">
                    <span class="duty__title">{{ r.name }}</span>
                    <span class="duty__meta">
                      <span class="badge">{{ nameOf[r.project_id] || r.project_id }}</span>
                      <span v-if="r.judged">{{ r.good }} of {{ r.judged }} {{ r.verdict }}</span>
                      <span v-else>{{ plural(r.stints, "duty", "duties") }} handled</span>
                      <span v-if="r.sent_back" class="nowrap">sent back {{ r.sent_back }}×</span>
                      <span v-if="r.avg_ms" class="nowrap">{{ duration(r.avg_ms) }} each</span>
                    </span>
                  </span>
                </router-link>
              </li>
            </ol>
            <p class="feed__more">Ranked by how the work held up, not by how much of it there was.</p>
          </section>

          <section v-if="upcoming" aria-labelledby="next-h" class="panel">
            <div class="panel__head">
              <h2 id="next-h">Up next</h2>
              <span v-if="upcoming.total" class="muted feed__count">{{ plural(upcoming.total, "schedule") }}</span>
            </div>
            <ul v-if="upcoming.schedules.length" class="feed">
              <li v-for="s in upcoming.schedules.slice(0, UPCOMING_SHOWN)" :key="s.schedule_id">
                <router-link v-slot="{ href, navigate }" custom :to="{ name: 'settings', params: { projectId: s.project_id }, query: { tab: 'recurring' } }">
                <a class="feed__item feed__item--row" :href="href" @click="scheduleClick($event, s, navigate)">
                  <span class="feed__when">
                    <span class="feed__in">{{ until(s.next_due_at) }}</span>
                    <span class="feed__at">{{ localWhen(s.next_due_at) }}</span>
                  </span>
                  <span class="feed__what">
                    <span class="duty__title">{{ s.title }}</span>
                    <span class="duty__meta">
                      <span class="badge">{{ nameOf[s.project_id] || s.project_id }}</span>
                      <span v-if="s.checked" class="nowrap">checks first, files only if there is work</span>
                    </span>
                  </span>
                </a>
                </router-link>
              </li>
            </ul>
            <p v-else class="feed__empty">No recurring duties. A board's settings can file one every day, week or month.</p>
          </section>
        </div>
      </div>

    </template>
    <DutyDrawer v-if="reading" :key="reading.dutyId" :project-id="reading.projectId" :duty-id="reading.dutyId" @close="closeDuty" />
    <ScheduleDrawer v-else-if="readingSchedule" :key="readingSchedule.scheduleId" :project-id="readingSchedule.projectId" :schedule-id="readingSchedule.scheduleId" @close="closeSchedule" @open="openDuty" />
  </div>
</template>
