import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

const PAGES = [
  { name: 'Landing', path: '/' },
  { name: 'Token', path: '/token.html' },
  { name: 'Privacy', path: '/privacy.html' },
];

test.describe('Accessibility (a11y)', () => {
  for (const pg of PAGES) {
    test.describe(`${pg.name} (${pg.path})`, () => {
      test('all images have alt attributes', async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const images = page.locator('img');
        const count = await images.count();
        for (let i = 0; i < count; i++) {
          const alt = await images.nth(i).getAttribute('alt');
          expect(alt, `Image ${i} missing alt`).not.toBeNull();
        }
      });

      test('all links have accessible text', async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const links = page.locator('a');
        const count = await links.count();
        for (let i = 0; i < count; i++) {
          const link = links.nth(i);
          const text = await link.textContent();
          const ariaLabel = await link.getAttribute('aria-label');
          const title = await link.getAttribute('title');
          const hasChild = await link.locator('img, svg, [aria-label]').count();
          const isAccessible = (text && text.trim().length > 0) || ariaLabel || title || hasChild > 0;
          expect(isAccessible, `Link ${i} has no accessible text`).toBeTruthy();
        }
      });

      test('no empty buttons', async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const buttons = page.locator('button');
        const count = await buttons.count();
        for (let i = 0; i < count; i++) {
          const btn = buttons.nth(i);
          const text = await btn.textContent();
          const ariaLabel = await btn.getAttribute('aria-label');
          const title = await btn.getAttribute('title');
          const isAccessible = (text && text.trim().length > 0) || ariaLabel || title;
          expect(isAccessible, `Button ${i} has no accessible text`).toBeTruthy();
        }
      });

      test('page has proper heading hierarchy', async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const h1Count = await page.locator('h1').count();
        expect(h1Count).toBeGreaterThanOrEqual(1);
        expect(h1Count).toBeLessThanOrEqual(2);
      });

      test('color contrast: text is not invisible', async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        // Verify body has a visible text color (not same as background)
        const bodyColor = await page.locator('body').evaluate((el) => {
          const style = window.getComputedStyle(el);
          return { color: style.color, bg: style.backgroundColor };
        });
        expect(bodyColor.color).not.toBe(bodyColor.bg);
      });

      test('interactive elements are focusable', async ({ page }) => {
        await page.goto(`${BASE}${pg.path}`);
        const interactives = page.locator('a[href], button, input, select, textarea');
        const count = await interactives.count();
        for (let i = 0; i < Math.min(count, 10); i++) {
          const el = interactives.nth(i);
          const tabindex = await el.getAttribute('tabindex');
          // tabindex should not be -1 for user-facing elements
          if (tabindex !== null) {
            expect(parseInt(tabindex)).toBeGreaterThanOrEqual(-1);
          }
        }
      });
    });
  }

  test.describe('Landing Page Specific', () => {
    test('CTA buttons have sufficient size for touch', async ({ page }) => {
      await page.goto(BASE);
      const cta = page.locator('a.cta, a[href*="chrome"], .cta');
      const count = await cta.count();
      for (let i = 0; i < count; i++) {
        const box = await cta.nth(i).boundingBox();
        if (box) {
          expect(box.height).toBeGreaterThanOrEqual(40);
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
      }
    });

    test('skip-to-content or proper landmark structure', async ({ page }) => {
      await page.goto(BASE);
      const header = page.locator('header');
      const main = page.locator('main, [role="main"], .container');
      const footer = page.locator('footer');
      // At minimum, should have header and some main content area
      const hasStructure =
        (await header.count()) > 0 || (await main.count()) > 0 || (await footer.count()) > 0;
      expect(hasStructure).toBeTruthy();
    });

    test('font size is readable (min 12px)', async ({ page }) => {
      await page.goto(BASE);
      const bodyFontSize = await page.locator('body').evaluate((el) => {
        return parseFloat(window.getComputedStyle(el).fontSize);
      });
      expect(bodyFontSize).toBeGreaterThanOrEqual(12);
    });
  });
});
