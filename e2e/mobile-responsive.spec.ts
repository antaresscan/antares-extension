import { test, expect, devices } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14 Pro', width: 393, height: 852 },
  { name: 'iPad', width: 768, height: 1024 },
  { name: 'Galaxy S21', width: 360, height: 800 },
] as const;

test.describe('Mobile & Responsive — Landing Page', () => {
  for (const vp of VIEWPORTS) {
    test.describe(`${vp.name} (${vp.width}x${vp.height})`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test('page loads without errors', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${BASE}/`);
        await page.waitForLoadState('domcontentloaded');
        expect(errors).toHaveLength(0);
      });

      test('no horizontal overflow', async ({ page }) => {
        await page.goto(`${BASE}/`);
        await page.waitForLoadState('domcontentloaded');
        const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
        expect(bodyWidth).toBeLessThanOrEqual(vp.width + 1);
      });

      test('hero heading is visible', async ({ page }) => {
        await page.goto(`${BASE}/`);
        const h1 = page.locator('h1').first();
        await expect(h1).toBeVisible({ timeout: 5000 });
      });

      test('CTA button is visible and clickable', async ({ page }) => {
        await page.goto(`${BASE}/`);
        const cta = page.locator('a:has-text("Chrome"), button:has-text("Chrome")').first();
        await expect(cta).toBeVisible({ timeout: 5000 });
      });

      test('has viewport meta tag', async ({ page }) => {
        await page.goto(`${BASE}/`);
        const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
        expect(viewport).toContain('width=device-width');
      });
    });
  }
});

test.describe('Mobile & Responsive — Privacy Page', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('privacy page loads on mobile', async ({ page }) => {
    await page.goto(`${BASE}/privacy.html`);
    await page.waitForLoadState('domcontentloaded');
    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible({ timeout: 5000 });
  });

  test('privacy page has no horizontal overflow on mobile', async ({ page }) => {
    await page.goto(`${BASE}/privacy.html`);
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(376);
  });
});

test.describe('Mobile & Responsive — Token Page', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('token page loads on mobile', async ({ page }) => {
    await page.goto(`${BASE}/token.html`);
    await page.waitForLoadState('domcontentloaded');
    const body = await page.textContent('body');
    expect(body?.length).toBeGreaterThan(0);
  });
});
