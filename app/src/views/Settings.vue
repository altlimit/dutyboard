<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, subscribeLive } from "../lib/altengine.js";
import { user as me } from "../lib/session.js";
import { config } from "../config.js";
import { ago, statusLabel } from "../lib/duties.js";
import { agentLabel, profileDraft, profilePayload, runStateLabel } from "../lib/runners.js";
import ProfileForm from "../components/ProfileForm.vue";
import { DAYS, REPEATS, allZones, browserZone, knownZone, repeatText, runText, scheduleDraft, schedulePayload, zoneOffsets } from "../lib/schedules.js";

const props = defineProps({ projectId: { type: String, required: true } });
const router = useRouter();
const route = useRoute();
/** Just made from the boards page: say what comes next, once. */
const created = computed(() => route.query.created || "");

// The project and how agents run on it. Owner edits; a member reads the same form, disabled.
const profile = ref(profileDraft());
const hasProfile = ref(false);
const profileNotice = ref("");

async function saveProfile() {
  busy.value = true;
  error.value = "";
  profileNotice.value = "";
  try {
    await api("/projects/profile", { project_id: props.projectId, ...profilePayload(profile.value) });
    hasProfile.value = true;
    profileNotice.value = "Saved. Machines working this board use it from their next duty.";
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// Recurring duties: work that comes round again rather than being remembered by nobody.
//
// The board's function cannot convert a timezone to an offset, so this page — which can — tells it
// what the zones are worth whenever it loads. A machine's daemon does the same; they agree, and a
// correction that changes nothing writes nothing.
const schedules = ref([]);
const scheduleLimit = ref(0);
const scheduleForm = ref(null); // a draft while adding or editing, null when neither
const scheduleNotice = ref("");
const myZone = browserZone();
const zoneList = allZones();
/** A zone nobody can resolve is a schedule that runs at the wrong hour and says nothing. */
const zoneKnown = computed(() => !scheduleForm.value || knownZone(scheduleForm.value.tz));
/** What one schedule has filed, once someone asks. Keyed by schedule id. */
const history = ref({});

/** A page of what a schedule filed. `more` pages on from the cursor rather than asking for
 *  everything a schedule has ever done — a daily one has hundreds behind it. */
async function showHistory(row, { more = false } = {}) {
  const had = history.value[row.schedule_id];
  if (had && !more) {
    history.value = { ...history.value, [row.schedule_id]: null };
    return;
  }
  const res = await api("/schedules/history", {
    project_id: props.projectId,
    schedule_id: row.schedule_id,
    limit: 10,
    ...(more && had ? { cursor: had.cursor } : {}),
  }).catch(() => ({ duties: [] }));
  const duties = [...(more && had ? had.duties : []), ...(res.duties || [])];
  history.value = { ...history.value, [row.schedule_id]: { duties, cursor: res.next_cursor || null } };
}

async function loadSchedules() {
  const res = await api("/schedules/list", { project_id: props.projectId });
  schedules.value = res.schedules || [];
  scheduleLimit.value = res.limit || 0;
  // Only the owner's call is accepted, and only a zone this browser knows is worth sending.
  if (isOwner.value && schedules.value.length) {
    const told = await api("/schedules/sync", { project_id: props.projectId, offsets: zoneOffsets(schedules.value) }).catch(() => null);
    if (told && told.updated) {
      const res2 = await api("/schedules/list", { project_id: props.projectId }).catch(() => null);
      if (res2) schedules.value = res2.schedules || [];
    }
  }
}

function newSchedule() {
  scheduleForm.value = scheduleDraft();
  scheduleNotice.value = "";
}

function editSchedule(row) {
  scheduleForm.value = scheduleDraft(row);
  scheduleNotice.value = "";
}

async function saveSchedule() {
  const draft = scheduleForm.value;
  busy.value = true;
  error.value = "";
  scheduleNotice.value = "";
  try {
    const payload = schedulePayload(draft);
    if (draft.schedule_id) {
      await api("/schedules/update", { project_id: props.projectId, schedule_id: draft.schedule_id, ...payload });
    } else {
      await api("/schedules/create", { project_id: props.projectId, ...payload });
    }
    scheduleForm.value = null;
    await loadSchedules();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function toggleSchedule(row) {
  busy.value = true;
  error.value = "";
  try {
    await api("/schedules/update", { project_id: props.projectId, schedule_id: row.schedule_id, enabled: !row.enabled });
    await loadSchedules();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

/** File this one's duty now, by moving its next run to this moment. The next tick picks it up —
 *  within a minute, or on the next poll of a machine working the board. */
async function runScheduleNow(row) {
  busy.value = true;
  error.value = "";
  scheduleNotice.value = "";
  try {
    await api("/schedules/update", { project_id: props.projectId, schedule_id: row.schedule_id, next_due_at: Date.now() });
    scheduleNotice.value = `"${row.title}" is due now — its duty appears on the board within a minute.`;
    await loadSchedules();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function deleteSchedule(row) {
  if (!confirm(`Stop "${row.title}" repeating? Duties it has already filed stay on the board.`)) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/schedules/delete", { project_id: props.projectId, schedule_id: row.schedule_id });
    await loadSchedules();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// The board's rules: what is in force, and what a rules duty has proposed.
const rules = ref({ version: 0, body: "", draft: null });
const rulesEdit = ref("");
const editingRules = ref(false);

async function loadRules() {
  rules.value = await api("/board/rules", { project_id: props.projectId });
  rulesEdit.value = rules.value.body;
}

async function acceptRules() {
  busy.value = true;
  error.value = "";
  try {
    await api("/board/rules/accept", { project_id: props.projectId });
    await loadRules();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function saveRules() {
  busy.value = true;
  error.value = "";
  try {
    await api("/board/rules/set", { project_id: props.projectId, body: rulesEdit.value });
    editingRules.value = false;
    await loadRules();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// Machines working this board, whoever's they are.
const runners = ref([]);

const retried = ref({});
async function retryRunner(r) {
  busy.value = true;
  error.value = "";
  try {
    const res = await api("/machines/retry", { machine_id: r.machine_id, project_id: props.projectId });
    retried.value = { ...retried.value, [r.machine_id]: res.online === false ? "It is offline — it checks again when it is back." : "Asked it to check again…" };
    // Its answer arrives as a new report; give it a moment, then read the runners again.
    setTimeout(async () => {
      runners.value = (await api("/board/runners", { project_id: props.projectId }).catch(() => ({ runners: runners.value }))).runners;
      retried.value = { ...retried.value, [r.machine_id]: "" };
    }, 8000);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function unlinkRunner(r) {
  if (!confirm(`Take ${r.machine_name} off this board? Duties it holds stay held until someone moves them.`)) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/machines/unlink", { machine_id: r.machine_id, project_id: props.projectId });
    runners.value = (await api("/board/runners", { project_id: props.projectId })).runners;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function setAgents(m, allowed) {
  busy.value = true;
  error.value = "";
  memberNotice.value = "";
  try {
    const res = await api("/board/members/agents", { project_id: props.projectId, uid: m.uid, can_run_agents: allowed });
    const who = m.name || m.identifier;
    memberNotice.value = allowed
      ? `${who} can now link their own machines to this board.`
      : `${who} can no longer run agents here${res.unlinked ? `; ${res.unlinked} of their machines were unlinked` : ""}.`;
    await loadMembers();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const linkCommand = computed(() => `alt install altlimit/dutyboard\ndutyboard --server ${config.api} --root /path/for/projects --service`);

// Your paired machines, for putting this board on one of them without leaving the page.
const myMachines = ref([]);
async function loadMachines() {
  myMachines.value = (await api("/machines/list").catch(() => ({ machines: [] }))).machines || [];
}
const freeMachines = computed(() => myMachines.value.filter((m) => !runners.value.some((r) => r.machine_id === m.machine_id)));

async function workOn(m) {
  busy.value = true;
  error.value = "";
  profileNotice.value = "";
  try {
    await api("/machine/request", { machine_id: m.machine_id, project_id: props.projectId });
    profileNotice.value = `Asked ${m.name} to work this board. If it is online it clones the repository and starts within a minute.`;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const tokens = ref([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const name = ref("");
const agentId = ref("");
/** Shown once, right after minting — the value is not stored anywhere it can be read back. */
const fresh = ref(null);
const copied = ref(false);
const confirmDelete = ref("");

// Who this caller is on the board, from the same `/board/open` the board makes. Until it is
// known nothing owner-only is drawn: a member briefly shown a token form they cannot use is a
// page that looks broken for a second and then changes its mind.
const role = ref(null); // "owner" | "member"
const isOwner = computed(() => role.value === "owner");
const ownerName = ref("");

const members = ref([]);
const maxMembers = ref(0);
const memberEmail = ref("");
const memberNotice = ref("");

async function loadMembers() {
  const res = await api("/board/members/list", { project_id: props.projectId });
  members.value = res.members || [];
  maxMembers.value = res.max_members || 0;
}

async function addMember() {
  busy.value = true;
  error.value = "";
  memberNotice.value = "";
  try {
    const res = await api("/board/members/add", { project_id: props.projectId, email: memberEmail.value });
    const who = res.member.name || res.member.identifier;
    memberNotice.value = res.already
      ? `${who} is already on this board.`
      : `Added ${who}. They see this board the next time they open DutyBoard.`;
    memberEmail.value = "";
    await loadMembers();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function removeMember(m) {
  const who = m.name || m.identifier;
  if (!confirm(`Remove ${who} from this board? They can no longer change anything on it.`)) return;
  busy.value = true;
  error.value = "";
  memberNotice.value = "";
  try {
    await api("/board/members/remove", { project_id: props.projectId, uid: m.uid });
    memberNotice.value = `Removed ${who}.`;
    await loadMembers();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

/**
 * Indexing finished work, from the one page where you would look for it.
 *
 * The board offers this too, but only when a search comes back empty — and that is the
 * wrong shape for the case it exists for. A board whose recent duties are indexed and whose
 * older history is not returns SOME results, so the offer never appears, and the history
 * you are missing stays missing with nothing to suggest otherwise. This is where a board's
 * maintenance lives, so it belongs here as well.
 */
const searchable = ref(false);
const reindexing = ref(false);
const reindexed = ref(null);

async function reindex() {
  reindexing.value = true;
  error.value = "";
  reindexed.value = null;
  try {
    let total = 0;
    let cursor;
    do {
      const res = await api("/board/reindex", { project_id: props.projectId, cursor });
      total += res.indexed;
      cursor = res.more ? res.cursor : null;
    } while (cursor);
    reindexed.value = total;
  } catch (err) {
    error.value = err.message;
  } finally {
    reindexing.value = false;
  }
}

const mcpUrl = computed(() => `${config.api}/mcp${agentIdOf(fresh.value) ? `?agent=${agentIdOf(fresh.value)}` : ""}`);
const agentIdOf = (t) => (t && t.default_agent_id) || "";

/**
 * The MCP server's name, which is the board's.
 *
 * It used to be `dutyboard` for every board, so the second board's command in the same repo
 * was refused as a duplicate, and two boards in one session could not both be connected. With
 * the board in the name each one is its own server, and its tools arrive as
 * `mcp__dutyboard-<board>__duty_poll` — which is also how an agent holding two of them tells
 * them apart. Board ids are already [a-z0-9-], which is what a server name allows.
 */
const serverName = computed(() => `dutyboard-${props.projectId}`);

const mcpCommand = computed(
  () =>
    `claude mcp add --transport http ${serverName.value} "${mcpUrl.value}" \\\n  --header "Authorization: Bearer ${fresh.value ? fresh.value.token : "<your token>"}"`,
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // Who you are here, and whether this deployment has search — the same call the board
    // itself makes, so a warm path rather than an endpoint invented for two facts.
    const board = await api("/board/open", { project_id: props.projectId });
    role.value = board.role || "owner";
    ownerName.value = (board.project && board.project.owner_name) || "";
    searchable.value = board.search === true;
    hasProfile.value = !!(board.project && (board.project.profile || board.project.runner));
    profile.value = profileDraft(board.project && board.project.profile, board.project && board.project.runner);
    runners.value = board.runners || [];
    await Promise.all([
      loadMembers(),
      loadRules(),
      loadMachines(),
      loadSchedules(),
      // Tokens are the owner's. A member is refused them, so they are not asked for.
      isOwner.value ? api("/tokens/list", { project_id: props.projectId }).then((l) => (tokens.value = l.tokens)) : null,
    ]);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function mint() {
  busy.value = true;
  error.value = "";
  copied.value = false;
  try {
    fresh.value = await api("/tokens/mint", {
      project_id: props.projectId,
      name: name.value,
      default_agent_id: agentId.value || undefined,
    });
    name.value = "";
    agentId.value = "";
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function revoke(t) {
  if (!confirm(`Revoke "${t.name}"? Any agent using it stops working immediately.`)) return;
  busy.value = true;
  try {
    await api("/tokens/revoke", { project_id: props.projectId, token_id: t.token_id });
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
  } catch {
    copied.value = false; // clipboard blocked — the value is selectable on screen anyway
  }
}

async function deleteBoard() {
  busy.value = true;
  error.value = "";
  try {
    await api("/projects/delete", { project_id: props.projectId, confirm: confirmDelete.value });
    router.push({ name: "boards" });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// The machines on this board change what they report as they work, so the list follows the board's
// channel rather than showing what was true when the page opened.
let socket = null;
let runnersTimer = null;
onMounted(() => {
  load();
  socket = subscribeLive({ projectId: props.projectId }, (frame) => {
    if (!frame || !frame.data || frame.data.t !== "runner" || runnersTimer) return;
    runnersTimer = setTimeout(async () => {
      runnersTimer = null;
      runners.value = (await api("/board/runners", { project_id: props.projectId }).catch(() => ({ runners: runners.value }))).runners;
    }, 800);
  });
});
onUnmounted(() => {
  if (socket) socket.close();
  if (runnersTimer) clearTimeout(runnersTimer);
});
</script>

<template>
  <div class="wrap wrap--narrow stack">
    <p><router-link :to="{ name: 'board', params: { projectId } }">← Back to the board</router-link></p>

    <div>
      <h1>Board settings</h1>
      <p v-if="role === 'member'" class="muted">
        You are a member of this board{{ ownerName ? `, which ${ownerName} owns` : "" }}. Members do
        the work on a board — adding duties, answering questions, sending work back. The owner
        decides who is on it, mints agent tokens, and can delete it.
      </p>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <section v-if="created === 'runner' || (role && !runners.length && hasProfile)" aria-labelledby="next-h" class="notice stack">
      <h2 id="next-h" style="margin: 0">Put this board on a machine</h2>
      <p v-if="!profile.repo_url" class="notice notice--warn" style="margin: 0">
        Give the board its repository URL below first — a machine works a board from its own clone of it.
      </p>
      <div v-if="freeMachines.length" class="row">
        <button v-for="m in freeMachines" :key="m.machine_id" type="button" :disabled="busy || !profile.repo_url" @click="workOn(m)">
          Work it on {{ m.name }}
        </button>
      </div>
      <p style="margin: 0">
        {{ freeMachines.length ? "Or add another computer" : "On the computer that should do the work" }} — with
        {{ agentLabel(profile.agent) }} installed and signed in:
      </p>
      <pre class="token" style="white-space: pre-wrap">{{ linkCommand }}</pre>
      <div class="row">
        <button type="button" @click="copy(linkCommand)">Copy</button>
      </div>
      <p class="small muted" style="margin: 0">
        It pairs the machine; then choose it here. Its first duties get the machine ready for the project and draft
        this board's rules for you to accept.
      </p>
    </section>

    <section v-if="role && runners.length" aria-labelledby="runners-h" class="panel stack">
      <h2 id="runners-h" style="margin: 0">Machines working this board</h2>
      <ul class="members">
        <li v-for="r in runners" :key="r.machine_id">
          <span>
            <strong>{{ r.machine_name }}</strong>
            <span class="livedot" :class="r.online ? 'livedot--live' : 'livedot--off'" style="margin-left: 0.45rem">
              {{ r.online === null ? "presence unknown" : r.online ? "online" : "offline" }}
            </span>
            <span v-if="me && r.owner_uid === me.uid" class="badge members__you">yours</span>
            <span v-if="r.cli_version" class="muted small members__id">dutyboard {{ r.cli_version }}</span>
          </span>
          <span class="small muted">
            <template v-if="!r.runs.length">idle</template>
            <template v-else>
              <span v-for="(x, i) in r.runs" :key="x.duty_id">
                <template v-if="i">, </template>
                <router-link :to="{ name: 'duty', params: { projectId, dutyId: x.duty_id } }">{{ x.detail || runStateLabel(x.state) }}</router-link>
              </span>
            </template>
          </span>
          <span v-if="r.problem" class="notice notice--warn small" style="flex-basis: 100%; margin: 0">{{ r.problem }}</span>
          <button v-if="r.problem && (isOwner || (me && r.owner_uid === me.uid))" type="button" class="link small" :disabled="busy" @click="retryRunner(r)">
            Retry now<span class="sr-only"> on {{ r.machine_name }}</span>
          </button>
          <span v-if="retried[r.machine_id]" class="small muted" role="status">{{ retried[r.machine_id] }}</span>
          <button v-if="isOwner || (me && r.owner_uid === me.uid)" type="button" class="link small" :disabled="busy" @click="unlinkRunner(r)">
            Unlink<span class="sr-only"> {{ r.machine_name }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section v-if="role" aria-labelledby="rules-h" class="panel stack">
      <h2 id="rules-h" style="margin: 0">Rules</h2>
      <p class="muted small" style="margin: 0">
        Given to every agent session on this board. A rules duty drafts them from the project itself; nothing
        it writes is in force until {{ isOwner ? "you accept it" : "the owner accepts it" }}.
      </p>

      <div v-if="rules.draft" class="notice notice--warn stack">
        <h3 style="margin: 0">Proposed rules <span class="muted small">— by {{ rules.draft.agent_id || "an agent" }}, {{ ago(rules.draft.created_at) }}</span></h3>
        <pre class="rules">{{ rules.draft.body }}</pre>
        <div v-if="isOwner" class="row">
          <button class="primary" type="button" :disabled="busy" @click="acceptRules">Accept these rules</button>
          <button type="button" :disabled="busy" @click="rulesEdit = rules.draft.body; editingRules = true">Edit before accepting</button>
        </div>
      </div>

      <template v-if="!editingRules">
        <pre v-if="rules.body" class="rules">{{ rules.body }}</pre>
        <p v-else class="muted small" style="margin: 0">No rules in force yet.</p>
        <div v-if="isOwner"><button type="button" @click="rulesEdit = rules.body; editingRules = true">Edit rules</button></div>
        <p v-if="rules.version" class="hint" style="margin: 0">Version {{ rules.version }}, {{ ago(rules.updated_at) }}.</p>
      </template>
      <form v-else class="stack" @submit.prevent="saveRules">
        <div class="field">
          <label for="rules-edit">Rules, in markdown</label>
          <textarea id="rules-edit" v-model="rulesEdit" rows="16" maxlength="32000" class="mono" />
        </div>
        <div class="row">
          <button class="primary" type="submit" :disabled="busy || !rulesEdit.trim()">Save rules</button>
          <button type="button" @click="editingRules = false">Cancel</button>
        </div>
      </form>
    </section>

    <form v-if="role" aria-labelledby="profile-h" class="panel stack" @submit.prevent="saveProfile">
      <h2 id="profile-h" style="margin: 0">The project</h2>
      <p class="muted small" style="margin: 0">
        What the project is and how its work lands.
        <template v-if="!isOwner">Only the owner can change it: some of these are commands a machine runs.</template>
      </p>
      <p v-if="profileNotice" class="notice" role="status" style="margin: 0">{{ profileNotice }}</p>
      <ProfileForm v-model="profile" id-prefix="set" :disabled="!isOwner || busy" />
      <div v-if="isOwner"><button class="primary" type="submit" :disabled="busy">Save</button></div>
    </form>


    <section v-if="role" aria-labelledby="repeat-h" class="panel stack">
      <h2 id="repeat-h" style="margin: 0">Recurring duties</h2>
      <p class="muted small" style="margin: 0">
        Work that is never finished, only due again — a post every Monday, a check of something that
        drifts every month. Each one files a fresh duty when it comes round, carrying how the last
        one went. A run that comes round while its last duty is still open is skipped, so a stuck
        duty cannot become a pile.
      </p>

      <p v-if="scheduleNotice" class="notice" role="status" style="margin: 0">{{ scheduleNotice }}</p>

      <ul v-if="schedules.length" class="schedules">
        <li v-for="s in schedules" :key="s.schedule_id" class="stack" style="gap: 0.35rem">
          <div class="row" style="justify-content: space-between; align-items: baseline">
            <strong>{{ s.title }}</strong>
            <span v-if="!s.enabled" class="badge">paused</span>
          </div>
          <span class="muted small">
            {{ repeatText(s) }}<template v-if="s.tz && s.tz !== 'UTC'">, {{ s.tz }}</template>
            <template v-if="s.enabled && s.next_due_at"> — next {{ runText(s.next_due_at, s.tz) }}</template>
            <template v-if="s.origin === 'agent'"> · set up by {{ s.created_by_name || "an agent" }}</template>
          </span>
          <span v-if="s.runs || s.skipped" class="hint" style="margin: 0">
            Filed {{ s.runs }}<template v-if="s.runs === 1"> duty</template><template v-else> duties</template>
            <template v-if="s.last_fired_at">, last {{ ago(s.last_fired_at) }}</template>
            <template v-if="s.skipped">; {{ s.skipped }} run<template v-if="s.skipped !== 1">s</template> skipped while the one before was still open</template>.
          </span>
          <p v-if="s.tz && s.tz !== 'UTC' && !s.offset_checked_at" class="hint" style="margin: 0">
            No machine or browser has confirmed what {{ s.tz }} is worth yet, so this is running on UTC
            until one does.
          </p>
          <p v-if="s.disabled_reason" class="hint" style="margin: 0; color: var(--danger)">
            The board stopped this one: {{ s.disabled_reason }} Fix the repeat and start it again.
          </p>
          <p v-else-if="s.skips_in_a_row >= 2" class="hint" style="margin: 0">
            {{ s.skips_in_a_row }} runs in a row skipped — the duty it filed last is still open.
            Finish it, delete it, or pause this schedule.
          </p>
          <ul v-if="history[s.schedule_id] && history[s.schedule_id].duties.length" class="members">
            <li v-for="d in history[s.schedule_id].duties" :key="d.duty_id">
              <span>
                <router-link :to="{ name: 'duty', params: { projectId, dutyId: d.duty_id } }">{{ d.title }}</router-link>
                <span class="muted small members__id">{{ statusLabel(d.status) }}, {{ ago(d.created_at) }}</span>
              </span>
            </li>
          </ul>
          <p v-else-if="history[s.schedule_id]" class="hint" style="margin: 0">It has not filed anything yet.</p>
          <div class="row">
            <button v-if="s.runs" type="button" class="link small" :disabled="busy" @click="showHistory(s)">
              {{ history[s.schedule_id] ? "Hide what it filed" : "What it filed" }}
            </button>
            <button
              v-if="history[s.schedule_id] && history[s.schedule_id].cursor"
              type="button"
              class="link small"
              :disabled="busy"
              @click="showHistory(s, { more: true })"
            >
              Older
            </button>
          </div>
          <div v-if="isOwner" class="row">
            <button type="button" class="link small" :disabled="busy" @click="editSchedule(s)">Edit</button>
            <button type="button" class="link small" :disabled="busy" @click="toggleSchedule(s)">{{ s.enabled ? "Pause" : "Start again" }}</button>
            <button v-if="s.enabled" type="button" class="link small" :disabled="busy" @click="runScheduleNow(s)">File one now</button>
            <button type="button" class="link small" :disabled="busy" @click="deleteSchedule(s)">Stop<span class="sr-only"> {{ s.title }}</span></button>
          </div>
        </li>
      </ul>
      <p v-else class="muted small" style="margin: 0">Nothing repeats on this board yet.</p>

      <form v-if="scheduleForm" class="stack" @submit.prevent="saveSchedule">
        <div class="field">
          <label for="sch-title">Title</label>
          <input id="sch-title" v-model="scheduleForm.title" required maxlength="200" placeholder="This week's post" />
        </div>
        <div class="field">
          <label for="sch-brief">What needs doing, every time</label>
          <textarea id="sch-brief" v-model="scheduleForm.brief" required rows="4" maxlength="4000" placeholder="Written for an agent with no other context — what to write, where it goes, what done looks like." />
        </div>
        <div class="field">
          <label for="sch-repeat">Repeat</label>
          <select id="sch-repeat" v-model="scheduleForm.repeat">
            <option v-for="r in REPEATS" :key="r.key" :value="r.key">{{ r.label }} — {{ r.hint }}</option>
          </select>
        </div>
        <div v-if="scheduleForm.repeat === 'weekly'" class="field">
          <label for="sch-day">On</label>
          <select id="sch-day" v-model.number="scheduleForm.day">
            <option v-for="d in DAYS" :key="d.value" :value="d.value">{{ d.label }}</option>
          </select>
        </div>
        <div v-if="scheduleForm.repeat === 'monthly'" class="field">
          <label for="sch-date">On the</label>
          <input id="sch-date" v-model.number="scheduleForm.date" type="number" min="1" max="28" />
          <p class="hint" style="margin: 0">1 to 28, so it comes round in every month.</p>
        </div>
        <div v-if="scheduleForm.repeat !== 'custom'" class="field">
          <label for="sch-time">At</label>
          <input id="sch-time" v-model="scheduleForm.time" type="time" required />
        </div>
        <div v-else class="field">
          <label for="sch-cron">Cron expression</label>
          <input id="sch-cron" v-model="scheduleForm.cron" class="mono" required maxlength="120" placeholder="0 9 * * 1" />
          <p class="hint" style="margin: 0">
            Minute, hour, day of the month, month, day of the week — read in the timezone below, not in UTC.
            Two runs must be at least 15 minutes apart.
          </p>
        </div>
        <div class="field">
          <label for="sch-tz">Timezone</label>
          <input id="sch-tz" v-model="scheduleForm.tz" maxlength="64" :placeholder="myZone" list="sch-zones" :aria-invalid="!zoneKnown" />
          <datalist id="sch-zones"><option v-for="z in zoneList" :key="z" :value="z" /></datalist>
          <p v-if="!zoneKnown" class="hint" role="alert" style="margin: 0; color: var(--danger)">
            This browser does not know a zone called “{{ scheduleForm.tz }}”. Pick one from the list — a name
            nothing can resolve leaves the schedule running on UTC without saying so.
          </p>
          <p v-else class="hint" style="margin: 0">
            This browser's is <strong>{{ myZone }}</strong>. The hour you ask for is kept through a clock
            change: this page and every machine working the board tell it what the zone is worth.
          </p>
        </div>
        <div class="field">
          <label for="sch-priority">Each duty arrives as</label>
          <select id="sch-priority" v-model="scheduleForm.priority">
            <option value="next">Next — real work, in the queue</option>
            <option value="backlog">Backlog — worth doing eventually</option>
            <option value="immediate_blocker">Immediate blocker — ahead of everything</option>
          </select>
        </div>
        <div class="row">
          <button class="primary" type="submit" :disabled="busy || !zoneKnown || !scheduleForm.title.trim() || !scheduleForm.brief.trim()">
            {{ scheduleForm.schedule_id ? "Save" : "Make it recur" }}
          </button>
          <button type="button" :disabled="busy" @click="scheduleForm = null">Cancel</button>
        </div>
      </form>
      <div v-else-if="isOwner">
        <button type="button" :disabled="busy || schedules.length >= scheduleLimit" @click="newSchedule">Add a recurring duty</button>
        <p v-if="scheduleLimit && schedules.length >= scheduleLimit" class="hint" style="margin: 0.4rem 0 0">
          A board holds {{ scheduleLimit }}. Stop one you no longer want first.
        </p>
      </div>
    </section>

    <section v-if="role" aria-labelledby="members-h" class="panel stack">
      <h2 id="members-h" style="margin: 0">Members</h2>
      <p class="muted small" style="margin: 0">
        People who work on this board besides {{ isOwner ? "you" : ownerName || "its owner" }}. They
        see every duty on it and can do anything but manage tokens, members, or delete the board.
      </p>

      <p v-if="memberNotice" class="notice" role="status" style="margin: 0">{{ memberNotice }}</p>

      <ul v-if="members.length" class="members">
        <li v-for="m in members" :key="m.uid">
          <span>
            <strong>{{ m.name || m.identifier }}</strong>
            <span v-if="me && m.uid === me.uid" class="badge members__you">you</span>
            <span v-if="m.name" class="muted small members__id">{{ m.identifier }}</span>
          </span>
          <span class="muted small nowrap">added {{ ago(m.added_at) }}</span>
          <label v-if="isOwner" class="small nowrap" style="display: inline-flex; gap: 0.35rem; font-weight: 450; margin: 0">
            <input type="checkbox" style="width: auto; min-height: 0" :checked="m.can_run_agents" :disabled="busy" @change="setAgents(m, $event.target.checked)" />
            can run agents
          </label>
          <span v-else-if="m.can_run_agents" class="badge">runs agents</span>
          <button v-if="isOwner" type="button" class="link small" :disabled="busy" @click="removeMember(m)">
            Remove<span class="sr-only"> {{ m.name || m.identifier }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="muted small" style="margin: 0">Nobody else yet.</p>

      <form v-if="isOwner" class="stack" @submit.prevent="addMember">
        <div class="field" style="margin: 0">
          <label for="m-email">Add someone by email</label>
          <input id="m-email" v-model="memberEmail" type="email" required autocomplete="off" placeholder="name@example.com" />
          <p class="hint">
            They need a DutyBoard account already — this adds a person to a board, it does not
            invite them to sign up.
            <template v-if="maxMembers"> Up to {{ maxMembers }} members.</template>
          </p>
        </div>
        <div>
          <button type="submit" :disabled="busy || !memberEmail.trim()">Add member</button>
        </div>
      </form>
    </section>

    <details v-if="isOwner" :open="created === 'token' || !!fresh || undefined">
    <summary>Connect an agent by hand, with a token</summary>
    <div class="stack" style="margin-top: 0.75rem">
    <div v-if="isOwner">
      <h2>Agents &amp; tokens</h2>
      <p class="muted">
        An agent connects with a project token. The token names this board and nothing else,
        so an agent holding it can never reach another one.
      </p>
    </div>

    <div v-if="isOwner && fresh" class="notice stack" role="status">
      <h2 style="margin: 0">Copy this now</h2>
      <p style="margin: 0">This is the only time the token is shown. Only its hash is stored.</p>
      <p class="token">{{ fresh.token }}</p>
      <div class="row">
        <button type="button" @click="copy(fresh.token)">Copy token</button>
        <span v-if="copied" class="small muted" role="status">Copied.</span>
      </div>

      <h3 style="margin: 0.5rem 0 0">Point an agent at this board</h3>
      <p class="small muted" style="margin: 0">
        As an MCP server, so the agent gets duty_poll, duty_claim, duty_checkpoint and the
        rest as tools:
      </p>
      <pre class="token" style="white-space: pre-wrap">{{ mcpCommand }}</pre>
      <div class="row">
        <button type="button" @click="copy(mcpCommand)">Copy command</button>
      </div>
      <p class="small muted" style="margin: 0">
        Run it inside the repo this board is for: Claude Code keeps the server for that
        directory only, so an agent there sees this board and no other. To disconnect, or to
        replace a token you have revoked, <code class="mono">claude mcp remove {{ serverName }}</code>.
      </p>
      <p class="small muted" style="margin: 0">
        Or over plain HTTP: <code class="mono">POST {{ config.api }}/duty/poll</code> with the same
        Authorization header.
      </p>
      <div><button type="button" @click="fresh = null">Done</button></div>
    </div>

    <form v-if="isOwner" class="panel stack" @submit.prevent="mint">
      <h2>New token</h2>
      <div class="field">
        <label for="t-name">What is it for</label>
        <input id="t-name" v-model="name" required maxlength="80" placeholder="laptop, CI runner, agent alpha" />
      </div>
      <div class="field">
        <label for="t-agent">Default agent id <span class="muted">(optional)</span></label>
        <input id="t-agent" v-model="agentId" maxlength="64" placeholder="alpha" />
        <p class="hint">
          Identifies the worker holding a duty. Setting it here means the agent does not have to
          repeat it on every call — useful when a model is producing the arguments.
        </p>
      </div>
      <div><button class="primary" type="submit" :disabled="busy || !name">Mint token</button></div>
    </form>

    <section v-if="isOwner" aria-labelledby="tokens-h" class="stack">
      <h2 id="tokens-h">Tokens on this board</h2>
      <p v-if="loading" class="muted" role="status">Loading…</p>
      <p v-else-if="!tokens.length" class="empty">No tokens yet.</p>
      <div v-else class="tablewrap">
        <table>
          <caption class="sr-only">Agent tokens for this board</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Token</th>
              <th scope="col">Agent</th>
              <th scope="col">Last used</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in tokens" :key="t.token_id">
              <td>
                {{ t.name }}
                <span v-if="t.revoked" class="badge badge--failed">revoked</span>
              </td>
              <td class="mono">{{ t.hint }}</td>
              <td>{{ t.default_agent_id || "—" }}</td>
              <td class="nowrap">{{ t.last_used_at ? ago(t.last_used_at) : "never" }}</td>
              <td>
                <button v-if="!t.revoked" type="button" class="danger" :disabled="busy" @click="revoke(t)">
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    </div>
    </details>

    <section v-if="searchable" aria-labelledby="reindex-h" class="panel stack">
      <h2 id="reindex-h" style="margin: 0">Searching finished work</h2>
      <p class="muted small" style="margin: 0">
        Duties are indexed as they finish, so anything completed from now on is findable from
        the board's search box and by an agent calling <code class="mono">duty_search</code>.
        Work that finished <em>before</em> search was switched on is not in the index — index
        it once and it stays that way.
      </p>
      <div class="row">
        <button type="button" :disabled="reindexing" @click="reindex">
          {{ reindexing ? "Indexing…" : "Index finished duties" }}
        </button>
        <span v-if="reindexed !== null" class="small muted">
          Indexed {{ reindexed }} finished {{ reindexed === 1 ? "duty" : "duties" }}.
        </span>
      </div>
      <p class="hint" style="margin: 0">
        Safe to run more than once — a duty already in the index is replaced, not duplicated.
      </p>
    </section>

    <section v-if="isOwner" aria-labelledby="danger-h" class="panel stack" style="border-color: var(--danger)">
      <h2 id="danger-h" style="margin: 0">Delete this board</h2>
      <p class="muted small" style="margin: 0">
        Removes the board with every duty, thread, agent and token on it. There is no undo.
      </p>
      <form class="stack" @submit.prevent="deleteBoard">
        <div class="field">
          <label for="confirm">Type <span class="mono">{{ projectId }}</span> to confirm</label>
          <input id="confirm" v-model="confirmDelete" autocomplete="off" />
        </div>
        <div>
          <button class="danger" type="submit" :disabled="busy || confirmDelete !== projectId">
            Delete board
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
