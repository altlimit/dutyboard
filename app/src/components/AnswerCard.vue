<script setup>
// One question an agent has put to you, answerable where you are: the question, the options it
// offered as buttons, and a box for an answer of your own. A suggestion waiting for approval is
// approved or rejected the same way. The same calls the duty's own page makes.
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, query } from "../lib/altengine.js";
import { plainClick } from "../lib/clicks.js";
import { ago } from "../lib/duties.js";
import { markdown } from "../lib/markdown.js";

const props = defineProps({
  duty: { type: Object, required: true },
  // The board's name, where cards from several boards are shown together.
  board: { type: String, default: "" },
  // The role on the board's team that is waiting, when it has one.
  role: { type: String, default: "" },
});
// `open` asks to read the whole duty where you are; the title is still a real link for a new tab.
const emit = defineEmits(["answered", "open"]);
const router = useRouter();
const href = computed(() => router.resolve({ name: "duty", params: { projectId: props.duty.project_id, dutyId: props.duty.key } }).href);
function openHere(event) {
  if (!plainClick(event)) return;
  event.preventDefault();
  emit("open", { projectId: props.duty.project_id, dutyId: props.duty.key });
}

const question = ref(props.duty.last_question || "");
const options = ref([]);
const answer = ref("");
const sending = ref(false);
const error = ref("");
const box = ref(null);

/** The question as it was asked, with its options: the latest one on the duty's record. */
onMounted(async () => {
  try {
    const res = await query("threads", {
      where: [{ field: "duty_id", op: "=", value: props.duty.key }],
      order: [{ field: "created_at", dir: "desc" }],
      limit: 10,
    });
    for (const doc of res.documents || []) {
      const e = doc.data;
      if (e.kind === "resolution") break;
      if (e.kind === "question") {
        question.value = e.message || question.value;
        options.value = (e.metadata && e.metadata.suggested_options) || [];
        break;
      }
    }
  } catch {
    /* the question on the duty itself is enough to answer from */
  }
});

async function send(text, call = "resolve") {
  sending.value = true;
  error.value = "";
  try {
    if (call === "reject") await api("/duty/cancel", { duty_id: props.duty.key, reason: text || "Suggestion rejected." });
    else await api("/duty/resolve", { duty_id: props.duty.key, resolution_text: text, ...(props.duty.approval_required ? { approve: true } : {}) });
    emit("answered", { duty: props.duty, rejected: call === "reject" });
  } catch (err) {
    error.value = err.message;
  } finally {
    sending.value = false;
  }
}
const approve = () => send(answer.value.trim() || "Approved. Proceed with the suggested duty.");

/** Brought into view and ready to type in, when its cubicle was selected in the office. */
function focus() {
  if (!box.value) return;
  box.value.scrollIntoView({ block: "nearest", behavior: "smooth" });
  box.value.focus({ preventScroll: true });
}
defineExpose({ focus });
</script>

<template>
  <article class="ask">
    <header class="ask__head">
      <a class="ask__title" :href="href" @click="openHere">{{ duty.title }}</a>
      <span class="ask__meta">
        <span v-if="board" class="badge">{{ board }}</span>
        <span v-if="role">{{ role }}</span>
        <span>waiting {{ ago(duty.updated_at).replace(" ago", "") }}</span>
      </span>
    </header>
    <div class="md ask__q" v-html="markdown(question)"></div>

    <form class="stack ask__form" @submit.prevent="duty.approval_required ? approve() : send(answer.trim())">
      <div v-if="duty.approval_required" class="row">
        <button class="primary" type="button" :disabled="sending" @click="approve">{{ answer.trim() ? "Approve with answer" : "Approve duty" }}</button>
        <button type="button" :disabled="sending" @click="send(answer.trim(), 'reject')">Reject suggestion</button>
      </div>
      <div v-else-if="options.length" class="options">
        <button v-for="opt in options" :key="opt" type="button" :disabled="sending" @click="send(opt)">{{ opt }}</button>
      </div>
      <div class="row ask__own">
        <label class="sr-only" :for="`ask-${duty.key}`">{{ duty.approval_required ? "Answer or instructions (optional)" : "Your answer" }}</label>
        <textarea
          :id="`ask-${duty.key}`"
          ref="box"
          v-model="answer"
          rows="1"
          maxlength="4000"
          :placeholder="duty.approval_required ? 'Instructions with your approval (optional)' : options.length ? 'Or answer in your own words' : 'Your answer'"
          @keydown.enter.exact.prevent="duty.approval_required ? approve() : answer.trim() && send(answer.trim())"
        ></textarea>
        <button v-if="!duty.approval_required" class="primary" type="submit" :disabled="sending || !answer.trim()">{{ sending ? "Sending…" : "Send" }}</button>
      </div>
      <p v-if="error" class="notice notice--error small" role="alert" style="margin: 0">{{ error }}</p>
    </form>
  </article>
</template>

<style scoped>
.ask { border: 2px solid var(--warn); border-radius: 8px; background: var(--surface); padding: 0.7rem 0.8rem; min-width: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.ask__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; }
.ask__title { font-weight: 650; color: var(--text); overflow-wrap: anywhere; }
.ask__meta { display: inline-flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; font-size: 0.8rem; color: var(--text-dim); }
.ask__q { font-size: 0.92rem; }
.ask__form { gap: 0.45rem; }
.ask__own { flex-wrap: nowrap; align-items: flex-end; }
.ask__own textarea { flex: 1; min-width: 0; min-height: 2.4rem; resize: vertical; }
</style>
