// A duty, or a recurring duty, read in a panel that slides in over the page, kept in the address:
// `duty` (and the board it is `on`, on a page that shows several) — so Back closes it, and a reload
// or a shared link opens it again.
//
// A page uses it by calling `useDutyPanel()` and drawing `DutyDrawer` / `ScheduleDrawer` from what it
// answers. Anything below the page that links to a duty — a card, a search hit — gets `openDuty`
// through `provide`, so it can open in the panel on a plain click and still open its own page on a
// middle click or with a key held.
import { computed, inject, provide, unref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { plainClick } from "./clicks.js";

const KEY = "openDuty";

/**
 * `projectId` is the page's own board, when it has one; a page of many boards leaves it out and the
 * board travels in the address as `on`. `enabled` turns the panel off (the Boards page's list view).
 */
export function useDutyPanel({ projectId = null, enabled = () => true } = {}) {
  const route = useRoute();
  const router = useRouter();
  const boardOf = () => String(route.query.on || unref(projectId) || "");

  const reading = computed(() => (enabled() && route.query.duty && boardOf() ? { projectId: boardOf(), dutyId: String(route.query.duty) } : null));
  const readingSchedule = computed(() =>
    enabled() && route.query.schedule && boardOf() ? { projectId: boardOf(), scheduleId: String(route.query.schedule) } : null,
  );
  const on = (id) => (unref(projectId) && id === unref(projectId) ? undefined : id);

  function openDuty({ projectId: id, dutyId }) {
    const { schedule, ...rest } = route.query;
    router.push({ query: { ...rest, duty: dutyId, on: on(id) } });
  }
  function openSchedule({ projectId: id, scheduleId }) {
    const { duty, ...rest } = route.query;
    router.push({ query: { ...rest, schedule: scheduleId, on: on(id) } });
  }
  function close() {
    const { duty, schedule, on: _on, ...rest } = route.query;
    router.replace({ query: rest });
  }
  provide(KEY, openDuty);
  return { reading, readingSchedule, openDuty, openSchedule, closeDuty: close, closeSchedule: close };
}

/**
 * For a link to a duty somewhere under a page that opens duties in a panel: a click handler that
 * opens it there on a plain click. Anything else — a middle click, a key held, no such page above —
 * goes to `navigate`, the router link's own (a `custom` router-link's slot gives it), which leaves a
 * modified click to the browser.
 */
export function useOpenDuty() {
  const open = inject(KEY, null);
  return (event, projectId, dutyId, navigate) => {
    if (open && plainClick(event)) {
      event.preventDefault();
      open({ projectId, dutyId });
    } else if (navigate) {
      navigate(event);
    }
  };
}
