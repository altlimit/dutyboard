<script setup>
// A board's team and what it has written down.
//
// The team is the roles a duty passes between: who reads it first, who builds, who verifies. A
// person never assigns a duty to a role — they choose the team, and the role that reads new duties
// first routes each one. An agent can draft a team for the board; like the rules, what it drafts is
// not in force until the owner accepts it.
//
// The memory is the agents' own notebook for the project. The owner can read, correct or clear it,
// and put back one of its earlier versions when an agent's rewrite lost something.
//
// What the reviewers keep sending back is kept too: every so often — or when the owner asks — a retro
// duty reads it and proposes changes to the charters and the rules, as drafts to accept here.
import { computed, ref, watch } from "vue";
import { api } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";
import { markdown } from "../lib/markdown.js";
import { LEVELS, levelLabel, roleTraits } from "../lib/team.js";
import DutyLink from "./DutyLink.vue";
import SidePanel from "./SidePanel.vue";

const props = defineProps({
  projectId: { type: String, required: true },
  isOwner: { type: Boolean, default: false },
  // Bumped by the page when the board says its team or memory changed.
  tick: { type: Number, default: 0 },
});
const emit = defineEmits(["draft"]);

const MAX_CHARTER = 6000;

const roster = ref(null);
const memory = ref(null);
const error = ref("");
const notice = ref("");
const busy = ref(false);
const unsupported = ref(false);

const chosenPreset = ref("");
const draftNote = ref("");
const askingDraft = ref(false);
const draftDutyId = ref("");
const editing = ref(null); // a copy of the role being edited, with `at` its index
const settings = ref({ plan_approval: false, max_bounces: 3, max_handoffs: 12, independent_review: true, sensitive_paths: [] });
const sensitiveText = ref(""); // the sensitive paths as typed, one per line
const memoryEdit = ref(null); // the text being edited, or null
const history = ref(null); // the memory's earlier versions, once asked for
const retroDutyId = ref("");

const roles = computed(() => (roster.value && roster.value.roles) || []);
const inForce = computed(() => !!(roster.value && roster.value.in_force));
const presets = computed(() => {
  const all = (roster.value && roster.value.presets) || [];
  const suggested = roster.value && roster.value.suggested_preset;
  return [...all].sort((a, b) => Number(b.id === suggested) - Number(a.id === suggested));
});
const typedPaths = computed(() => sensitiveText.value.split("\n").map((l) => l.trim()).filter(Boolean));
const wanted = computed(() => ({
  plan_approval: settings.value.plan_approval,
  max_bounces: Number(settings.value.max_bounces),
  max_handoffs: Number(settings.value.max_handoffs),
  independent_review: settings.value.independent_review,
  sensitive_paths: typedPaths.value,
}));
const settingsChanged = computed(() => {
  if (!roster.value) return false;
  const have = roster.value.settings;
  return Object.entries(wanted.value).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(have[k] ?? (k === "sensitive_paths" ? [] : null)));
});
const sentBacks = computed(() => [...((roster.value && roster.value.sent_backs) || [])].reverse());
const memoryBy = computed(() => {
  const by = memory.value && memory.value.updated_by;
  if (!by) return "";
  return by.agent_id ? `${by.agent_id}${by.role ? ` as ${by.role}` : ""}` : by.name || "the owner";
});

async function load() {
  error.value = "";
  try {
    const [r, m] = await Promise.all([api("/board/roster", { project_id: props.projectId }), api("/board/memory", { project_id: props.projectId })]);
    roster.value = r;
    memory.value = m;
    settings.value = { ...r.settings };
    sensitiveText.value = (r.settings.sensitive_paths || []).join("\n");
    if (history.value) loadHistory();
    if (!chosenPreset.value) chosenPreset.value = r.suggested_preset || (r.presets[0] && r.presets[0].id) || "";
    emit("draft", !!r.draft);
  } catch (err) {
    // A DutyBoard from before teams existed has no such route: say so once rather than an error.
    if (err.status === 404) unsupported.value = true;
    else error.value = err.message;
  }
}
watch(() => [props.projectId, props.tick], load, { immediate: true });

