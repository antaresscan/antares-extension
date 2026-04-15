import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL = 'So11111111111111111111111111111111111111112';

test.describe('API /api/graph \u2014 Insider Network Graph', () => {

  test.describe('CORS & Method enforcement', () => {
    test('responds to requests with non-allowed origin', async ({ playwright }) => {
      const ctx = await playwright.request.newContext({
        extraHTTPHeaders: { 'Origin': 'https://evil.com' },
      });
      const r = await ctx.get(`${BASE}/api/graph?ca=${SOL}`);
      // Vercel serverless functions may still return data even with wrong Origin
      // (CORS is enforced by browsers, not servers). Accept 200 or 403.
      expect([200, 403]).toContain(r.status());
      await ctx.dispose();
    });

    test('rejects POST method', async ({ request }) => {
      const r = await request.post(`${BASE}/api/graph`, { data: { ca: SOL } });
      expect([403, 405]).toContain(r.status());
    });

    test('rejects PUT method', async ({ request }) => {
      const r = await request.put(`${BASE}/api/graph`, { data: { ca: SOL } });
      expect([403, 405]).toContain(r.status());
    });

    test('rejects DELETE method', async ({ request }) => {
      const r = await request.delete(`${BASE}/api/graph?ca=${SOL}`);
      expect([403, 405]).toContain(r.status());
    });
  });

  test.describe('Input validation', () => {
    test('rejects missing ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph`);
      expect([400, 403]).toContain(r.status());
    });

    test('rejects empty ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=`);
      expect([400, 403]).toContain(r.status());
    });

    test('rejects invalid ca format', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=not-valid`);
      expect([400, 403]).toContain(r.status());
    });
  });

  test.describe('Response headers', () => {
    test('returns JSON content-type', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=${SOL}`);
      expect(r.headers()['content-type']).toContain('application/json');
    });

    test('has security headers', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=${SOL}`);
      expect(r.headers()['x-content-type-options']).toBe('nosniff');
      expect(r.headers()['x-frame-options']).toBe('DENY');
    });
  });
});
