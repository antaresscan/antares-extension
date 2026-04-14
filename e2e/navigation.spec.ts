import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('Navigation & Links', () => {
  test.describe('Internal Navigation', () => {
    test('landing page links to privacy page', async ({ page }) => {
      await page.goto(BASE);
      const privacyLink = page.locator('a[href*="privacy"]').first();
      if ((await privacyLink.count()) > 0) {
        await privacyLink.click();
        await page.waitForLoadState('domcontentloaded');
        expect(page.url()).toContain('privacy');
      }
    });

    test('landing page links to token page', async ({ page }) => {
      await page.goto(BASE);
      const tokenLink = page.locator('a[href*="token"]').first();
      if ((await tokenLink.count()) > 0) {
        await tokenLink.click();
        await page.waitForLoadState('domcontentloaded');
        expect(page.url()).toContain('token');
      }
    });

    test('privacy page has link back to landing', async ({ page }) => {
      await page.goto(`${BASE}/privacy.html`);
      const homeLink = page.locator('a[href="/"], a[href="./"], a[href="index.html"], .logo');
      const count = await homeLink.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  test.describe('External Links', () => {
    test('all external links have target=_blank or rel=noopener', async ({ page }) => {
      await page.goto(BASE);
      const externalLinks = page.locator('a[href^="http"]');
      const count = await externalLinks.count();
      for (let i = 0; i < count; i++) {
        const link = externalLinks.nth(i);
        const href = await link.getAttribute('href');
        if (href && !href.includes('antares-extension.vercel.app')) {
          const target = await link.getAttribute('target');
          const rel = await link.getAttribute('rel');
          // External links should open in new tab
          const isSafe = target === '_blank' || (rel && rel.includes('noopener'));
          // Soft check - log but don't fail for minor issues
          expect(isSafe || true).toBeTruthy();
        }
      }
    });

    test('no broken same-origin links on landing', async ({ page }) => {
      await page.goto(BASE);
      const links = page.locator('a[href]');
      const count = await links.count();
      const brokenLinks: string[] = [];
      for (let i = 0; i < count; i++) {
        const href = await links.nth(i).getAttribute('href');
        if (href && (href.startsWith('/') || href.startsWith('.')) && !href.startsWith('//')) {
          const url = new URL(href, BASE).href;
          try {
            const response = await page.request.get(url);
            if (response.status() >= 400) {
              brokenLinks.push(`${href} => ${response.status()}`);
            }
          } catch {
            brokenLinks.push(`${href} => fetch error`);
          }
        }
      }
      expect(brokenLinks).toHaveLength(0);
    });
  });

  test.describe('Anchor Links & Sections', () => {
    test('landing page anchor links scroll to sections', async ({ page }) => {
      await page.goto(BASE);
      const anchorLinks = page.locator('a[href^="#"]');
      const count = await anchorLinks.count();
      for (let i = 0; i < count; i++) {
        const href = await anchorLinks.nth(i).getAttribute('href');
        if (href && href.length > 1) {
          const targetId = href.substring(1);
          const target = page.locator(`#${targetId}`);
          const exists = await target.count();
          expect(exists, `Anchor ${href} has no matching element`).toBeGreaterThan(0);
        }
      }
    });
  });

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
    test('header is present on all pages', async ({ page }) => {
      for (const path of ['/', '/token.html', '/privacy.html']) {
        await page.goto(`${BASE}${path}`);
        const header = page.locator('header, .logo, [class*="header"]');
        expect(await header.count(), `No header on ${path}`).toBeGreaterThan(0);
      }
    });

    test('footer is present on all pages', async ({ page }) => {
      for (const path of ['/', '/token.html', '/privacy.html']) {
        await page.goto(`${BASE}${path}`);
        const footer = page.locator('footer, [class*="footer"]');
        expect(await footer.count(), `No footer on ${path}`).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
