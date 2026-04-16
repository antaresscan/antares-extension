import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';

test.describe('/api/scan Response Structure Validation', () => {
  let scanData: Record<string, unknown> | null = null;

  test.beforeAll(async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
    if (r.status() === 429) {
      console.warn('Rate limited in beforeAll — skipping structure tests');
      return;
    }
    expect(r.ok()).toBeTruthy();
    scanData = await r.json() as Record<string, unknown>;
  });

  test('has risk field (SAFE|CAUTION|DANGER|RUG)', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(scanData!.risk).toBeDefined();
    expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(scanData!.risk);
  });

  test('has numeric score between 0 and 1000', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(typeof scanData!.score).toBe('number');
    expect(scanData!.score as number).toBeGreaterThanOrEqual(0);
    expect(scanData!.score as number).toBeLessThanOrEqual(1000);
  });

  test('has scoring_version string', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(typeof scanData!.scoring_version).toBe('string');
    expect((scanData!.scoring_version as string).length).toBeGreaterThan(0);
  });

  test('has flags array', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(Array.isArray(scanData!.flags)).toBeTruthy();
  });

  test('each flag has label and severity', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    const flags = scanData!.flags as Array<Record<string, unknown>>;
    for (const flag of flags) {
      expect(flag.label).toBeDefined();
      expect(typeof flag.label).toBe('string');
      expect(flag.severity).toBeDefined();
    }
  });

  test('has layers object', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(typeof scanData!.layers).toBe('object');
    expect(scanData!.layers).not.toBeNull();
  });

  test('has sources_used array', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(Array.isArray(scanData!.sources_used)).toBeTruthy();
  });

  test('sources_used contains expected providers', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    const sources = scanData!.sources_used as string[];
        // dexscreener is always expected; rugcheck may be unavailable for native tokens
        ct(sources, 'Missing source: dexscreener').toContain('dexscreener');
    // At least 2 sources should be available for a valid scan
    expect(sources.length, `Only ${sources.length} source(s)`).toBeGreaterThanOrEqual(2);
    // All returned sources must be known providers
    const knownSources = ['dexscreener', 'rugcheck', 'goplus', 'helius', 'solscan', 'chart'];
    for (const src of sources) {
      expect(knownSources, `Unknown source: ${src}`).toContain(src);
    }
  });

  test('has token metadata (symbol, name)', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(scanData!.tokenSymbol || scanData!.symbol).toBeDefined();
  });

  test('has market data fields', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    const hasMarket = scanData!.liqUsd !== undefined || scanData!.volume24h !== undefined ||
      scanData!.marketCap !== undefined || scanData!.priceUsd !== undefined ||
      scanData!.liquidity !== undefined;
    expect(hasMarket).toBeTruthy();
  });

  test('has price data', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(scanData!.priceUsd !== undefined || scanData!.priceSol !== undefined).toBeTruthy();
  });

  test('has security fields', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    const hasSecurity = scanData!.mintAuthority !== undefined || scanData!.freezeAuthority !== undefined ||
      scanData!.isMintable !== undefined || scanData!.isFreezable !== undefined ||
      (scanData!.layers && typeof scanData!.layers === 'object');
    expect(hasSecurity).toBeTruthy();
  });

  test('has confidence field', async () => {
    test.skip(!scanData, 'Skipped: no scan data (rate limited)');
    expect(scanData!.confidence !== undefined || scanData!.conf !== undefined).toBeTruthy();
  });

  test('response is not excessively large (< 50KB)', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
    test.skip(r.status() === 429, 'Rate limited');
    const body = await r.text();
    expect(body.length).toBeLessThan(50 * 1024);
  });

  test('response has proper content-type', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
    const ct = r.headers()['content-type'] || '';
    expect(ct).toContain('application/json');
  });
});

test.describe('/api/scan Idempotency & Stability', () => {
  test('same token scanned 3x returns consistent risk', async ({ request }) => {
    const risks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.ok()) {
        const data = await r.json() as Record<string, unknown>;
        risks.push(data.risk as string);
      }
    }
    test.skip(risks.length < 2, 'Not enough successful scans (rate limited)');
    const uniqueRisks = [...new Set(risks)];
    expect(uniqueRisks).toHaveLength(1);
  });

  test('same token scanned 3x returns consistent score (within 50 points)', async ({ request }) => {
    const scores: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.ok()) {
        const data = await r.json() as Record<string, unknown>;
        scores.push(data.score as number);
      }
    }
    test.skip(scores.length < 2, 'Not enough successful scans (rate limited)');
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    expect(max - min).toBeLessThanOrEqual(50);
  });
});
