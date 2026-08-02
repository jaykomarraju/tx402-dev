import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // SPEC §12.1: >=90% line and branch coverage in core modules.
      // Thresholds are raised to the gate value once core modules land in M1/M2.
      include: ["src/core/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
