import { test, expect } from '@playwright/test';

const LANDING_URL = process.env.LANDING_URL || 'https://antares-extension.vercel.app';

test.describe('Landing Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(LANDING_URL);
  });

  test('should load the landing page', async ({ page }) => {
    await expect(page).toHaveTitle(/Antares/i);
  });

  test('should display hero section', async ({ page }) => {
    const hero = page.locator('h1').first();
    await expect(hero).toBeVisible();
  });

  test('should have a working CTA button', async ({ page }) => {
    const cta = page.getByRole('link', { name: /get started|install|try|download/i }).first();
    await expect(cta).toBeVisible();
    const href = await cta.getAttribute('href');
    expect(href).toBeTruthy();
  });

  test('should be responsive on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(LANDING_URL);
    const hero = page.locator('h1').first();
    await expect(hero).toBeVisible();
  });

  test('should have no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(LANDING_URL);
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });

  test('should load within acceptable time', async ({ page }) => {
    const start = Date.now();
    await page.goto(LANDING_URL, { waitUntil: 'domcontentloaded' });
    const loadTime = Date.now() - start;
    expect(loadTime).toBeLessThan(5000);
  });
});
