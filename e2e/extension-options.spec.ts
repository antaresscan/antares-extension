import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';

const EXTENSION_PATH = path.resolve(__dirname, '..', 'build', 'chrome-mv3-prod');

/**
 * Extension E2E tests require a built extension at build/chrome-mv3-prod.
 * These tests are skipped in CI unless the build artifact exists.
 * Run locally: npx plasmo build && npx playwright test --project=extension
 *
 * The extension has no popup any more: popup.tsx was deleted on 2026-04-05
 * (commit 666d9ba) so the toolbar icon fires chrome.action.onClicked. The
 * Options page is covered in CI by `npm run smoke`
 * (scripts/smoke-options.mjs); this spec checks it in a real Chrome.
 */
test.describe('Chrome Extension — service worker and Options page', () => {
  let context: BrowserContext;
  let extensionId: string;

  test.skip(
    !!process.env.CI,
    'Extension tests require headed browser + built extension — skipped in CI'
  );

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
    });

    // Wait for service worker to register and get extension ID
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sw: any;
    if (context.serviceWorkers().length === 0) {
      sw = await context.waitForEvent('serviceworker');
    } else {
      sw = context.serviceWorkers()[0];
    }
    extensionId = sw.url().split('/')[2];
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('extension loads and has service worker', async () => {
    expect(extensionId).toBeTruthy();
    expect(extensionId.length).toBeGreaterThan(10);
  });

  test('options page renders the settings UI without errors', async () => {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForLoadState('domcontentloaded');

    // A non-empty <body> proves nothing (options.html ships an empty
    // #__plasmo): the settings heading only exists once React mounted.
    // On 2026-10-09 a react / react-dom mismatch left this page blank.
    await expect(page.getByRole('heading', { name: 'Antares Scanner Settings' })).toBeVisible();
    expect(pageErrors).toEqual([]);
    await page.close();
  });
});
