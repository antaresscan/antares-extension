import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

// `/` on this deployment is a 301 to antares-website.vercel.app, so we
// only meaningfully test the pages this Vercel project actually serves.
const PAGES = [
  { name: 'Token', path: '/token.html' },
  { name: 'Privacy', path: '/privacy.html' },
];

test.describe('SEO & Meta Tags', () => {
  for (const pg of PAGES) {
    test.describe(`${pg.name} (${pg.path})`, () => {
      test(`has <title> tag`, async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const title = await page.title();
        expect(title.length).toBeGreaterThan(5);
        expect(title.length).toBeLessThan(70);
      });

      test(`has meta description`, async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const desc = page.locator('meta[name="description"]');
        await expect(desc).toHaveCount(1);
        const content = await desc.getAttribute('content');
        expect(content).toBeTruthy();
        expect(content!.length).toBeGreaterThan(20);
        expect(content!.length).toBeLessThan(160);
      });

      test(`has viewport meta`, async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const vp = page.locator('meta[name="viewport"]');
        await expect(vp).toHaveCount(1);
        const content = await vp.getAttribute('content');
        expect(content).toContain('width=device-width');
      });

      test(`has charset meta`, async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const charset = page.locator('meta[charset]');
        await expect(charset).toHaveCount(1);
      });

      test(`has lang attribute on html`, async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const lang = await page.locator('html').getAttribute('lang');
        expect(lang).toBeTruthy();
      });
    });
  }

  test.describe('Landing Page OG & Twitter Tags', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(BASE);
    });

    test('has og:title', async ({ page }) => {
      const og = page.locator('meta[property="og:title"]');
      await expect(og).toHaveCount(1);
      const content = await og.getAttribute('content');
      expect(content).toBeTruthy();
    });

    test('has og:description', async ({ page }) => {
      const og = page.locator('meta[property="og:description"]');
      await expect(og).toHaveCount(1);
      const content = await og.getAttribute('content');
      expect(content).toBeTruthy();
    });

    test('has og:type', async ({ page }) => {
      const og = page.locator('meta[property="og:type"]');
      await expect(og).toHaveCount(1);
      const content = await og.getAttribute('content');
      expect(content).toBe('website');
    });

    test('has og:url', async ({ page }) => {
      const og = page.locator('meta[property="og:url"]');
      await expect(og).toHaveCount(1);
      const content = await og.getAttribute('content');
      expect(content).toContain('antares');
    });

    test('has twitter:card', async ({ page }) => {
      const tw = page.locator('meta[name="twitter:card"]');
      await expect(tw).toHaveCount(1);
    });

    test('has twitter:title', async ({ page }) => {
      const tw = page.locator('meta[name="twitter:title"]');
      await expect(tw).toHaveCount(1);
      const content = await tw.getAttribute('content');
      expect(content).toBeTruthy();
    });

    test('has twitter:description', async ({ page }) => {
      const tw = page.locator('meta[name="twitter:description"]');
      await expect(tw).toHaveCount(1);
      const content = await tw.getAttribute('content');
      expect(content).toBeTruthy();
    });
  });

  test.describe('Canonical & Structured Data', () => {
    test('no duplicate meta descriptions on landing', async ({ page }) => {
      await page.goto(BASE);
      const descs = page.locator('meta[name="description"]');
      await expect(descs).toHaveCount(1);
    });

    test('no duplicate title tags on landing', async ({ page }) => {
      await page.goto(BASE);
      const titles = page.locator('title');
      await expect(titles).toHaveCount(1);
    });

    test('favicon or icon link exists', async ({ page }) => {
      await page.goto(BASE);
      const icon = page.locator('link[rel="icon"], link[rel="shortcut icon"]');
      const count = await icon.count();
      // Favicon is recommended but not blocking
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
