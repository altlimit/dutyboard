// Your boards and what is on them, for the pages that look across all of them: the list of boards,
// a count of each board's duties by status, the machines on each, and what their schedules file next.
//
// The Dashboard and the Boards page both read this; each adds what only it shows through `onStatus`,
// which runs alongside the counts whenever they are read again.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { aggregate, api, refresh } from "./altengine.js";
import { COUNTS_REQUEST, countsByBoard } from "./boards.js";

/** While a page is in front of someone it keeps up: on coming back to the tab, and once a minute. */
const REFRESH_EVERY_MS = 60_000;

export function useBoards({ onStatus = async () => {}, onRefresh = () => {} } = {}) {
  const boards = ref([]);
  const shared = ref([]);
  const loading = ref(true);
  const error = ref("");
  /** Duties per board per status, from one grouped count. Null until it answers — and if it never
   *  does, the numbers stay blank rather than claiming every board is empty. */
  const counts = ref(null);
  /** The machines on each board, keyed by board. Filled in after the boards draw. */
  const runners = ref({});
  /** What the schedules file next, from `/projects/upcoming` — null until it answers, and for good on
   *  a function too old to have it. */
  const upcoming = ref(null);

  const all = computed(() => [...boards.value, ...shared.value]);
  const nameOf = computed(() => Object.fromEntries(all.value.map((b) => [b.project_id, b.name])));

  async function loadStatus() {
    const [agg] = await Promise.allSettled([aggregate("duties", COUNTS_REQUEST), onStatus()]);
    if (agg.status === "fulfilled") counts.value = countsByBoard(agg.value.groups);
  }

  /** The machines on every board, and what the schedules file next: both after the boards have
   *  drawn, and neither able to stop the page. */
  async function loadRunners() {
    const ids = all.value.map((b) => b.project_id);
    if (!ids.length) return;
    await Promise.all([
      api("/projects/runners", { project_ids: ids })
        .then((res) => (runners.value = res.runners || {}))
        .catch(() => {}),
      api("/projects/upcoming", { project_ids: ids })
        .then((res) => (upcoming.value = { schedules: res.schedules || [], total: res.total || 0, next: res.next || {} }))
        .catch(() => {}),
    ]);
  }

  async function load() {
    loading.value = true;
    error.value = "";
    try {
      const status = loadStatus();
      const res = await api("/projects/list");
      boards.value = res.projects;
      shared.value = res.shared || [];
      // Someone may have been added to a board since this page loaded. The function checked the token
      // while answering; when it is behind, a refresh now, and the counts asked for again with it.
      if (res.refresh) {
        await refresh().catch(() => {});
        await status;
        await loadStatus();
      } else {
        await status;
      }
    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
    loadRunners();
  }

  let timer = null;
  let lastRefresh = Date.now();
  function refreshIfVisible() {
    if (document.visibilityState !== "visible" || loading.value) return;
    if (Date.now() - lastRefresh < REFRESH_EVERY_MS / 2) return;
    lastRefresh = Date.now();
    loadStatus();
    loadRunners();
    onRefresh();
  }

  onMounted(() => {
    load();
    timer = setInterval(refreshIfVisible, REFRESH_EVERY_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
  });
  onUnmounted(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", refreshIfVisible);
  });

  return { boards, shared, all, nameOf, loading, error, counts, runners, upcoming, load, loadStatus, loadRunners };
}
