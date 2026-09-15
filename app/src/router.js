import { createRouter, createWebHashHistory } from "vue-router";
import { ensureAccess, isSignedIn, onSessionChange } from "./lib/altengine.js";

const routes = [
  { path: "/", name: "boards", component: () => import("./views/Boards.vue"), meta: { title: "Your boards" } },
  { path: "/signin", name: "signin", component: () => import("./views/SignIn.vue"), meta: { title: "Sign in", public: true } },
  // Public, and it has to be: it configures the auth instance that signing in would use.
  { path: "/connect", name: "connect", component: () => import("./views/Connect.vue"), meta: { title: "Connect your altengine", public: true } },
  { path: "/pair", name: "pair", component: () => import("./views/Pair.vue"), meta: { title: "Pair a machine" } },
  { path: "/notifications", name: "notifications", component: () => import("./views/Notifications.vue"), meta: { title: "Notifications" } },
  { path: "/machines", name: "runners", component: () => import("./views/Runners.vue"), meta: { title: "Your machines" } },
  { path: "/b/:projectId", name: "board", component: () => import("./views/Board.vue"), props: true, meta: { title: "Board" } },
  { path: "/b/:projectId/settings", name: "settings", component: () => import("./views/Settings.vue"), props: true, meta: { title: "Board settings" } },
  { path: "/b/:projectId/d/:dutyId", name: "duty", component: () => import("./views/Duty.vue"), props: true, meta: { title: "Duty" } },
  { path: "/:pathMatch(.*)*", name: "notfound", component: () => import("./views/NotFound.vue"), meta: { title: "Not found", public: true } },
];

export const router = createRouter({
  // Hash history, so the console works on any static host, at any path, with no rewrite rules —
  // history URLs would need every path to fall back to index.html.
  history: createWebHashHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (!to.meta.public && !isSignedIn()) return { name: "signin", query: { next: to.fullPath } };
  if (to.name === "signin" && isSignedIn()) return { name: "boards" };
  // Before any page that reads the datastore: the token must carry the claim the rules check.
  // Memoised, so this is one request a page load however many navigations follow.
  if (!to.meta.public) await ensureAccess();
  return true;
});

/**
 * A session that ends while the app is open sends you to sign in.
 *
 * The guard above only runs on navigation, and a session does not end on a navigation — it
 * ends when a refresh fails, mid-page, with the board already on screen. Without this the
 * app stayed exactly where it was, every call failing, and the way out was to notice the
 * sign-out button. `next` is kept so signing back in returns to the same board.
 */
onSessionChange((s) => {
  if (s.idToken) return;
  const current = router.currentRoute.value;
  if (current.meta.public) return;
  router.replace({ name: "signin", query: { next: current.fullPath } });
});

// A route change in a single-page app is a navigation to a screen reader only if the
// title changes and focus moves — App.vue moves focus; this is the other half.
router.afterEach((to) => {
  document.title = `${to.meta.title || "DutyBoard"} · DutyBoard`;
});
