import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { PRO_HEADERS } from "./e2e/pro";

const BASE_URL =
  process.env.E2E_BASE_URL || "https://antares-extension.vercel.app";
// The Origin header the API tests present. Fixed and allowed on purpose: when
// BASE_URL is a deployment URL (a Vercel preview), that host is not one of the
// API's allowed origins and every request would be refused with a 403.
const ORIGIN = process.env.E2E_ORIGIN || "https://antares-extension.vercel.app";
const EXTENSION_PATH = path.resolve(__dirname, "build/chrome-mv3-prod");
const IS_CI = !!process.env.CI;
const API_HEADERS = { "User-Agent": "Antares-E2E/2.0", "Origin": ORIGIN };
// The specs that read the full analysis ask as a Pro install (e2e/pro.ts). Only the request-based projects send it: a browser project
// would send it to every third party its pages load; its specs add it to the API calls of the page under test (injectProHeaders).
const API_PRO_HEADERS = { ...API_HEADERS, ...PRO_HEADERS };

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
        extraHTTPHeaders: API_HEADERS,
    screenshot: "only-on-failure",
    video: IS_CI ? "retain-on-failure" : "off",
    trace: IS_CI ? "retain-on-failure" : "off",
  },
  projects: [
    /* -- API tests (headless, no browser needed) -- */
    {
      name: "api",
      testMatch: /api[-.].*\.spec\.ts/,
      use: { extraHTTPHeaders: API_PRO_HEADERS },
    },
    /* -- Web pages (Desktop Chrome) -- */
    {
      name: "web-desktop",
      testMatch:
        /(?:landing|token-page|privacy-page|seo-meta|accessibility|navigation|performance).*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    /* -- Mobile viewport tests -- */
    {
      name: "web-mobile",
      testMatch: /(?:landing|mobile-responsive)\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
    /* -- Tablet viewport -- */
    {
      name: "web-tablet",
      testMatch: /landing\.spec\.ts/,
      use: { ...devices["iPad (gen 7)"] },
    },
    /* -- Chrome Extension tests (persistent context) -- */
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
    /* -- Integration / Regression / Cross-cutting tests -- */
    {
      name: "integration",
      testMatch:
        /(?:scan-integration|regression|error-handling|security-headers)\.spec\.ts/,
      use: { extraHTTPHeaders: API_PRO_HEADERS },
    },
  ],
});
