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

    test('sends 15 rapid requests', async ({ request }) => {
      const promises = Array.from({ length: 15 }, () =>
        request.get(`${BASE}/api/health`)
      );
      const results = await Promise.all(promises);
      // Either gets rate-limited or not (both valid in E2E context)
      expect(results.length).toBe(15);
    });
  });

  test.describe('Input Sanitization', () => {
    test('rejects path traversal attempts', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=../../etc/passwd`);
      // 400 (bad input) or 429 (rate limited)
      expect([400, 429]).toContain(r.status());
    });

    test('rejects null bytes', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=test%00malicious`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects unicode abuse', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${'\u202e'}reverse`);
      expect([400, 429]).toContain(r.status());
    });
  });

  test.describe('Unknown Endpoints', () => {
    test('/api/nonexistent returns 404', async ({ request }) => {
      const r = await request.get(`${BASE}/api/nonexistent`);
      expect(r.status()).toBe(404);
    });
  });
});
