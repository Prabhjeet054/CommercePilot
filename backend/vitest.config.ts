import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Shared Postgres: avoid cross-file teardown races (e.g. schema cleanup vs live pipelines).
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/modules/policy/evaluate.ts", "src/lib/state-machine.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
