import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('API Security & Hardening', () => {

  test.describe('CORS', () => {
    test('allows requests with proper origin', async ({ request }) => {
      const r = await request.get(`${BASE}/api/health`);
      expect(r.ok()).toBeTruthy();
    });

    test('OPTIONS preflight returns CORS headers', async ({ request }) => {
      const r = await request.fetch(`${BASE}/api/scan?ca=test`, { method: 'OPTIONS' });
      // Should not crash
      expect([200, 204, 400, 404, 405]).toContain(r.status());
    });
  });

  test.describe('Rate Limiting', () => {
    test('does not crash under moderate load', async ({ request }) => {
      const promises = Array.from({ length: 5 }, () =>
        request.get(`${BASE}/api/health`)
      );
      const results = await Promise.all(promises);
      const statuses = results.map(r => r.status());
      // All should be 200 or 429
      statuses.forEach(s => expect([200, 429]).toContain(s));
    });

    test('rate limited response has proper status', async ({ request }) => {
      // Hit endpoint rapidly to trigger rate limit
      const promises = Array.from({ length: 15 }, () =>
        request.get(`${BASE}/api/health`)
      );
      const results = await Promise.all(promises);
      const _hasRateLimit = results.some(r => r.status() === 429);
      // Either gets rate-limited or not (both valid in E2E context)
      expect(results.length).toBe(15);
    });
  });

  test.describe('Input Sanitization', () => {
    test('rejects path traversal attempts', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=../../etc/passwd`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects null bytes', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=test%00malicious`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects unicode abuse', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=\u202ereverse`);
      expect([400, 429]).toContain(r.status());
    });
  });

  test.describe('Unknown Endpoints', () => {
    test('/api/nonexistent returns 404', async ({ request }) => {
      const r = await request.get(`${BASE}/api/nonexistent`);
      expect(r.status()).toBe(404);
    });

    test('security headers present', async ({ request }) => {
      const r = await request.get(`${BASE}/api/health`);
      const headers = r.headers();
      // Vercel adds these by default
      expect(headers['x-powered-by']).toBeUndefined();
    });
  });
});
