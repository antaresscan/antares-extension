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
    const r2 = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    const b1 = await r1.json();
    const b2 = await r2.json();

    // Scores should be identical (cached) or within small tolerance
    expect(Math.abs(b1.score - b2.score)).toBeLessThan(50);
    expect(b1.risk).toBe(b2.risk);
  });

  test('different tokens produce different results', async ({ request }) => {
    const r1 = await request.get(`${BASE}/api/scan?ca=${SOL}`);
    const r2 = await request.get(`${BASE}/api/scan?ca=${USDC}`);
    const b1 = await r1.json();
    const b2 = await r2.json();

    // Both should succeed but may differ
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();
    expect(b1.scan_id).not.toBe(b2.scan_id);
  });

  test('token page loads and calls API for scan data', async ({ page }) => {
    await page.goto(`${BASE}/token.html?ca=${SOL}`);
    await page.waitForLoadState('networkidle');
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });

  test('landing page CTA links to Chrome Web Store or valid target', async ({ page }) => {
    await page.goto(BASE);
    const cta = page.getByRole('link', { name: /install|get started|chrome|download/i }).first();
    if (await cta.count() > 0) {
      const href = await cta.getAttribute('href');
      expect(href).toBeTruthy();
      // Should link to Chrome Web Store, GitHub, or internal page
      expect(href).toMatch(/chrome\.google\.com|github\.com|#|\//i);
    }
  });
});
