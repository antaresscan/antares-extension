import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
// POPCAT instead of WSOL — see api-scan.spec.ts for rationale (WSOL
// times out the prod /api/scan budget). Variable name kept for diff
// continuity.
const SOL_WRAPPED = 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82';

test.describe('Token Page (/token.html)', () => {
  test('loads token page with valid ca', async ({ page }) => {
    await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveTitle(/Antares|Token|Analysis/i);
  });

  test('displays token analysis content', async ({ page }) => {
    await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
    await page.waitForLoadState('networkidle');
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });

  test('has proper meta tags', async ({ page }) => {
    await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('width=device-width');
  });

  test('handles missing ca parameter gracefully', async ({ page }) => {
    await page.goto(`${BASE}/token.html`);
    await page.waitForLoadState('domcontentloaded');
    // Page should still load without crashing
    expect(await page.title()).toBeTruthy();
  });

  test('handles invalid ca parameter', async ({ page }) => {
    await page.goto(`${BASE}/token.html?ca=INVALID`);
    await page.waitForLoadState('domcontentloaded');
    expect(await page.title()).toBeTruthy();
  });

  test('no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`, { waitUntil: 'networkidle' });
    const critical = errors.filter(e => !e.includes('favicon'));
    expect(critical).toHaveLength(0);
  });
});
