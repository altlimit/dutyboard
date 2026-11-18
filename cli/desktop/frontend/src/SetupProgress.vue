<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { Events } from "@wailsio/runtime";
import { Setup } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import type { SetupLine, SetupQuestion } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";

// A provisioning run, watched: each line as the terminal would print it, and each question it asks
// answered here. Setting up a DutyBoard and upgrading one are the same run, so they share this.
// It starts when it is shown; `done` carries what the run returned, `back` means the person gave up.
type Call = PromiseLike<unknown> & { cancel: () => void };
const props = defineProps<{ run: () => Call; title: string }>();
const emit = defineEmits<{ done: [result: unknown]; back: [] }>();

const lines = ref<SetupLine[]>([]);
const question = ref<SetupQuestion | null>(null);
const answer = ref("");
const working = ref(false);
const problem = ref("");
const linesEl = ref<HTMLElement | null>(null);

// Kept so that Cancel can stop the call — and so its rejection can be told from a failure.
let running: Call | null = null;
let cancelled = false;

async function follow() {
  await nextTick();
  if (linesEl.value) linesEl.value.scrollTop = linesEl.value.scrollHeight;
  // A question stops everything until it is answered, so it must not arrive below the fold.
  document.getElementById("question")?.scrollIntoView({ block: "end", behavior: "smooth" });
}

async function start() {
  lines.value = [];
  question.value = null;
  problem.value = "";
  working.value = true;
  cancelled = false;
  const call = props.run();
  running = call;
  try {
    const result = await call;
    if (!result) throw new Error("it ended without saying what it did");
    emit("done", result);
  } catch (e) {
    if (cancelled) emit("back");
    else problem.value = e instanceof Error ? e.message : String(e);
  } finally {
    running = null;
    working.value = false;
    question.value = null;
  }
}

function cancel() {
  cancelled = true;
  running?.cancel();
}

function reply(value: string) {
  const q = question.value;
  if (!q) return;
  question.value = null;
  answer.value = "";
  Setup.Answer(q.id, value);
}

const off: Array<() => void> = [];
onMounted(() => {
  off.push(
    Events.On("setup:line", (e) => {
      lines.value.push(e.data);
      follow();
    }),
    Events.On("setup:question", (e) => {
      question.value = e.data;
      answer.value = e.data.kind === "ask" ? e.data.default : "";
      follow();
    }),
  );
  start();
});
onUnmounted(() => {
  off.forEach((f) => f());
  running?.cancel();
});
</script>

<template>
  <section class="panel progress">
    <div class="panel__head">
      <h2>{{ working ? title : problem ? "It stopped" : title }}</h2>
      <span v-if="working && !question" class="muted">This takes a minute or two.</span>
    </div>
    <ul ref="linesEl" id="lines" class="lines">
      <li v-for="(l, i) in lines" :key="i" :class="'line line--' + l.kind">{{ l.text }}</li>
      <li v-if="working && !question" class="line line--busy">…</li>
    </ul>

    <form v-if="question" id="question" class="question" @submit.prevent="reply(answer)">
      <p class="label">{{ question.text }}</p>
      <div v-if="question.kind === 'choose'" class="options">
        <button v-for="(o, i) in question.options" :key="i" type="button" :class="{ primary: String(i) === question.default }" @click="reply(String(i))">
          {{ o }}
        </button>
      </div>
      <div v-else-if="question.kind === 'confirm'" class="row">
        <button type="button" id="yes" :class="{ primary: question.default === 'yes' }" @click="reply('yes')">Yes</button>
        <button type="button" id="no" :class="{ primary: question.default === 'no' }" @click="reply('no')">No</button>
      </div>
      <div v-else class="row">
        <input id="answer" v-model="answer" :type="question.kind === 'secret' ? 'password' : 'text'" autocomplete="off" spellcheck="false" />
        <button class="primary" type="submit">Continue</button>
      </div>
    </form>

    <p v-if="problem" class="notice notice--error">{{ problem }}</p>
    <div class="row">
      <button v-if="working" id="cancel" @click="cancel">Cancel</button>
      <template v-else>
        <button id="retry" class="primary" @click="start">Try again</button>
        <button id="progress-back" @click="emit('back')">Back</button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.progress {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.lines {
  flex: 1;
  min-height: 6rem;
  max-height: min(22rem, 38vh);
  overflow: auto;
  margin: 0;
  padding: 0.75rem;
  list-style: none;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.9rem;
  line-height: 1.5;
}
.line {
  padding-left: 1.4rem;
  position: relative;
  word-break: break-word;
}
.line--step {
  padding-left: 0;
  margin-top: 0.6rem;
  font-weight: 650;
}
.line--step:first-child {
  margin-top: 0;
}
.line--ok::before {
  content: "✓";
  position: absolute;
  left: 0.2rem;
  color: var(--ok);
}
.line--warn {
  color: var(--warn);
}
.line--warn::before {
  content: "!";
  position: absolute;
  left: 0.35rem;
  font-weight: 700;
}
.line--note,
.line--busy {
  color: var(--text-dim);
}
.question {
  padding: 0.9rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
}
.question .label {
  margin-bottom: 0.6rem;
}
.question input {
  flex: 1;
  min-width: 12rem;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: stretch;
}
.options button {
  text-align: left;
  white-space: normal;
}
</style>
