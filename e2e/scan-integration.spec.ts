import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test.describe('Scan Integration — Full Flow E2E', () => {

  test('full scan flow: health check -> scan -> verify response', async ({ request }) => {
    // Step 1: Health check
    const health = await request.get(`${BASE}/api/health`);
    expect(health.ok()).toBeTruthy();

    // Step 2: Scan a known token
    const scan = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    if (scan.status() === 429) return; // rate limited
    expect(scan.ok()).toBeTruthy();

    const result = await scan.json();

    // Step 3: Verify complete response structure
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1000);
    expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(result.risk);
    expect(Array.isArray(result.flags)).toBe(true);
    expect(result.layers).toBeDefined();
    expect(result.scoring_version).toBeDefined();
  });

  test('scanning same token twice returns consistent scores', async ({ request }) => {
    const r1 = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    if (r1.status() === 429) return;
    const r2 = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    if (r2.status() === 429) return;

    const b1 = await r1.json();
    const b2 = await r2.json();
    // Cached results should be identical or very close
    expect(b1.risk).toBe(b2.risk);
  });

  test('different tokens produce different results', async ({ request }) => {
    const r1 = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    if (r1.status() === 429) return;
    const r2 = await request.get(`${BASE}/api/scan?ca=${USDC}`);
    if (r2.status() === 429) return;

    const b1 = await r1.json();
    const b2 = await r2.json();
    // Different tokens should have different resolved mints
    expect(b1.resolvedMint).not.toBe(b2.resolvedMint);
  });
});
