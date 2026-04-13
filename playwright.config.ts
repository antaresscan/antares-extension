import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://antares-extension.vercel.app",
    extraHTTPHeaders: {
      "User-Agent": "Antares-E2E/1.0",
    },
  },
  projects: [
    {
      name: "api",
      testMatch: /api\..*\.spec\.ts/,
    },
    {
      name: "landing",
      testMatch: /landing\..*\.spec\.ts/,
      use: { browserName: "chromium" },
    },
  ],
  reporter: [["html", { open: "never" }], ["list"]],
});
