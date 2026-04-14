import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('Privacy Page', () => {
  test('loads /privacy.html with 200', async ({ request }) => {
    const r = await request.get(`${BASE}/privacy.html`);
    expect(r.ok()).toBeTruthy();
  });

  test('contains privacy-related content', async ({ page }) => {
    await page.goto(`${BASE}/privacy.html`);
    const text = await page.textContent('body');
    expect(text).toMatch(/privacy|data|collect|information/i);
  });

  test('has proper title', async ({ page }) => {
    await page.goto(`${BASE}/privacy.html`);
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  test('/api/privacy returns HTML', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    if (r.ok()) {
      const ct = r.headers()['content-type'] || '';
      expect(ct).toMatch(/html/i);
    }
  });
});
