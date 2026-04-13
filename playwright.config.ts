import { defineConfig, devices } from "@playwright/test";
import path from "path";

const BASE_URL =
  process.env.E2E_BASE_URL || "https://antares-extension.vercel.app";
const EXTENSION_PATH = path.resolve(__dirname, "build/chrome-mv3-prod");
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: IS_CI ? 2 : 0,
  workers: IS_CI ? 1 : undefined,
  fullyParallel: !IS_CI,
  forbidOnly: IS_CI,
  reporter: IS_CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["html", { open: "on-failure" }], ["list"]],
  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders: { "User-Agent": "Antares-E2E/2.0" },
    screenshot: "only-on-failure",
    video: IS_CI ? "retain-on-failure" : "off",
    trace: IS_CI ? "retain-on-failure" : "off",
  },
  projects: [
    /* ── API tests (headless, no browser needed) ── */
    {
      name: "api",
      testMatch: /api[-.].*\.spec\.ts/,
    },
    /* ── Landing page + static pages (Chromium) ── */
    {
      name: "web-desktop",
      testMatch: /(?:landing|token-page|privacy-page).*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "web-mobile",
      testMatch: /landing\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "web-tablet",
      testMatch: /landing\.spec\.ts/,
      use: { ...devices["iPad (gen 7)"] },
    },
    /* ── Chrome Extension tests (persistent context) ── */
    {
      name: "extension",
      testMatch: /extension.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        launchOptions: {
          args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            "--no-first-run",
            "--disable-default-apps",
          ],
          headless: false,
        },
      },
    },
    /* ── Integration / Regression tests ── */
    {
      name: "integration",
      testMatch: /(?:scan-integration|regression).*\.spec\.ts/,
    },
  ],
});
