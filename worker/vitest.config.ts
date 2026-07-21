import { defineConfig } from "vitest/config";

// Pure-logic unit tests for the Worker. Runs in a plain Node environment (the
// helpers under test are pure — no D1/R2/runtime globals at import time). Tests
// live beside the code as `*.test.ts` under src/.
export default defineConfig({
  // Override the repo-root PostCSS/Tailwind config search — these are pure-TS
  // tests with no CSS, and the worker package doesn't install Tailwind.
  css: { postcss: { plugins: [] } },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
