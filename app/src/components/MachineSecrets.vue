<script setup>
// The MCP secrets a machine is missing, set from here.
//
// A secret typed into this form is encrypted in the browser to a key only that machine holds, and
// only the ciphertext is sent: the board that carries it to the machine cannot read it, and neither
// can anyone else on a board. That is what makes it safe to type an API token into a web page at all.
// The same secrets can still be set on the machine itself, with `dutyboard --mcp-secrets`.
import { computed, ref } from "vue";
import { api } from "../lib/altengine.js";
import { canSeal, sealSecrets } from "../lib/seal.js";

const props = defineProps({
  machine: { type: Object, required: true },
  secrets: { type: Array, required: true }, // [{ board, server, name, header, note }]
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["requested"]);

const open = ref(false);
const values = ref({});
const sending = ref(false);
const error = ref("");

const keyOf = (s) => `${s.board}/${s.server}/${s.name}`;
const filled = computed(() => props.secrets.filter((s) => (values.value[keyOf(s)] || "").trim()));
const groups = computed(() => {
  const out = [];
  for (const s of props.secrets) {
    let group = out.find((g) => g.board === s.board && g.server === s.server);
    if (!group) out.push((group = { board: s.board, server: s.server, note: s.note, secrets: [] }));
    group.secrets.push(s);
  }
  return out;
});
/** A machine from before this existed publishes no key; it is told how to set them on the machine instead. */
const ready = computed(() => !!props.machine.seal_key && canSeal());

async function send() {
  sending.value = true;
  error.value = "";
  try {
    const payload = filled.value.map((s) => ({ board: s.board, server: s.server, name: s.name, value: values.value[keyOf(s)].trim() }));
    const sealed = await sealSecrets(props.machine.seal_key, payload);
    const { request } = await api("/machine/request", { machine_id: props.machine.machine_id, kind: "mcp_secrets", sealed, seal_key: props.machine.seal_key });
    // Out of this page's memory as soon as they are on their way.
    values.value = {};
    open.value = false;
    emit("requested", request);
  } catch (err) {
    error.value = err.message;
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div v-if="ready" class="stack" style="margin-top: 0.4rem">
    <div v-if="!open">
      <button type="button" :disabled="disabled || !machine.online" :title="machine.online ? '' : `${machine.name} is offline`" @click="open = true">
        Set them here
      </button>
      <span v-if="machine.remote_setup === 'ask'" class="small muted"> someone at {{ machine.name }} accepts it by running <code class="mono">dutyboard</code> there</span>
    </div>
    <form v-else class="stack secrets" autocomplete="off" @submit.prevent="send">
      <p class="small" style="margin: 0">
        Encrypted in this browser for {{ machine.name }} alone before it is sent. DutyBoard carries it there and cannot read it;
        {{ machine.name }} keeps it in its keyring.
      </p>
      <p v-if="error" class="notice notice--error small" role="alert" style="margin: 0">{{ error }}</p>
      <fieldset v-for="g in groups" :key="`${g.board}/${g.server}`" class="stack">
        <legend class="label">
          {{ g.board }} — MCP server <span class="mono">{{ g.server }}</span>
          <span v-if="g.note" class="hint" style="display: block; margin: 0">{{ g.note }}</span>
        </legend>
        <div v-for="s in g.secrets" :key="keyOf(s)" class="field">
          <label :for="`secret-${machine.machine_id}-${keyOf(s)}`">
            <span class="mono">{{ s.name }}</span>
            <span class="muted"> — {{ s.header ? "header: the whole value, e.g. “Bearer …”" : "environment variable" }}</span>
          </label>
          <input :id="`secret-${machine.machine_id}-${keyOf(s)}`" v-model="values[keyOf(s)]" type="password" autocomplete="off" spellcheck="false" maxlength="8192" class="mono" />
        </div>
      </fieldset>
      <div class="row">
        <button class="primary" type="submit" :disabled="sending || !filled.length">
          {{ sending ? "Encrypting…" : `Send ${filled.length || ""} to ${machine.name}` }}
        </button>
        <button type="button" :disabled="sending" @click="open = false; values = {}">Cancel</button>
        <span class="small muted">Leave one empty to set it later.</span>
      </div>
    </form>
  </div>
</template>

<style scoped>
.secrets { border: 1px solid var(--border); border-radius: 10px; padding: 0.8rem; background: var(--surface); }
</style>
