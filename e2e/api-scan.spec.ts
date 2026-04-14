import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

// Well-known Solana addresses for testing
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const INVALID_CA = 'not-a-valid-solana-address';
const SHORT_CA = 'abc123';
const EMPTY_CA = '';

test.describe('API /api/scan — Comprehensive E2E', () => {

  test.describe('Input Validation', () => {
    test('rejects missing ca parameter with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects empty ca parameter with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${EMPTY_CA}`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects invalid ca format with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${INVALID_CA}`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects short ca with 400', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SHORT_CA}`);
      expect([400, 429]).toContain(r.status());
    });
  });

  test.describe('Successful Scans', () => {
    test('scans wrapped SOL (blue chip) and returns valid structure', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.status() === 429) return; // rate limited
      expect(r.ok()).toBeTruthy();
      const b = await r.json() as Record<string, unknown>;
      expect(b).toHaveProperty('score');
      expect(b).toHaveProperty('risk');
      expect(b).toHaveProperty('flags');
      expect(b).toHaveProperty('layers');
      expect(b).toHaveProperty('scoring_version');
      expect(b).toHaveProperty('confidence');
      expect(b).toHaveProperty('sources_used');
      // Score should be relatively high for SOL (blue chip)
      expect(b.score as number).toBeGreaterThanOrEqual(500);
    });

    test('scans USDC (established token) and expects high score', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${USDC_MINT}`);
      if (r.status() === 429) return; // rate limited
      expect(r.ok()).toBeTruthy();
      const b = await r.json() as Record<string, unknown>;
      expect(b).toHaveProperty('score');
      expect(b).toHaveProperty('risk');
      // Established tokens should score well
      expect(b.score as number).toBeGreaterThanOrEqual(400);
    });

    test('each layer has trust and available fields', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.status() === 429) return;
      expect(r.ok()).toBeTruthy();
      const b = await r.json() as Record<string, unknown>;
      const layers = b.layers as Record<string, Record<string, unknown>>;
      expect(typeof layers).toBe('object');
      for (const [, layer] of Object.entries(layers)) {
        expect(layer).toHaveProperty('trust');
        expect(typeof layer.trust).toBe('number');
        expect(layer).toHaveProperty('available');
        expect(typeof layer.available).toBe('boolean');
      }
    });
  });

  test.describe('Security & Edge Cases', () => {
    test('rejects SQL injection in ca parameter', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=1' OR '1'='1`);
      // Should be 400 (bad input) or 429 (rate limited)
      expect([400, 429]).toContain(r.status());
    });

    test('handles extremely long ca parameter', async ({ request }) => {
      const longCa = 'A'.repeat(500);
      const r = await request.get(`${BASE}/api/scan?ca=${longCa}`);
      expect([400, 429]).toContain(r.status());
    });

    test('returns proper error shape on invalid input', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${INVALID_CA}`);
      if (r.status() === 429) return;
      expect(r.status()).toBe(400);
      const b = await r.json() as Record<string, unknown>;
      expect(b).toHaveProperty('error');
      expect(typeof b.error).toBe('string');
    });
  });

  test.describe('Response metadata', () => {
    test('includes request ID header', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.status() === 429) return;
      const reqId = r.headers()['x-request-id'] || '';
      expect(reqId.length).toBeGreaterThan(0);
    });

    test('content-type is JSON', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.status() === 429) return;
      const ct = r.headers()['content-type'] || '';
      expect(ct).toContain('application/json');
    });
  });
});
