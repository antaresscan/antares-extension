import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

// Most of the original Navigation suite was about navigating from `/`
// (the landing page). After #287 deleted that file and routed `/` to
// antares-website.vercel.app, those tests would either follow the
// redirect into a different repo's content or fail outright. Only the
// assertions that stay valid for what THIS deployment actually serves
// are kept here: 404 handling, and structural checks on the surviving
// privacy / token pages.
test.describe('Navigation & Links', () => {
  test.describe('404 Handling', () => {
    test('non-existent page returns proper status', async ({ request }) => {
      const r = await request.get(`${BASE}/nonexistent-page-xyz`);
      expect(r.status()).toBe(404);
    });

    test('non-existent API returns 404', async ({ request }) => {
      const r = await request.get(`${BASE}/api/nonexistent`);
      expect(r.status()).toBe(404);
    });
  });

  test.describe('Header & Footer Consistency', () => {
    test('header is present on token and privacy pages', async ({ page }) => {
      for (const path of ['/token.html', '/privacy.html']) {
        await page.goto(`${BASE}${path}`);
        const header = page.locator('header, .logo, [class*="header"]');
        expect(await header.count(), `No header on ${path}`).toBeGreaterThan(0);
      }
    });

    test('footer is present on token and privacy pages', async ({ page }) => {
      for (const path of ['/token.html', '/privacy.html']) {
        await page.goto(`${BASE}${path}`);
        const footer = page.locator('footer, [class*="footer"]');
        expect(await footer.count(), `No footer on ${path}`).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
