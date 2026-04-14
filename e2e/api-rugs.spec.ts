import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const ALLOWED_ORIGIN = 'https://antares-extension.vercel.app';
const BAD_ORIGIN = 'https://evil.com';

test.describe('API /api/rugs — Wall of Shame', () => {

  test.describe('CORS enforcement', () => {
    test('blocks requests from non-allowed origins', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`, {
        headers: { Origin: BAD_ORIGIN },
      });
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

  test.describe('Successful response', () => {
    test('returns rugs list with valid structure', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      // May be rate limited
      if (r.status() === 429) return;
      expect(r.ok()).toBeTruthy();
      const b = await r.json();
      expect(b).toHaveProperty('rugs');
      expect(b).toHaveProperty('count');
      expect(Array.isArray(b.rugs)).toBe(true);
      if (b.rugs.length > 0) {
        const rug = b.rugs[0];
        expect(rug).toHaveProperty('mint');
        expect(rug).toHaveProperty('risk');
        expect(rug).toHaveProperty('flags');
      }
    });
  });

  test.describe('Error shape', () => {
    test('invalid origin returns error with consistent shape', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`, {
        headers: { Origin: BAD_ORIGIN },
      });
      expect(r.status()).toBe(403);
      const b = await r.json();
      expect(b).toHaveProperty('error');
      expect(typeof b.error).toBe('string');
    });
  });
});
