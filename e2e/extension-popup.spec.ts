import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';

const EXTENSION_PATH = path.resolve(__dirname, '..', 'build', 'chrome-mv3-prod');

/**
 * Extension E2E tests require a built extension at build/chrome-mv3-prod.
 * These tests are skipped in CI unless the build artifact exists.
 * Run locally: npx plasmo build && npx playwright test --project=extension
 */
test.describe('Chrome Extension — Popup', () => {
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

  test('popup page opens without errors', async () => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForLoadState('domcontentloaded');

    // Popup should have some content
    const body = await page.textContent('body');
    expect(body).toBeTruthy();

    // Filter out expected chrome extension errors
    const critical = errors.filter(e => !e.includes('chrome.runtime'));
    expect(critical).toHaveLength(0);
    await page.close();
  });

  test('popup displays Antares branding', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForLoadState('domcontentloaded');
    const text = await page.textContent('body');
    expect(text?.toLowerCase()).toContain('antares');
    await page.close();
  });

  test('popup has scan or recent scans section', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForLoadState('networkidle');
    const body = await page.textContent('body');
    const hasScanContent = /scan|recent|token|score|safe|danger/i.test(body || '');
    expect(hasScanContent).toBe(true);
    await page.close();
  });

  test('options page loads', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForLoadState('domcontentloaded');
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
    await page.close();
  });
});
