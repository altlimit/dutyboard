<script setup>
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../lib/altengine.js";
import { config } from "../config.js";
import { ago } from "../lib/duties.js";

const props = defineProps({ projectId: { type: String, required: true } });
const router = useRouter();

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

const mcpUrl = computed(() => `${config.api}/mcp${agentIdOf(fresh.value) ? `?agent=${agentIdOf(fresh.value)}` : ""}`);
const agentIdOf = (t) => (t && t.default_agent_id) || "";

const mcpCommand = computed(
  () =>
    `claude mcp add --transport http dutyboard "${mcpUrl.value}" \\\n  --header "Authorization: Bearer ${fresh.value ? fresh.value.token : "<your token>"}"`,
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    tokens.value = (await api("/tokens/list", { project_id: props.projectId })).tokens;
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

onMounted(load);
</script>

<template>
  <div class="wrap wrap--narrow stack">
    <p><router-link :to="{ name: 'board', params: { projectId } }">← Back to the board</router-link></p>

    <div>
      <h1>Agents &amp; tokens</h1>
      <p class="muted">
        An agent connects with a project token. The token names this board and nothing else,
        so an agent holding it can never reach another one.
      </p>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <div v-if="fresh" class="notice stack" role="status">
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
        Or over plain HTTP: <code class="mono">POST {{ config.api }}/duty/poll</code> with the same
        Authorization header.
      </p>
      <div><button type="button" @click="fresh = null">Done</button></div>
    </div>

    <form class="panel stack" @submit.prevent="mint">
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

    <section aria-labelledby="tokens-h" class="stack">
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

    <section aria-labelledby="danger-h" class="panel stack" style="border-color: var(--danger)">
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
