import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL = 'So11111111111111111111111111111111111111112';

/**
 * Regression tests: these verify that previously fixed bugs stay fixed.
 * Add a new test here for every bug fix or critical behavior change.
 */
test.describe('Regression Tests', () => {

  test('REG-001: /api/scan returns score as number not string', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    if (r.status() === 429) return;
    const b = await r.json();
    expect(typeof b.score).toBe('number');
  });

  test('REG-002: /api/scan returns flags as array not object', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    if (r.status() === 429) return;
    const b = await r.json();
    expect(Array.isArray(b.flags)).toBe(true);
  });

  test('REG-003: /api/health does not leak internal info', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    const b = await r.json();
    expect(b.env).toBeUndefined();
    expect(b.secrets).toBeUndefined();
    expect(b.config).toBeUndefined();
  });

  test('REG-004: known tokens do not return 500', async ({ request }) => {
    const tokens = [
      SOL,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    ];
    for (const ca of tokens) {
      const r = await request.get(`${BASE}/api/scan?ca=${ca}`);
      expect(r.status(), `Token ${ca} returned 500`).not.toBe(500);
    }
  });

  test('REG-005: landing page does not have mixed content', async ({ page }) => {
    const mixedContent: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Mixed Content')) mixedContent.push(msg.text());
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    expect(mixedContent).toHaveLength(0);
  });

  test('REG-006: API responses include scoring_version', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    if (r.status() === 429) return;
    const b = await r.json();
    expect(b.scoring_version).toBeDefined();
    expect(b.scoring_version).toMatch(/^\d/);
  });

  test('REG-007: empty ca does not cause server crash', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=`);
    expect(r.status()).not.toBe(500);
    // Should be 400 (invalid input) or 429 (rate limited)
    expect([400, 429]).toContain(r.status());
  });

  test('REG-008: concurrent scans do not interfere', async ({ request }) => {
    const [r1, r2] = await Promise.all([
      request.get(`${BASE}/api/scan?ca=${SOL}`),
      request.get(`${BASE}/api/scan?ca=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`),
    ]);
    // Both should succeed or be rate-limited, but not 500
    expect(r1.status()).not.toBe(500);
    expect(r2.status()).not.toBe(500);
    // If both succeeded, verify they return different tokens
    if (r1.ok() && r2.ok()) {
      const b1 = await r1.json();
      const b2 = await r2.json();
      // Different tokens should not get mixed up
      expect(b1.resolvedMint).not.toBe(b2.resolvedMint);
    }
  });
});
