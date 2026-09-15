import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The console — a plain static SPA, no server and no secrets, everything ships to the browser.
//
// It is the whole of a deployment's static site: the provisioner publishes dist/ to the root of the
// deployment's own static instance, next to the config.js that points it at that deployment. Nothing
// about it is served from dutyboard.com.
export default defineConfig({
  // Relative asset URLs, so the same build works at a site's root, under a path, or opened from a
  // preview server — the page never has to know where it was put.
  base: "./",
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // strictPort, not the usual "take the next free one". The origin is baked into two
  // allowlists at provision time — the auth instance's and the function's CORS list — so a
  // silent move to 5174 produces a console that loads perfectly and fails every call.
  // Refusing to start is the smaller problem, and it names itself.
  //
  // DUTYBOARD_PORT moves both halves together: `npm run setup` derives the allowed origins
  // from the same variable, so `DUTYBOARD_PORT=5180 npm run setup && DUTYBOARD_PORT=5180 npm run dev`
  // is all it takes to sit next to something else that already owns 5173.
  server: { port: Number(process.env.DUTYBOARD_PORT || 5173), strictPort: true },
});
