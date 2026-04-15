import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL = 'So11111111111111111111111111111111111111112';

/**
 * Regression tests: verify previously fixed bugs stay fixed.
 * — All tests here use only { request } so they run in the headless `integration` project.
 * — Tests requiring a real browser page (e.g. mixed-content check) live in the `web-desktop` project.
 */
test.describe('Regression Tests', () => {

  test('REG-001: /api/scan returns score as number not string', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    const b = await r.json();
    expect(typeof b.score).toBe('number');
  });

  test('REG-002: /api/scan returns flags as array not object', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    const b = await r.json();
    expect(Array.isArray(b.flags)).toBe(true);
  });

  test('REG-003: /api/health does not leak internal info', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    const b = await r.json();
    expect(b.env).toBeUndefined();
    expect(b.secrets).toBeUndefined();
    expect(b.apiKeys).toBeUndefined();
  });

  test('REG-004: scan does not return 500 for blue-chip tokens', async ({ request }) => {
    const tokens = [
      SOL,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    ];
    for (const ca of tokens) {
      const r = await request.get(`${BASE}/api/scan?ca=${ca}`);
      expect(r.status(), `Token ${ca} returned 500`).not.toBe(500);
    }
  });

  test('REG-006: API responses include scoring_version', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    const b = await r.json();
    expect(b.scoring_version).toBeDefined();
    expect(b.scoring_version).toMatch(/^\d/);
  });

  test('REG-007: empty ca does not cause server crash', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=`);
    expect(r.status()).not.toBe(500);
    expect(r.status()).toBe(400);
  });

  // REG-008: concurrent scans use requestId (not scan_id) to distinguish responses
  test('REG-008: concurrent scans do not interfere', async ({ request }) => {
    const [r1, r2] = await Promise.all([
      request.get(`${BASE}/api/scan?ca=${SOL}`),
      request.get(`${BASE}/api/scan?ca=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`),
    ]);
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();
    const b1 = await r1.json();
    const b2 = await r2.json();
    // Different tokens must return different resolvedMint addresses
    expect(b1.resolvedMint).not.toBe(b2.resolvedMint);
  });
});
