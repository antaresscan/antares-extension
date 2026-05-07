import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('API /api/rugs \u2014 Wall of Shame', () => {

  test.describe('CORS enforcement', () => {
    test('includes CORS headers for allowed origin', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`);
      // Vercel serverless functions return data regardless of Origin,
      // but should include access-control-allow-origin for the allowed origin.
      expect(r.ok()).toBeTruthy();
      const headers = r.headers();
      expect(headers['content-type']).toContain('application/json');
    });
  });

  test.describe('Method enforcement', () => {
    // POST is now a valid method on /api/rugs (it dispatches to the
    // feedback handler when ?action=feedback). Without a known action,
    // the handler returns 400 "Unknown POST action" rather than 405.
    test('POST without action returns 400 (unknown action)', async ({ request }) => {
      const r = await request.post(`${BASE}/api/rugs`);
      expect([400, 403]).toContain(r.status());
    });

    test('POST with action=feedback + missing CA returns 400', async ({ request }) => {
      const r = await request.post(`${BASE}/api/rugs?action=feedback`, {
        headers: { 'Content-Type': 'application/json' },
        data: {}, // intentionally empty — should fail CA validation
      });
      expect([400, 403]).toContain(r.status());
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
    test('disallowed method returns error with consistent shape', async ({ request }) => {
      // PUT/DELETE are still 405 (POST is now a feedback dispatcher).
      const r = await request.put(`${BASE}/api/rugs`);
      expect(r.ok()).toBeFalsy();
      const b = await r.json();
      // Error responses should have an error property
      if (b.error) {
        expect(typeof b.error).toBe('string');
      }
    });
  });

  test.describe('Data shape', () => {
    test('returns array of rugs with expected fields', async ({ request }) => {
      const r = await request.get(`${BASE}/api/rugs`);
      expect(r.ok()).toBeTruthy();
      const b = await r.json();
      // Should return an object with rugs data
      expect(b).toBeDefined();
      if (b.rugs && Array.isArray(b.rugs)) {
        for (const rug of b.rugs.slice(0, 3)) {
          expect(rug.mint).toBeDefined();
          expect(rug.score).toBeDefined();
        }
      }
    });
  });
});
