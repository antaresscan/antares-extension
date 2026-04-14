import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('API /api/rugs — Wall of Shame', () => {

  test.describe('CORS enforcement', () => {
    test('blocks requests from non-allowed origins', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`);
      expect(r.status()).toBe(403);
      const b = await r.json();
      expect(b.error).toBeTruthy();
    });
  });

  test.describe('Method enforcement', () => {
    test('rejects POST method', async ({ request }) => {
      const r = await request.post(`${BASE}/api/rugs`);
      expect([403, 405]).toContain(r.status());
    });

    test('rejects PUT method', async ({ request }) => {
      const r = await request.put(`${BASE}/api/rugs`);
      expect([403, 405]).toContain(r.status());
    });

    test('rejects DELETE method', async ({ request }) => {
      const r = await request.delete(`${BASE}/api/rugs`);
      expect([403, 405]).toContain(r.status());
    });
  });

  test.describe('Response format', () => {
    test('returns JSON content-type even on error', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`);
      expect(r.headers()['content-type']).toContain('application/json');
    });

    test('has security headers', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`);
      expect(r.headers()['x-content-type-options']).toBe('nosniff');
      expect(r.headers()['x-frame-options']).toBe('DENY');
      expect(r.headers()['strict-transport-security']).toBeDefined();
    });
  });

  test.describe('Error shape', () => {
    test('error response has consistent shape', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`);
      const b = await r.json();
      expect(b).toHaveProperty('error');
      expect(typeof b.error).toBe('string');
    });
  });
});
