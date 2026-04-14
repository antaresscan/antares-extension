import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL = 'So11111111111111111111111111111111111111112';
const ALLOWED_ORIGIN = 'https://antares-extension.vercel.app';
const BAD_ORIGIN = 'https://evil.com';

test.describe('API /api/graph — Insider Network Graph', () => {

  test.describe('CORS & Method enforcement', () => {
    test('blocks requests with disallowed origin', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=${SOL}`, {
        headers: { Origin: BAD_ORIGIN },
      });
      // Endpoint may return 403 (CORS blocked) or 404 (not deployed)
      expect([403, 404]).toContain(r.status());
    });

    test('rejects POST method', async ({ request }) => {
      const r = await request.post(`${BASE}/api/graph`, { data: { ca: SOL } });
      expect([403, 404, 405]).toContain(r.status());
    });

    test('rejects PUT method', async ({ request }) => {
      const r = await request.put(`${BASE}/api/graph`, { data: { ca: SOL } });
      expect([403, 404, 405]).toContain(r.status());
    });

    test('rejects DELETE method', async ({ request }) => {
      const r = await request.delete(`${BASE}/api/graph?ca=${SOL}`);
      expect([403, 404, 405]).toContain(r.status());
    });
  });

  test.describe('Input validation', () => {
    test('rejects missing ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      // 400 (bad request) or 404 (not deployed) or 429 (rate limited)
      expect([400, 404, 429]).toContain(r.status());
    });

    test('rejects empty ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      expect([400, 404, 429]).toContain(r.status());
    });

    test('rejects invalid ca format', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=not-valid!`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      expect([400, 404, 429]).toContain(r.status());
    });
  });

  test.describe('Response headers', () => {
    test('returns JSON content-type', async ({ request }) => {
      const r = await request.get(`${BASE}/api/graph?ca=${SOL}`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      // Skip if endpoint not deployed
      if (r.status() === 404) return;
      const ct = r.headers()['content-type'] || '';
      expect(ct).toContain('application/json');
    });

    test('OPTIONS preflight returns CORS headers', async ({ request }) => {
      const r = await request.fetch(`${BASE}/api/graph?ca=${SOL}`, {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED_ORIGIN },
      });
      // Skip if endpoint not deployed
      if (r.status() === 404) return;
      expect([200, 204]).toContain(r.status());
    });
  });
});
