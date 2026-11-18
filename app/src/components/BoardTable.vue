<script setup>
// The boards page's list of boards: one row each, the same columns for every board, so a board
// with three questions waiting and one with nothing on it can be compared by reading down a
// column rather than by reading every card.
//
// A real table, because it is one — a screen reader can then say "Needs you, 2" for a cell rather
// than a run of numbers. On a phone each row folds into a short block with its labels beside the
// numbers, and the cells with nothing in them drop out.
import { useRouter } from "vue-router";
import { localWhen, until } from "../lib/duties.js";

const props = defineProps({
  boards: { type: Array, required: true },
  /** `{ [project_id]: { c, runner, next, when, idle } }`, as Boards.vue works it out. */
  info: { type: Object, required: true },
  /** Shared boards name their owner under the name, where your own show their id. */
  shared: { type: Boolean, default: false },
  caption: { type: String, required: true },
});

const router = useRouter();

/** The row is a target too, for a pointer. The name is the link, for everything else. */
function open(event, b) {
  if (event.target.closest("a")) return;
  if (window.getSelection && String(window.getSelection())) return;
  router.push({ name: "board", params: { projectId: b.project_id } });
}

const COLUMNS = [
  { key: "needs_decision", label: "Needs you", tone: "needs_decision" },
  { key: "active", label: "Running", tone: "active" },
  { key: "queued", label: "Queued", tone: "" },
  { key: "failed", label: "Failed", tone: "failed" },
];
</script>

<template>
  <div class="btable-wrap">
    <table class="btable">
      <caption class="sr-only">{{ caption }}</caption>
      <thead>
        <tr>
          <th scope="col">Board</th>
          <th v-for="col in COLUMNS" :key="col.key" scope="col" class="btable__n">{{ col.label }}</th>
          <th scope="col">Machine</th>
          <th scope="col">Next run</th>
          <th scope="col">Last activity</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="b in props.boards"
          :key="b.project_id"
          class="btable__row"
          :class="{ 'btable__row--idle': props.info[b.project_id].idle }"
          @click="open($event, b)"
        >
          <th scope="row" class="btable__board">
            <router-link class="btable__name" :to="{ name: 'board', params: { projectId: b.project_id } }">{{ b.name }}</router-link>
            <span v-if="props.shared" class="btable__sub">{{ b.owner_name ? `owned by ${b.owner_name}` : "shared with you" }}</span>
            <span v-else class="btable__sub mono">{{ b.project_id }}</span>
          </th>
          <td
            v-for="col in COLUMNS"
            :key="col.key"
            class="btable__n"
            :class="{ 'btable__n--none': !props.info[b.project_id].c || !props.info[b.project_id].c[col.key] }"
            :data-label="col.label"
          >
            <template v-if="props.info[b.project_id].c">
              <span v-if="props.info[b.project_id].c[col.key]" class="badge" :class="col.tone && `badge--${col.tone}`">{{ props.info[b.project_id].c[col.key] }}</span>
              <template v-else><span aria-hidden="true" class="btable__dash">–</span><span class="sr-only">none</span></template>
            </template>
          </td>
          <td class="btable__machine" :class="{ 'btable__n--none': !props.info[b.project_id].runner }" data-label="Machine">
            <span v-if="props.info[b.project_id].runner" class="livedot" :class="`livedot--${props.info[b.project_id].runner.tone}`">{{ props.info[b.project_id].runner.text }}</span>
            <template v-else><span aria-hidden="true" class="btable__dash">–</span><span class="sr-only">none</span></template>
          </td>
          <td class="btable__next" :class="{ 'btable__n--none': !props.info[b.project_id].next }" data-label="Next run">
            <span v-if="props.info[b.project_id].next" :title="props.info[b.project_id].next.title">
              {{ until(props.info[b.project_id].next.at) }}
              <span class="btable__sub">{{ localWhen(props.info[b.project_id].next.at) }}</span>
            </span>
            <template v-else><span aria-hidden="true" class="btable__dash">–</span><span class="sr-only">none</span></template>
          </td>
          <td class="btable__when" data-label="Last activity">{{ props.info[b.project_id].when }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