async function act(fn, message) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    notice.value = message || "";
    await load();
    return true;
  } catch (err) {
    error.value = err.message;
    return false;
  } finally {
    busy.value = false;
  }
}

const set = (body, message) => act(() => api("/board/roster/set", { project_id: props.projectId, ...body }), message);

function usePreset() {
  const preset = presets.value.find((p) => p.id === chosenPreset.value);
  if (!preset) return;
  if (inForce.value && !confirm(`Replace this board's team with the ${preset.name}? Duties in flight go back to whoever reads new duties first.`)) return;
  set({ preset: preset.id }, `${preset.name} is in force. New duties go to its ${preset.roles[0]} first.`);
}

function turnOff() {
  if (!confirm("Turn the team off? Each duty is then worked start to finish by one agent, with nobody reviewing it before it lands.")) return;
  set({ off: true }, "The team is off. Each duty is worked start to finish by whoever claims it.");
}

async function requestDraft() {
  busy.value = true;
  error.value = "";
  try {
    const res = await api("/board/roster/draft", { project_id: props.projectId, note: draftNote.value.trim() });
    draftDutyId.value = res.duty_id;
    askingDraft.value = false;
    draftNote.value = "";
    notice.value = res.existing ? "A team is already being drafted for this board." : "A duty to draft this board's team is in the queue. What it proposes waits here for you to accept.";
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const acceptDraft = () => act(() => api("/board/roster/accept", { project_id: props.projectId }), "The drafted team is in force.");
const discardDraft = () => set({ discard_draft: true }, "The draft was discarded.");
const saveSettings = () => set({ settings: wanted.value }, "Saved.");

async function askRetro() {
  busy.value = true;
  error.value = "";
  try {
    const res = await api("/board/roster/retro", { project_id: props.projectId });
    retroDutyId.value = res.duty_id;
    notice.value = res.existing
      ? "A look back is already under way on this board."
      : "A duty to look at what keeps being sent back is in the queue. What it proposes waits here and in the rules for you to accept.";
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function loadHistory() {
  try {
    history.value = (await api("/board/memory/history", { project_id: props.projectId })).versions;
  } catch (err) {
    error.value = err.message;
  }
}
const toggleHistory = (event) => {
  if (event.target.open && !history.value) loadHistory();
};
const versionBy = (v) => (v.updated_by ? (v.updated_by.agent_id ? `${v.updated_by.agent_id}${v.updated_by.role ? ` as ${v.updated_by.role}` : ""}` : v.updated_by.name || "the owner") : "");
function restore(v) {
  if (!confirm(`Put version ${v.version} back? What is there now is kept as an earlier version, so this can be undone.`)) return;
  act(() => api("/board/memory/write", { project_id: props.projectId, body: v.body, based_on: memory.value.version }), `Version ${v.version} is back.`);
}

const startEdit = (role, at) => (editing.value = { ...role, at });
async function saveRole() {
  const { at, ...role } = editing.value;
  const next = roles.value.map((r, i) => (i === at ? role : r));
  if (await set({ roles: next }, `${role.name} saved. Sessions that start from now on use it.`)) editing.value = null;
}

const saveMemory = async () => {
  const ok = await act(
    () => api("/board/memory/write", { project_id: props.projectId, body: memoryEdit.value, based_on: memory.value.version }),
    memoryEdit.value.trim() ? "The memory is saved." : "The memory is cleared.",
  );
  if (ok) memoryEdit.value = null;
};
</script>

<template>
  <div class="stack">
    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">
      {{ notice }}
      <DutyLink v-if="draftDutyId || retroDutyId" :project-id="projectId" :duty-id="retroDutyId || draftDutyId">See the duty</DutyLink>
    </p>

    <p v-if="unsupported" class="notice">
      This DutyBoard is older than teams. Upgrade it — run <code class="mono">dutyboard</code> on a machine and accept the upgrade — then reload.
    </p>

    <template v-else-if="roster">
      <section class="panel stack" aria-labelledby="team-h">
        <h2 id="team-h" style="margin: 0">Team</h2>
        <p class="muted small" style="margin: 0">
          The roles this board's duties pass between. You file the work; the role that reads new duties first decides who
          does it, and a duty is handed from role to role — same thread, same workspace — until a reviewer has seen it work.
          Each role has a charter, its standing instructions, so nobody has to ask for secure, tested, readable work.
        </p>

        <div v-if="roster.draft" class="notice notice--warn stack">
          <h3 style="margin: 0">
            A drafted team
            <span class="muted small">— by {{ roster.draft.agent_id || "an agent" }}, {{ ago(roster.draft.created_at) }}</span>
          </h3>
          <p v-if="roster.draft.note" style="margin: 0">{{ roster.draft.note }}</p>
          <ul class="team">
            <li v-for="r in roster.draft.roles" :key="r.id" class="team__role">
              <div class="row">
                <strong>{{ r.name }}</strong>
                <span class="badge">{{ levelLabel(r.level) }}</span>
                <span v-for="t in roleTraits(r)" :key="t.key" class="badge badge--active" :title="t.hint">{{ t.label }}</span>
              </div>
              <p class="small" style="margin: 0.2rem 0 0">{{ r.summary }}</p>
              <details>
                <summary class="small">Charter</summary>
                <div class="md team__charter" v-html="markdown(r.charter)"></div>
              </details>
            </li>
          </ul>
          <div v-if="isOwner" class="row">
            <button class="primary" type="button" :disabled="busy" @click="acceptDraft">Accept this team</button>
            <button type="button" :disabled="busy" @click="discardDraft">Discard</button>
          </div>
          <p v-else class="small muted" style="margin: 0">The board's owner decides whether it takes effect.</p>
        </div>

        <template v-if="inForce">
          <ul class="team">
            <li v-for="(r, i) in roles" :key="r.id" class="team__role">
              <div class="row row--between">
                <div class="row">
                  <strong>{{ r.name }}</strong>
                  <span class="badge" :title="`Runs on a ${levelLabel(r.level).toLowerCase()} model: each machine picks from the combinations it has enabled at that level`">{{ levelLabel(r.level) }}</span>
                  <span v-for="t in roleTraits(r)" :key="t.key" class="badge badge--active" :title="t.hint">{{ t.label }}</span>
                </div>
                <button v-if="isOwner" type="button" class="link small" :disabled="busy" @click="startEdit(r, i)">Edit<span class="sr-only"> {{ r.name }}</span></button>
              </div>
              <p class="small" style="margin: 0.2rem 0 0">{{ r.summary }}</p>
              <details>
                <summary class="small">Charter</summary>
                <div class="md team__charter" v-html="markdown(r.charter)"></div>
              </details>
            </li>
          </ul>

          <form v-if="isOwner" class="stack team__settings" @submit.prevent="saveSettings">
            <h3 style="margin: 0">When a duty is handed on</h3>
            <label class="choice choice--block">
              <input v-model="settings.plan_approval" type="checkbox" />
              <span>
                I approve plans before they are built
                <span class="hint" style="display: block; margin: 0">A plan waits in Needs you until you approve it or say what to change. Off, a plan goes straight to whoever builds it.</span>
              </span>
            </label>
            <div class="field">
              <label for="team-bounces">Ask me after a reviewer has sent the same work back this many times</label>
              <input id="team-bounces" v-model.number="settings.max_bounces" type="number" min="1" max="10" style="max-width: 6rem" />
            </div>
            <div class="field">
              <label for="team-handoffs">Ask me after a duty has been handed on this many times without being finished</label>
              <input id="team-handoffs" v-model.number="settings.max_handoffs" type="number" min="4" max="50" style="max-width: 6rem" />
              <p class="hint">Catches two roles each sure the duty is the other's, which the send-back limit does not.</p>
            </div>
            <label class="choice choice--block">
              <input v-model="settings.independent_review" type="checkbox" />
              <span>
                Review on a different model than the one that built it
                <span class="hint" style="display: block; margin: 0">When a machine has another model at the reviewer's level, the reviewer runs on it, so it does not share the builder's blind spots.</span>
              </span>
            </label>
            <div class="field">
              <label for="team-sensitive">Always review these paths as high risk <span class="muted">(optional)</span></label>
              <textarea id="team-sensitive" v-model="sensitiveText" rows="3" class="mono" placeholder="auth/**&#10;**/payments/*&#10;*.sql" />
              <p class="hint">
                One pattern per line, from the repository's root: <code>*</code> within a folder, <code>**</code> across folders. When a change touches one, the
                machine marks the duty high risk, and its review is done line by line on a more capable model.
              </p>
            </div>
            <div><button type="submit" :disabled="busy || !settingsChanged">Save</button></div>
          </form>
        </template>
        <p v-else class="notice" style="margin: 0">
          This board has no team: each duty is worked start to finish by whichever agent claims it, and nothing reviews it before it lands.
        </p>

        <fieldset v-if="isOwner" class="stack" :disabled="busy">
          <legend class="label">{{ inForce ? "Use a different team" : "Give it a team" }}</legend>
          <label v-for="p in presets" :key="p.id" class="choice choice--block">
            <input v-model="chosenPreset" type="radio" name="team-preset" :value="p.id" />
            <span>
              {{ p.name }}
              <span v-if="p.id === roster.suggested_preset" class="badge">Fits this board</span>
              <span class="hint" style="display: block; margin: 0">{{ p.about }}</span>
            </span>
          </label>
          <div class="row">
            <button :class="{ primary: !inForce }" type="button" :disabled="!chosenPreset" @click="usePreset">{{ inForce ? "Replace the team" : "Use this team" }}</button>
            <button type="button" :aria-expanded="askingDraft" @click="askingDraft = !askingDraft">Have an agent draft one for this board</button>
            <button v-if="inForce" type="button" class="link" @click="turnOff">Turn the team off</button>
          </div>
        </fieldset>

        <div v-if="inForce" class="stack team__settings">
          <h3 style="margin: 0">What reviewers send back</h3>
          <p class="muted small" style="margin: 0">
            Work sent back is a standard nobody was told, or one too vague to follow. Every {{ roster.retro_every }} send-backs an agent looks at
            what they have in common and proposes changes to the charters and the rules — drafts you accept here and under Rules.
            <template v-if="roster.sent_back_since_retro">{{ roster.sent_back_since_retro }} since the last look.</template>
          </p>
          <details v-if="sentBacks.length">
            <summary class="small">The last {{ sentBacks.length }}</summary>
            <ul class="feed small">
              <li v-for="b in sentBacks" :key="`${b.duty_id}-${b.at}`" class="stack" style="gap: 0.15rem">
                <span>
                  <DutyLink :project-id="projectId" :duty-id="b.duty_id">{{ b.title }}</DutyLink>
                  <span class="muted"> — {{ b.from }} to {{ b.to }}, {{ ago(b.at) }}</span>
                </span>
                <span class="muted">{{ b.note }}</span>
              </li>
            </ul>
          </details>
          <div v-if="isOwner"><button type="button" :disabled="busy" @click="askRetro">Look back now</button></div>
        </div>

        <form v-if="isOwner && askingDraft" class="stack" @submit.prevent="requestDraft">
          <div class="field">
            <label for="team-draft-note">Anything it should know <span class="muted">(optional)</span></label>
            <textarea id="team-draft-note" v-model="draftNote" rows="3" maxlength="1000" placeholder="We also answer support email. Legal reviews anything public." />
            <p class="hint">
              An agent reads what this board is for and drafts roles and charters for it — for work the shipped teams do not fit.
              Nothing changes until you accept what it proposes.
            </p>
          </div>
          <div class="row">
            <button class="primary" type="submit" :disabled="busy">Draft a team</button>
            <button type="button" @click="askingDraft = false">Cancel</button>
          </div>
        </form>
      </section>

      <section v-if="memory" class="panel stack" aria-labelledby="memory-h">
        <h2 id="memory-h" style="margin: 0">The team's memory</h2>
        <p class="muted small" style="margin: 0">
          What this board's agents have written down for whoever works here next — decisions, how things are really run,
          traps. It is theirs: every session reads it and is told to keep it current. It is separate from the board's
          description, which is yours, and from the rules, which you accept.
        </p>
        <template v-if="memory">
          <div v-if="memory.body" class="md team__memory" v-html="markdown(memory.body)"></div>
          <p v-else class="muted small" style="margin: 0">Nothing yet. Agents add to it as they work.</p>
          <p class="hint" style="margin: 0">
            {{ memory.chars }} of {{ memory.max_chars }} characters<template v-if="memory.updated_at"> · updated {{ ago(memory.updated_at) }} by {{ memoryBy }}</template>.
          </p>
          <div v-if="isOwner"><button type="button" :disabled="busy" @click="memoryEdit = memory.body">Edit</button></div>
          <details v-if="memory.version > 1" @toggle="toggleHistory">
            <summary class="small">Earlier versions</summary>
            <p v-if="!history" class="muted small" role="status">Loading…</p>
            <p v-else-if="!history.length" class="muted small">None kept.</p>
            <ul v-else class="team">
              <li v-for="v in history" :key="v.version" class="team__role stack" style="gap: 0.4rem">
                <div class="row row--between">
                  <span class="small"><strong>Version {{ v.version }}</strong><span class="muted"> · {{ v.chars }} characters<template v-if="v.updated_at"> · {{ ago(v.updated_at) }}</template><template v-if="versionBy(v)"> by {{ versionBy(v) }}</template></span></span>
                  <button v-if="isOwner" type="button" class="link small" :disabled="busy" @click="restore(v)">Put this back<span class="sr-only"> (version {{ v.version }})</span></button>
                </div>
                <details>
                  <summary class="small">Read it</summary>
                  <div class="md team__memory" v-html="markdown(v.body)"></div>
                </details>
              </li>
            </ul>
          </details>
        </template>

      </section>
    </template>
    <p v-else-if="!error" class="muted" role="status">Loading…</p>

    <SidePanel v-if="editing" :label="`Edit ${editing.name || 'role'}`" @close="editing = null">
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <form class="stack" @submit.prevent="saveRole">
      <div class="field">
        <label for="role-name">Name</label>
        <input id="role-name" autofocus v-model="editing.name" required maxlength="40" />
      </div>
      <div class="field">
        <label for="role-summary">What it is for</label>
        <input id="role-summary" v-model="editing.summary" required maxlength="240" />
        <p class="hint">One sentence. Other roles decide whether to hand a duty here by reading it.</p>
      </div>
      <div class="field">
        <label for="role-level">Level</label>
        <select id="role-level" v-model="editing.level">
          <option v-for="l in LEVELS" :key="l.key" :value="l.key">{{ l.label }} — {{ l.hint }}</option>
        </select>
        <p class="hint">How capable a model it runs on. Each machine maps levels to its own enabled combinations, on the Machines page.</p>
      </div>
      <div class="field">
        <label for="role-charter">Charter, in markdown</label>
        <textarea id="role-charter" v-model="editing.charter" rows="14" :maxlength="MAX_CHARTER" required class="mono" />
        <p class="hint">{{ editing.charter.length }} of {{ MAX_CHARTER }} characters. Given to every session that works as this role.</p>
      </div>
      <div class="row">
        <button class="primary" type="submit" :disabled="busy">Save role</button>
        <button type="button" @click="editing = null">Cancel</button>
      </div>
    </form>
    </SidePanel>
    <SidePanel v-if="memoryEdit !== null" label="Edit the team's memory" @close="memoryEdit = null">
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <form class="stack" @submit.prevent="saveMemory">
      <div class="field">
        <label for="memory-edit">Memory, in markdown</label>
        <textarea id="memory-edit" v-model="memoryEdit" autofocus rows="14" :maxlength="memory.max_chars" class="mono" />
        <p class="hint">{{ memoryEdit.length }} of {{ memory.max_chars }} characters. Saving it empty clears it. Never put a secret here: every member and every session reads it.</p>
      </div>
      <div class="row">
        <button class="primary" type="submit" :disabled="busy">Save memory</button>
        <button type="button" @click="memoryEdit = null">Cancel</button>
      </div>
    </form>
    </SidePanel>
  </div>
</template>

<style scoped>
.team { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
.team__role { border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem 0.9rem; background: var(--surface); min-width: 0; }
.team__role details { margin-top: 0.4rem; }
.team__charter, .team__memory { background: var(--surface-2); border-radius: 8px; padding: 0.75rem; max-height: 26rem; overflow: auto; font-size: 0.9rem; }
.team__charter { margin-top: 0.4rem; }
.team__settings { border-top: 1px solid var(--border); padding-top: 0.9rem; }
</style>
