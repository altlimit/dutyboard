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
  secrets: { type: Array, required: true }, // the missing ones: [{ board, server, name, header, note }]
  stored: { type: Array, default: () => [] }, // the ones it already has, the same shape, to replace
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["requested"]);

const open = ref(false);
const values = ref({});
const sending = ref(false);
const error = ref("");

const keyOf = (s) => `${s.board}/${s.server}/${s.name}`;
// Missing first, then those already set: an empty field for one of those keeps what the machine has.
const all = computed(() => [...props.secrets.map((s) => ({ ...s, set: false })), ...props.stored.map((s) => ({ ...s, set: true }))]);
const filled = computed(() => all.value.filter((s) => (values.value[keyOf(s)] || "").trim()));

// An Authorization header is a scheme and a credential, and the scheme is the half people leave out:
// they paste the token, the server answers 401, and nothing on the page said why. So the scheme is a
// choice in front of the field, Bearer unless changed, and what is sent is the two joined.
const SCHEMES = ["Bearer", "Basic", "Token"];
const isAuth = (s) => s.header && s.name.toLowerCase() === "authorization";
const scheme = ref({}); // key → "Bearer" | "Basic" | "Token" | "" (send exactly what was typed)
const schemeOf = (s) => scheme.value[keyOf(s)] ?? "Bearer";
/** A value pasted with its scheme already on it moves the scheme into the choice, so it is not sent twice. */
function typed(s, event) {
  const v = event.target.value;
  const m = isAuth(s) && /^\s*(bearer|basic|token)\s+(.+)$/is.exec(v);
  if (m) {
    scheme.value = { ...scheme.value, [keyOf(s)]: SCHEMES.find((x) => x.toLowerCase() === m[1].toLowerCase()) };
    values.value = { ...values.value, [keyOf(s)]: m[2] };
    event.target.value = m[2];
  } else values.value = { ...values.value, [keyOf(s)]: v };
}
/** What the machine is sent for one secret. */
const valueOf = (s) => {
  const v = (values.value[keyOf(s)] || "").trim();
  return isAuth(s) && schemeOf(s) ? `${schemeOf(s)} ${v}` : v;
};
const groups = computed(() => {
  const out = [];
  for (const s of all.value) {
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
    const payload = filled.value.map((s) => ({ board: s.board, server: s.server, name: s.name, value: valueOf(s) }));
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
        <template v-if="secrets.length">{{ secrets.length === 1 ? "Enter the secret" : `Enter ${secrets.length} secrets` }}</template>
        <template v-else>Replace {{ stored.length === 1 ? "the secret" : "a secret" }}</template>
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
            <span class="muted"> — {{ isAuth(s) ? "header" : s.header ? "header: the whole value" : "environment variable" }}</span>
            <span v-if="s.set" class="badge secret__set">set — leave empty to keep it</span>
          </label>
          <div v-if="isAuth(s)" class="secret__auth">
            <label class="sr-only" :for="`scheme-${machine.machine_id}-${keyOf(s)}`">Scheme for {{ s.name }}</label>
            <select :id="`scheme-${machine.machine_id}-${keyOf(s)}`" :value="schemeOf(s)" class="mono" @change="scheme = { ...scheme, [keyOf(s)]: $event.target.value }">
              <option v-for="x in SCHEMES" :key="x" :value="x">{{ x }}</option>
              <option value="">No prefix</option>
            </select>
            <input
              :id="`secret-${machine.machine_id}-${keyOf(s)}`"
              :value="values[keyOf(s)] || ''"
              type="password"
              autocomplete="off"
              spellcheck="false"
              maxlength="8192"
              class="mono"
              :placeholder="schemeOf(s) ? 'the token, without the word ' + schemeOf(s) : 'the whole header value'"
              :aria-describedby="`sends-${machine.machine_id}-${keyOf(s)}`"
              @input="typed(s, $event)"
            />
          </div>
          <input v-else :id="`secret-${machine.machine_id}-${keyOf(s)}`" v-model="values[keyOf(s)]" type="password" autocomplete="off" spellcheck="false" maxlength="8192" class="mono" />
          <p v-if="isAuth(s)" :id="`sends-${machine.machine_id}-${keyOf(s)}`" class="hint" style="margin: 0">
            Sends <code class="mono">{{ s.name }}: {{ schemeOf(s) ? schemeOf(s) + " " : "" }}{{ (values[keyOf(s)] || "").trim() ? "•".repeat(Math.min(12, values[keyOf(s)].trim().length)) : "…" }}</code>
            <template v-if="!schemeOf(s)"> — exactly what you type, so include the scheme if the server wants one.</template>
          </p>
        </div>
      </fieldset>
      <div class="row">
        <button class="primary" type="submit" :disabled="sending || !filled.length">
          {{ sending ? "Encrypting…" : `Send ${filled.length || ""} to ${machine.name}` }}
        </button>
        <button type="button" :disabled="sending" @click="open = false; values = {}">Cancel</button>
        <span class="small muted">{{ secrets.length ? "Leave one empty to set it later." : "Only what you fill in is replaced." }}</span>
      </div>
    </form>
  </div>
</template>

<style scoped>
.secrets { border: 1px solid var(--border); border-radius: 10px; padding: 0.8rem; background: var(--surface); }
/* The scheme sits on the front of the field, one control to the eye. */
.secret__auth { display: flex; }
.secret__set { margin-left: 0.4rem; font-weight: 500; }
.secret__auth select { flex: none; width: auto; border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: 0; background: var(--surface-2); }
.secret__auth input { flex: 1 1 auto; min-width: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
</style>
