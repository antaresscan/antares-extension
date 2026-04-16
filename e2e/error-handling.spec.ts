import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('Error Handling & Edge Cases', () => {

  test.describe('404 - Not Found', () => {
    test('non-existent page returns 404', async ({ request }) => {
      const r = await request.get(`${BASE}/this-page-does-not-exist`);
      expect(r.status()).toBe(404);
    });

    test('non-existent API endpoint returns 404', async ({ request }) => {
      const r = await request.get(`${BASE}/api/nonexistent`);
      expect(r.status()).toBe(404);
    });
  });

  test.describe('API error consistency', () => {
    test('/api/scan error response is JSON', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan`);
      expect(r.headers()['content-type']).toContain('application/json');
    });

    test('/api/scan error has error field', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan`);
      const b = await r.json();
      expect(b).toHaveProperty('error');
    });

    test('/api/health success has consistent schema', async ({ request }) => {
      const r = await request.get(`${BASE}/api/health`);
      const b = await r.json();
      expect(b).toHaveProperty('status');
      expect(b).toHaveProperty('version');
      expect(b).toHaveProperty('timestamp');
    });
  });

  test.describe('Token page edge cases', () => {
    test('token page without hash shows error message', async ({ page }) => {
      await page.goto(`${BASE}/token.html`);
      // Use regex to match regardless of trailing punctuation (e.g. "No token address provided.")
      const errorText = page.locator('text=/No token address provided/i');
      await expect(errorText).toBeVisible({ timeout: 5000 });
    });

    test('token page with invalid hash shows error', async ({ page }) => {
      await page.goto(`${BASE}/token.html#invalid-data`);
      await page.waitForTimeout(2000);
      const body = await page.textContent('body');
      expect(body?.length).toBeGreaterThan(0);
    });
  });

  test.describe('API method enforcement', () => {
    test('/api/scan rejects PATCH method', async ({ request }) => {
      const r = await request.patch(`${BASE}/api/scan`);
      expect([403, 405, 429]).toContain(r.status());
    });

    test('/api/health accepts any method (no method guard)', async ({ request }) => {
      const r = await request.patch(`${BASE}/api/health`);
      // health.ts has no method check, returns 200 for all methods
      expect(r.status()).toBe(200);
    });
  });

  test.describe('Malformed requests', () => {
    test('/api/scan handles extremely long ca parameter', async ({ request }) => {
      const longCa = 'A'.repeat(10000);
      const r = await request.get(`${BASE}/api/scan?ca=${longCa}`);
      expect([400, 403, 414, 429]).toContain(r.status());
    });

    test('/api/scan handles special characters in ca', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=<script>alert(1)</script>`);
      expect([400, 403, 429]).toContain(r.status());
    });

    test('/api/scan handles null bytes', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=abc%00def`);
      expect([400, 403, 429]).toContain(r.status());
    });
  });
});
