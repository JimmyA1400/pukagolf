import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The same "@/..." imports the app uses (tsconfig.json's paths).
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // e2e/ is Playwright's; its specs need a browser and a running app.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
