// e2e/extension-overlay-mount.spec.ts
//
// SMOKE TEST — extension boot path.
//
// Mission: catch the failure mode of incident PR #510 (2026-05-19),
// where a build of the extension shipped on the user's machine and
// the overlay never injected at all. Root cause was contents/modules/
// scanner.ts throwing on Zod schema drift (`throw new Error("scan_
// schema_drift")`) — a single optional field returning `null` instead
// of `undefined` was enough to kill the scan path. The crash was
// silent because Sentry's beforeSend captured it and the content
// script bailed before painting anything to the page.
//
// This test boots the packaged extension into a real Chrome instance,
// loads a page matching one of the host_permissions, and verifies the
// content-script's startup sequence runs to completion WITHOUT any
// console errors. The content script's GUARD attribute on
// `<html data-antares-init="1">` is the load-completion signal — it's
// set unconditionally at the top of antares-inject.ts's main IIFE,
// so its absence proves an early-boot exception killed the script.
//
// Why this test catches the kind of bug PR #506/#510 introduced:
//   1. Schema drift / bundler issue / import failure / Sentry init
//      crash all manifest as "content script never finishes execution"
//   2. Without the GUARD attribute, every successive condition in
//      antares-inject.ts (createHost, MutationObserver, scan poll)
//      never fires
//   3. The user sees "nothing happens when I open DexScreener" — which
//      is exactly the symptom incident #510 produced
//
// Test environment notes:
//   - Uses launchPersistentContext (extension API requires it)
//   - Headed browser required (Chrome refuses to load --load-extension
//     in fully headless mode pre-MV3-headless-stable)
//   - Skipped in CI when CHROMIUM_HEADLESS=true unless the runner has
//     xvfb / a display; the GitHub Actions ubuntu-latest runner has
//     xvfb-action so this can be enabled later (see ci.yml).

import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import path from "path";

const EXTENSION_PATH = path.resolve(__dirname, "..", "build", "chrome-mv3-prod");

// Pump.fun is the most stable host_permission target — flat HTML page
// with predictable URL routing, lower bot-detection vs Dexscreener,
// and quickest to load in a headed browser. We don't need real token
// data on the page — we just need ANY matching URL so Chrome decides
// to inject the content script per the `matches:` list.
const TEST_URL = "https://pump.fun/";

// Allowlist of console errors we tolerate without failing the test.
// These are noise from Chrome itself or upstream pages, not signals
// of an extension boot failure.
const CONSOLE_NOISE_PATTERNS = [
  /favicon\.ico/i,
  /chrome-extension:\/\/.*\.well-known/i,
  // Cross-origin frame errors from upstream embedded iframes
  /blocked by CORS/i,
  // Upstream sites' own analytics / 3rd-party stuff
  /facebook|google-analytics|gtag|hotjar|segment|datadog/i,
];

test.describe("Extension — overlay mount smoke", () => {
  // Skip in CI by default — requires headed Chrome + display server.
  // Local dev runs this with `npm run test:e2e -- --project=extension`.
  test.skip(
    !!process.env.CI,
    "Extension smoke test requires headed Chrome — skipped in CI until xvfb wiring lands"
  );

  let context: BrowserContext;
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--disable-default-apps",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    // Wait for the extension service worker to register — without it,
    // chrome.* APIs the content script depends on won't be available
    // when antares-inject.ts runs.
    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }

    page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (CONSOLE_NOISE_PATTERNS.some((rx) => rx.test(text))) return;
      consoleErrors.push(text);
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
    });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("content script boots without throwing — GUARD attribute set on <html>", async () => {
    // Navigate to a host_permission match. Use `domcontentloaded` not
    // `networkidle` because Pump.fun has long-lived WebSocket
    // connections that prevent networkidle from ever firing.
    await page.goto(TEST_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // antares-inject.ts runs at document_idle. Give it up to 10s to
    // execute its top-level + GUARD-setting block. If it ever throws
    // during init (the failure mode of incident PR #510), the GUARD
    // attribute never gets set and this wait times out.
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-antares-init"),
      undefined,
      { timeout: 10_000 }
    );

    const guardValue = await page.getAttribute("html", "data-antares-init");
    expect(guardValue).toBe("1");
  });

  test("no uncaught exceptions logged during boot", async () => {
    // After the GUARD assertion above, give the script one more tick
    // to surface any async errors from the createHost / hostObserver
    // / scan-poll initialisation chain.
    await page.waitForTimeout(2_000);

    // Filter once more — pages can log late noise during this window.
    const meaningful = consoleErrors.filter(
      (e) => !CONSOLE_NOISE_PATTERNS.some((rx) => rx.test(e))
    );

    // If this fails, the snapshot of meaningful errors is in the
    // assertion message — that's enough to diagnose without re-running.
    expect(
      meaningful,
      `Content script logged uncaught errors during boot:\n${meaningful
        .map((e) => `  - ${e}`)
        .join("\n")}`
    ).toEqual([]);
  });

  test("overlay shadow host gets attached to <html>", async () => {
    // createHost() appends a shadow-root host element directly to
    // documentElement. Its presence is the second checkpoint that
    // initialisation reached the visible-UI stage, not just the
    // import-time scrub of antares-inject.ts.
    const hostExists = await page.evaluate(() => {
      // The exact tag/id is private to components.ts but we know it
      // sits as a direct child of <html> (not <body>) so DOM-tree
      // mutations on the page can't strip it without the
      // MutationObserver re-creating it.
      const children = Array.from(document.documentElement.children);
      return children.some(
        (el) =>
          (el as HTMLElement).id?.startsWith("ant-") ||
          (el as HTMLElement).shadowRoot != null
      );
    });

    expect(hostExists).toBe(true);
  });
});
