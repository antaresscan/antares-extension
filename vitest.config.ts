import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 10_000,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["api/**/*.ts"],
      exclude: ["api/types.ts", "api/_lib/cache.ts"],
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 75,
        lines: 75,
      },
    },
  },
});
