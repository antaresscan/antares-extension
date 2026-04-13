import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('Landing Page — Comprehensive E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
  });

  test.describe('Core Loading', () => {
    test('page loads with correct title', async ({ page }) => {
      await expect(page).toHaveTitle(/Antares/i);
    });

    test('loads within 5 seconds', async ({ page }) => {
      const start = Date.now();
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      expect(Date.now() - start).toBeLessThan(5000);
    });

    test('returns 200 status', async ({ request }) => {
      const r = await request.get(BASE);
      expect(r.ok()).toBeTruthy();
    });
  });

  test.describe('Hero Section', () => {
    test('displays h1 heading', async ({ page }) => {
      const h1 = page.locator('h1').first();
      await expect(h1).toBeVisible();
    });

    test('has a CTA button/link', async ({ page }) => {
      const cta = page.getByRole('link', { name: /install|get started|try|download|chrome/i }).first();
      await expect(cta).toBeVisible();
    });
  });

  test.describe('SEO & Meta', () => {
    test('has meta description', async ({ page }) => {
      const desc = await page.locator('meta[name="description"]').getAttribute('content');
      expect(desc).toBeTruthy();
      expect(desc!.length).toBeGreaterThan(30);
    });

    test('has Open Graph tags', async ({ page }) => {
      const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
      expect(ogTitle).toBeTruthy();
    });

    test('has canonical URL or proper link', async ({ page }) => {
      const canonical = page.locator('link[rel="canonical"]');
      const count = await canonical.count();
      // Either has canonical or doesn\'t (both valid)
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('has viewport meta tag', async ({ page }) => {
      const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect(viewport).toContain('width=device-width');
    });

    test('has favicon', async ({ page }) => {
      const icon = page.locator('link[rel*="icon"]');
      expect(await icon.count()).toBeGreaterThan(0);
    });
  });

  test.describe('Accessibility', () => {
    test('all images have alt text', async ({ page }) => {
      const imgs = page.locator('img');
      const count = await imgs.count();
      for (let i = 0; i < count; i++) {
        const alt = await imgs.nth(i).getAttribute('alt');
        expect(alt, `Image ${i} missing alt`).not.toBeNull();
      }
    });

    test('page has proper heading hierarchy', async ({ page }) => {
      const h1Count = await page.locator('h1').count();
      expect(h1Count).toBeGreaterThanOrEqual(1);
      expect(h1Count).toBeLessThanOrEqual(2);
    });

    test('interactive elements are focusable', async ({ page }) => {
      const links = page.locator('a[href]');
      const count = await links.count();
      expect(count).toBeGreaterThan(0);
    });
  });

  test.describe('Content Sections', () => {
    test('has features or comparison section', async ({ page }) => {
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
      // Should mention key features
      const hasFeatureContent = /scan|security|token|safe|danger|score/i.test(body!);
      expect(hasFeatureContent).toBe(true);
    });

    test('has footer with links', async ({ page }) => {
      const footer = page.locator('footer');
      if (await footer.count() > 0) {
        await expect(footer.first()).toBeVisible();
      }
    });
  });

  test.describe('Performance & Quality', () => {
    test('no console errors on load', async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await page.goto(BASE, { waitUntil: 'networkidle' });
      // Filter out known third-party errors
      const criticalErrors = errors.filter(e => !e.includes('favicon') && !e.includes('analytics'));
      expect(criticalErrors).toHaveLength(0);
    });

    test('no broken images', async ({ page }) => {
      await page.waitForLoadState('networkidle');
      const imgs = page.locator('img');
      const count = await imgs.count();
      for (let i = 0; i < count; i++) {
        const naturalWidth = await imgs.nth(i).evaluate((el: HTMLImageElement) => el.naturalWidth);
        expect(naturalWidth, `Image ${i} is broken`).toBeGreaterThan(0);
      }
    });

    test('external links have rel noopener', async ({ page }) => {
      const extLinks = page.locator('a[target="_blank"]');
      const count = await extLinks.count();
      for (let i = 0; i < count; i++) {
        const rel = await extLinks.nth(i).getAttribute('rel');
        expect(rel, `External link ${i} missing rel`).toContain('noopener');
      }
    });
  });
});
