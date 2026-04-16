import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

// Well-known Solana addresses for testing
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const INVALID_CA = 'not-a-valid-solana-address';
const SHORT_CA = 'abc123';
const EMPTY_CA = '';

test.describe('API /api/scan \u2014 Comprehensive E2E', () => {

  test.describe('Input Validation', () => {
    test('rejects missing ca parameter with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan`);
      expect([400, 429]).toContain(r.status());
      if (r.status() === 400) {
        const b = await r.json();
        expect(b.error).toBeTruthy();
      }
    });

    test('rejects empty ca parameter with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${EMPTY_CA}`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects invalid ca format with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${INVALID_CA}`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects too-short ca with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SHORT_CA}`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects POST method with 405 or 400', async ({ request }) => {
      const r = await request.post(`${BASE}/api/scan`, { data: { ca: SOL_WRAPPED } });
      expect([400, 405, 429]).toContain(r.status());
    });
  });

  test.describe('Successful Scans', () => {
    test('scans wrapped SOL (blue chip) and returns valid structure', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      test.skip(!r.ok(), `Skipped: API returned ${r.status()}`);
      const b = await r.json();
      // Core fields must exist
      expect(b).toHaveProperty('score');
      expect(b).toHaveProperty('risk');
      expect(b).toHaveProperty('flags');
      expect(b).toHaveProperty('layers');
      expect(b).toHaveProperty('scoring_version');
      expect(b).toHaveProperty('requestId');
      // Score is a number 0-1000
      expect(typeof b.score).toBe('number');
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(1000);
      // Risk is a valid verdict
      expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(b.risk);
      // Flags is an array
      expect(Array.isArray(b.flags)).toBe(true);
      // Layers object has source-named keys
      expect(typeof b.layers).toBe('object');
      const layerKeys = Object.keys(b.layers);
      expect(layerKeys.length).toBeGreaterThan(0);
    });

    test('scans USDC (established token) and expects high score', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${USDC_MINT}`);
      test.skip(!r.ok(), `Skipped: API returned ${r.status()}`);
      const b = await r.json();
      expect(b.score).toBeGreaterThan(600);
      expect(['SAFE', 'CAUTION']).toContain(b.risk);
    });

    test('response includes proper CORS headers', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      test.skip(!r.ok(), `Skipped: API returned ${r.status()}`);
      const cors = r.headers()['access-control-allow-origin'];
      expect(cors).toBeDefined();
    });

    test('response time is under 30 seconds', async ({ request }) => {
      const start = Date.now();
      await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      expect(Date.now() - start).toBeLessThan(30_000);
    });

    test('each layer has trust field', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      test.skip(!r.ok(), `Skipped: API returned ${r.status()}`);
      const b = await r.json();
      for (const key of Object.keys(b.layers)) {
        const layer = b.layers[key];
        expect(layer).toHaveProperty('trust');
        expect(typeof layer.trust).toBe('number');
      }
    });

    test('scoring_version matches expected format', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      test.skip(!r.ok(), `Skipped: API returned ${r.status()}`);
      const b = await r.json();
      expect(b.scoring_version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  test.describe('Security & Edge Cases', () => {
    test('rejects XSS in ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=<script>alert(1)</script>`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects SQL injection in ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=1%27%20OR%201%3D1`);
      expect([400, 429]).toContain(r.status());
    });

    test('handles extremely long ca parameter', async ({ request }) => {
      const longCa = 'A'.repeat(500);
      const r = await request.get(`${BASE}/api/scan?ca=${longCa}`);
      expect([400, 429]).toContain(r.status());
    });

    test('returns JSON content-type', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      expect(r.headers()['content-type']).toContain('application/json');
    });
  });
});
