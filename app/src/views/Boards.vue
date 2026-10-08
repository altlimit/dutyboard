<script setup>
import { nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, refresh } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";
import { newRepoDraft, profileDraft, profilePayload, requestNewRepo } from "../lib/runners.js";
import ProfileForm from "../components/ProfileForm.vue";
import NewRepoFields from "../components/NewRepoFields.vue";

const router = useRouter();

const boards = ref([]);
const shared = ref([]);
const loading = ref(true);
const error = ref("");
const creating = ref(false);
const showForm = ref(false);
const name = ref("");
const slug = ref("");
const nameInput = ref(null);
// A board a `dutyboard` runner works is made with its profile; one for an agent you connect by
// hand with a token needs none. On by default, because the runner is how most boards are worked.
const forRunner = ref(true);
const profile = ref(profileDraft());
// A board can start from nothing: one of your machines makes its repository on GitHub, and its first
// duty builds the project's first version there.
const creatingRepo = ref(false);
const newRepo = ref(newRepoDraft());
const machines = ref([]);
// The repository is named after the board until someone names it otherwise.
let suggested = "";
watch([name, slug], () => {
  const next = (slug.value || name.value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (newRepo.value.name === suggested) newRepo.value.name = next;
  suggested = next;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await api("/projects/list");
    boards.value = res.projects;
    shared.value = res.shared || [];
    // Someone may have been added to a board since this page loaded, and this list is where they
    // would look for it. The function checked the token while answering; when it is behind, a
    // refresh now means the board opens with its duties rather than empty.
    if (res.refresh) await refresh().catch(() => {});
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** Opening the form moves focus into it. A button that reveals fields somewhere below,
 *  leaving focus on itself, is a form a keyboard user has to go looking for. */
async function openForm() {
  showForm.value = true;
  api("/machines/list")
    .then((res) => {
      machines.value = res.machines || [];
      if (!newRepo.value.machine_id) newRepo.value.machine_id = newRepoDraft("", machines.value).machine_id;
    })
    .catch(() => {});
  await nextTick();
  if (nameInput.value) nameInput.value.focus();
}

async function create() {
  creating.value = true;
  error.value = "";
  try {
    const makeRepo = forRunner.value && creatingRepo.value && profile.value.workspace !== "files";
    const payload = forRunner.value ? profilePayload(profile.value) : {};
    if (makeRepo) payload.profile.repo_url = "";
    const res = await api("/projects/create", {
      name: name.value,
      project_id: slug.value || undefined,
      ...payload,
    });
    // The board exists now whatever happens next. A repository that could not be asked for is offered
    // again on its settings, so this goes there either way and says why.
    let repoError = "";
    if (makeRepo) {
      await requestNewRepo(api, res.project_id, { ...newRepo.value, name: newRepo.value.name || res.project_id }).catch((err) => {
        repoError = err.message;
      });
    }
    name.value = "";
    slug.value = "";
    profile.value = profileDraft();
    creatingRepo.value = false;
    newRepo.value = newRepoDraft("", machines.value);
    showForm.value = false;
    // Straight to where the next step is: putting it on a machine, or minting a token.
    const query = { created: forRunner.value ? "runner" : "token", ...(repoError ? { repo_error: repoError } : {}) };
    router.push({ name: "settings", params: { projectId: res.project_id }, query });
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
    <div class="row row--between">
      <div>
        <h1>Your boards</h1>
        <p class="muted" style="margin: 0">
          A board is one stream of work. A machine running <code class="mono">dutyboard</code> works it with
          Claude Code, Codex or Cursor, or an agent connects to it with a token — either way it only ever sees the duties on it.
        </p>
      </div>
      <button
        class="primary page-action"
        type="button"
        :aria-expanded="showForm"
        @click="showForm ? (showForm = false) : openForm()"
      >
        {{ showForm ? "Cancel" : "New board" }}
      </button>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <!-- Behind a button, like "Add duty" on the board. Someone who already has boards came
         here to open one, and a permanent form pushes what they came for down the page. -->
    <form v-if="showForm" class="panel panel--form stack" @submit.prevent="create">
      <h2 style="margin: 0">New board</h2>
      <div class="field">
        <label for="b-name">Name</label>
        <input id="b-name" ref="nameInput" v-model="name" required maxlength="120" placeholder="Backend rewrite" />
      </div>
      <div class="field">
        <label for="b-slug">Board id <span class="muted">(optional)</span></label>
        <input id="b-slug" v-model="slug" maxlength="60" placeholder="derived from the name" />
        <p class="hint">Agents refer to the board by this id, so keep it short and stable. It cannot be changed later.</p>
      </div>
      <label class="choice choice--block">
        <input v-model="forRunner" type="checkbox" />
        <span>
          Worked by a <code class="mono">dutyboard</code> runner
          <span class="hint" style="display: block; margin: 0">
            A machine sets itself up for the project, drafts its rules for you to accept, and works its duties.
          </span>
        </span>
      </label>
      <ProfileForm v-if="forRunner" v-model="profile" v-model:creating="creatingRepo" id-prefix="new" offer-new-repo :disabled="creating">
        <template #new-repo>
          <NewRepoFields v-model="newRepo" id-prefix="new-repo" :machines="machines" :disabled="creating" />
        </template>
      </ProfileForm>
      <div>
        <button class="primary" type="submit" :disabled="creating || !name || (forRunner && creatingRepo && profile.workspace !== 'files' && !(newRepo.machine_id && newRepo.name))">
          {{ creating ? "Creating…" : "Create board" }}
        </button>
      </div>
    </form>

    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else>
      <!-- The whole card is the link. Two targets on one row — open, and settings — meant
           the obvious tap did the less likely thing about half the time; the board's own
           nav carries Settings, which is where you go once you are inside it. -->
      <ul v-if="boards.length" class="cards">
        <li v-for="b in boards" :key="b.project_id">
          <router-link class="boardcard" :to="{ name: 'board', params: { projectId: b.project_id } }">
            <span class="boardcard__name">{{ b.name }}</span>
            <span class="boardcard__meta mono">{{ b.project_id }}</span>
            <span class="boardcard__meta">created {{ ago(b.created_at) }}</span>
          </router-link>
        </li>
      </ul>

      <p v-else class="empty">
        {{ shared.length ? "No boards of your own yet." : "No boards yet. Create one, then put it on a machine." }}
      </p>

      <section v-if="shared.length" aria-labelledby="shared-h" class="stack">
        <h2 id="shared-h" style="margin: 0">Shared with you</h2>
        <ul class="cards">
          <li v-for="b in shared" :key="b.project_id">
            <router-link class="boardcard" :to="{ name: 'board', params: { projectId: b.project_id } }">
              <span class="boardcard__name">{{ b.name }}</span>
              <span class="boardcard__meta mono">{{ b.project_id }}</span>
              <span class="boardcard__meta">{{ b.owner_name ? `owned by ${b.owner_name}` : "shared with you" }}</span>
            </router-link>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
