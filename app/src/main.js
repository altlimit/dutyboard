import { loadRuntimeConfig } from "./runtime.js";

// Where this console points first, then the app — see runtime.js.
loadRuntimeConfig().finally(() => import("./start.js"));
