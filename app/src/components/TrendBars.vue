<script setup>
// A fortnight of finished duties, one thin bar a day, today in the accent and the rest stepped
// back — the trend under the "Finished" number, not a chart to study. Each day says its own count
// on hover, and the same numbers are in a table a screen reader reads instead of the picture.
import { computed } from "vue";

const props = defineProps({
  /** `[{ start, done }]`, oldest first, as `finishesByDay` answers. */
  days: { type: Array, required: true },
});

const W = 140;
const H = 32;
const BAR = 7;

const dayName = (ms) => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));

const bars = computed(() => {
  const max = Math.max(1, ...props.days.map((d) => d.done));
  const step = W / props.days.length;
  return props.days.map((d, i) => {
    // A day with nothing still draws a sliver on the baseline, so an empty day reads as zero
    // rather than as a gap in the data.
    const h = d.done ? Math.max(3, (d.done / max) * (H - 2)) : 1;
    return {
      key: d.start,
      x: i * step + (step - BAR) / 2,
      hitX: i * step,
      step,
      y: H - h,
      h,
      today: i === props.days.length - 1,
      label: `${dayName(d.start)}: ${d.done} finished`,
    };
  });
});
</script>

<template>
  <div class="trend">
    <svg class="trend__svg" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
      <g v-for="b in bars" :key="b.key" class="trend__day">
        <title>{{ b.label }}</title>
        <!-- The hover target is the whole column, not the 7px bar in it. -->
        <rect class="trend__hit" :x="b.hitX" y="0" :width="b.step" :height="H" />
        <rect class="trend__bar" :class="{ 'trend__bar--today': b.today }" :x="b.x" :y="b.y" :width="BAR" :height="b.h" rx="1.5" />
      </g>
    </svg>
    <!-- Hidden by a wrapper, not on the table itself: a table will not shrink to the 1px the
         class asks for, and one sized by its contents pushed the page sideways on a phone. -->
    <div class="sr-only">
      <table>
        <caption>Duties finished per day, last {{ days.length }} days</caption>
        <tbody>
          <tr v-for="b in bars" :key="b.key"><th scope="row">{{ b.label.split(":")[0] }}</th><td>{{ b.label.split(": ")[1] }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
