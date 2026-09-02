import { createRouter, createWebHashHistory } from "vue-router";
import { isSignedIn } from "./lib/altengine.js";

const routes = [
  { path: "/", name: "boards", component: () => import("./views/Boards.vue"), meta: { title: "Your boards" } },
  { path: "/signin", name: "signin", component: () => import("./views/SignIn.vue"), meta: { title: "Sign in", public: true } },
  { path: "/b/:projectId", name: "board", component: () => import("./views/Board.vue"), props: true, meta: { title: "Board" } },
  { path: "/b/:projectId/settings", name: "settings", component: () => import("./views/Settings.vue"), props: true, meta: { title: "Board settings" } },
  { path: "/b/:projectId/d/:dutyId", name: "duty", component: () => import("./views/Duty.vue"), props: true, meta: { title: "Duty" } },
  { path: "/:pathMatch(.*)*", name: "notfound", component: () => import("./views/NotFound.vue"), meta: { title: "Not found", public: true } },
];

export const router = createRouter({
  // Hash history so the static bundle can be hosted anywhere with no rewrite rules.
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  if (!to.meta.public && !isSignedIn()) return { name: "signin", query: { next: to.fullPath } };
  if (to.name === "signin" && isSignedIn()) return { name: "boards" };
  return true;
});

// A route change in a single-page app is a navigation to a screen reader only if the
// title changes and focus moves — App.vue moves focus; this is the other half.
router.afterEach((to) => {
  document.title = `${to.meta.title || "DutyBoard"} · DutyBoard`;
});
