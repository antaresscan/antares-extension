import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';

test.describe('/api/scan Response Structure Validation', () => {
  let scanData: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
    expect(r.ok()).toBeTruthy();
    scanData = await r.json() as Record<string, unknown>;
  });

  test('has risk field (SAFE|CAUTION|DANGER|RUG)', async () => {
    expect(scanData.risk).toBeDefined();
    expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(scanData.risk);
  });

  test('has numeric score between 0 and 1000', async () => {
    expect(typeof scanData.score).toBe('number');
    expect(scanData.score as number).toBeGreaterThanOrEqual(0);
    expect(scanData.score as number).toBeLessThanOrEqual(1000);
  });

  test('has scoring_version string', async () => {
    expect(typeof scanData.scoring_version).toBe('string');
    expect((scanData.scoring_version as string).length).toBeGreaterThan(0);
  });

  test('has flags array', async () => {
    expect(Array.isArray(scanData.flags)).toBeTruthy();
  });

  test('each flag has label and severity', async () => {
    const flags = scanData.flags as Array<Record<string, unknown>>;
    for (const flag of flags) {
      expect(flag.label).toBeDefined();
      expect(typeof flag.label).toBe('string');
      expect(flag.severity).toBeDefined();
    }
  });

  test('has layers object with source-keyed entries', async () => {
    expect(typeof scanData.layers).toBe('object');
    expect(scanData.layers).not.toBeNull();
    const layers = scanData.layers as Record<string, unknown>;
    const keys = Object.keys(layers);
    expect(keys.length).toBeGreaterThan(0);
    // Each entry must have trust + available
    for (const entry of Object.values(layers)) {
      const l = entry as Record<string, unknown>;
      expect(typeof l.trust).toBe('number');
      expect(typeof l.available).toBe('boolean');
    }
  });

  // sources_used is an array of source name strings, not an object
  test('has sources_used array', async () => {
    expect(Array.isArray(scanData.sources_used)).toBeTruthy();
  });

  test('sources_used contains expected provider names', async () => {
    const sources = scanData.sources_used as string[];
    const knownSources = ['dexscreener', 'rugcheck', 'goplus', 'helius', 'solscan'];
    const hasKnown = sources.some(s => knownSources.includes(s));
    expect(hasKnown).toBe(true);
  });

  test('has token symbol or name', async () => {
    expect(scanData.tokenSymbol || scanData.tokenName).toBeDefined();
  });

  test('has market data fields', async () => {
    const hasMarket =
      scanData.liquidity !== undefined ||
      scanData.volume24h !== undefined ||
      scanData.marketCap !== undefined ||
      scanData.priceUsd !== undefined;
    expect(hasMarket).toBeTruthy();
  });

  test('has security fields', async () => {
    const hasSecurity =
      scanData.mintAuthority !== undefined ||
      scanData.freezeAuthority !== undefined ||
      (scanData.layers && typeof scanData.layers === 'object');
    expect(hasSecurity).toBeTruthy();
  });

  test('has confidence field', async () => {
    expect(scanData.confidence).toBeDefined();
  });

  test('response is not excessively large (< 50KB)', async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
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
    expect(risks.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(risks)]).toHaveLength(1);
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
    expect(scores.length).toBeGreaterThanOrEqual(2);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    expect(max - min).toBeLessThanOrEqual(50);
  });
});
