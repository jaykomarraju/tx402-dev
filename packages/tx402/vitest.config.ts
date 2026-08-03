import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      reporter: ["text", "lcov"],
      // SPEC §12.1: >=90% line and branch coverage in core modules. Enforced from M0
      // (PLAN.md open item O11) rather than deferred — the gate is far cheaper to hold from
      // the first core module onward than to reach retroactively across eight milestones.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
