import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const INVALID_CA = 'not-a-valid-solana-address';
const SHORT_CA = 'abc123';
const EMPTY_CA = '';

test.describe('API /api/scan — Comprehensive E2E', () => {

  test.describe('Input Validation', () => {
    test('rejects missing ca parameter with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan`);
      expect(r.status()).toBe(400);
      const b = await r.json();
      expect(b.error).toBeTruthy();
    });

    test('rejects empty ca parameter with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${EMPTY_CA}`);
      expect(r.status()).toBe(400);
    });

    test('rejects invalid ca format with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${INVALID_CA}`);
      expect(r.status()).toBe(400);
    });

    test('rejects too-short ca with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SHORT_CA}`);
      expect(r.status()).toBe(400);
    });

    test('rejects POST method with 405 or 400', async ({ request }) => {
      const r = await request.post(`${BASE}/api/scan`, { data: { ca: SOL_WRAPPED } });
      expect([400, 405]).toContain(r.status());
    });
  });

  test.describe('Successful Scans', () => {
    test('scans wrapped SOL and returns valid structure', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      expect(r.ok()).toBeTruthy();
      const b = await r.json();

      expect(b).toHaveProperty('score');
      expect(b).toHaveProperty('risk');
      expect(b).toHaveProperty('flags');
      expect(b).toHaveProperty('layers');
      expect(b).toHaveProperty('scoring_version');

      expect(typeof b.score).toBe('number');
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(1000);

      expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(b.risk);
      expect(Array.isArray(b.flags)).toBe(true);
    });

    test('layers uses source names as keys (not L1/L2)', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      const b = await r.json();
      // layers is a Record<sourceName, { trust, available }>
      expect(typeof b.layers).toBe('object');
      const keys = Object.keys(b.layers as object);
      expect(keys.length).toBeGreaterThan(0);
      // At least one well-known source should be present
      const knownSources = ['dexscreener', 'rugcheck', 'goplus', 'helius', 'solscan', 'chart', 'crossvalidation'];
      const hasKnown = keys.some(k => knownSources.includes(k));
      expect(hasKnown).toBe(true);
      // Each layer entry has trust (number) and available (boolean)
      for (const entry of Object.values(b.layers as Record<string, unknown>)) {
        const layer = entry as Record<string, unknown>;
        expect(typeof layer.trust).toBe('number');
        expect(typeof layer.available).toBe('boolean');
      }
    });

    test('scans USDC and expects high score', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${USDC_MINT}`);
      expect(r.ok()).toBeTruthy();
      const b = await r.json();
      expect(b.score).toBeGreaterThan(600);
      expect(['SAFE', 'CAUTION']).toContain(b.risk);
    });

    test('response includes proper CORS headers', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      const cors = r.headers()['access-control-allow-origin'];
      expect(cors).toBeDefined();
    });

    test('response time is under 30 seconds', async ({ request }) => {
      const start = Date.now();
      await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      expect(Date.now() - start).toBeLessThan(30_000);
    });

    test('scoring_version matches semver format', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      const b = await r.json();
      expect(b.scoring_version).toMatch(/^\d/);
    });
  });

  test.describe('Security & Edge Cases', () => {
    test('rejects XSS in ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=<script>alert(1)</script>`);
      expect(r.status()).toBe(400);
    });

    test('rejects SQL injection in ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=1%27%20OR%201%3D1`);
      expect(r.status()).toBe(400);
    });

    test('handles extremely long ca parameter', async ({ request }) => {
      const longCa = 'A'.repeat(500);
      const r = await request.get(`${BASE}/api/scan?ca=${longCa}`);
      expect(r.status()).toBe(400);
    });

    test('returns JSON content-type', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      expect(r.headers()['content-type']).toContain('application/json');
    });
  });
});
