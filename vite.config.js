import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The console — a plain static SPA, no server and no secrets, everything ships to the
// browser.
//
// It builds INTO the marketing site's output, under /app. `sitegen` writes public/ and
// this writes public/app, which is why `npm run build` runs them in that order: the site
// build cleans public/ first, so doing it the other way round deletes the app.
export default defineConfig({
  root: "app",
  // Assets are requested from /app/..., not /. Without this the built page asks the
  // marketing site's root for its JavaScript and gets HTML back.
  base: "/app/",
  plugins: [vue()],
  build: {
    outDir: "../public/app",
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
