import { defineConfig } from "vitest/config";

// Vite plugin to stub Plasmo's `data-base64:~...` imports during test runs.
// Plasmo's bundler handles these at build time (replacing the import with
// a base64 data-URI string) but vitest has no equivalent transform, so
// without this stub the imports throw "Failed to resolve" and any module
// that touches CSS via `data-base64:~assets/icon.png` fails to load.
const dataBase64Stub = {
  name: "data-base64-stub",
  enforce: "pre" as const,
  resolveId(id: string) {
    if (id.startsWith("data-base64:")) return id;
    return null;
  },
  load(id: string) {
    if (id.startsWith("data-base64:")) {
      // Tests don't care about the actual icon bytes — a placeholder data
      // URI keeps the CSS string valid (no broken url() reference) without
      // bloating the test bundle.
      return `export default "data:image/png;base64,STUB"`;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [dataBase64Stub],
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
        statements: 74,
        branches: 73,
        functions: 74,
        lines: 74,
      },
    },
  },
});
