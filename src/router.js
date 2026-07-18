import { createRouter, createWebHashHistory } from "vue-router";
import { session } from "./lib/session.js";

// Hash history keeps this a truly static site — deep links work from any static
// host (or `file://`) with no server rewrite rules.
const routes = [
  { path: "/", name: "cities", component: () => import("./views/Cities.vue") },
  { path: "/signin", name: "signin", component: () => import("./views/SignIn.vue"), meta: { public: true } },
  { path: "/city/:slug", name: "city", component: () => import("./views/CityDetail.vue"), props: true },
  { path: "/city/:slug/duty/:dutyKey", name: "duty", component: () => import("./views/DutyDetail.vue"), props: true },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 };
  },
});

// Everything except the sign-in page requires a session.
router.beforeEach((to) => {
  if (!to.meta.public && !session.isSignedIn.value) {
    return { name: "signin", query: to.fullPath !== "/" ? { next: to.fullPath } : undefined };
  }
  if (to.name === "signin" && session.isSignedIn.value) return { name: "cities" };
  return true;
});

// Set a meaningful, per-view document title (accessibility: users know where they are).
router.afterEach((to) => {
  const titles = {
    cities: "Cities",
    signin: "Sign in",
    city: "City",
    duty: "Duty",
  };
  document.title = "DutyBoard — " + (titles[to.name] || "");
});
