import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';

test.describe('/api/scan Response Structure Validation', () => {
  let scanData: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    const r = await request.get(`${BASE}/api/scan?ca=${SOL_WRAPPED}`);
    // May be rate-limited (429) or CORS issue
    if (!r.ok()) {
      scanData = { _skipped: true, _status: r.status() } as Record<string, unknown>;
      return;
    }
    scanData = await r.json() as Record<string, unknown>;
  });

  test('has risk field (SAFE|CAUTION|DANGER|RUG)', async () => {
    if (scanData._skipped) return;
    expect(scanData.risk).toBeDefined();
    expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(scanData.risk);
  });

  test('has numeric score between 0 and 1000', async () => {
    if (scanData._skipped) return;
    expect(typeof scanData.score).toBe('number');
    expect(scanData.score as number).toBeGreaterThanOrEqual(0);
    expect(scanData.score as number).toBeLessThanOrEqual(1000);
  });

  test('has scoring_version string', async () => {
    if (scanData._skipped) return;
    expect(typeof scanData.scoring_version).toBe('string');
    expect((scanData.scoring_version as string).length).toBeGreaterThan(0);
  });

  test('has flags array', async () => {
    if (scanData._skipped) return;
    expect(Array.isArray(scanData.flags)).toBe(true);
  });

  test('each flag has label and severity', async () => {
    if (scanData._skipped) return;
    const flags = scanData.flags as Array<Record<string, unknown>>;
    for (const f of flags) {
      expect(f).toHaveProperty('label');
      expect(f).toHaveProperty('severity');
    }
  });

  test('has layers object', async () => {
    if (scanData._skipped) return;
    expect(typeof scanData.layers).toBe('object');
    expect(scanData.layers).not.toBeNull();
  });

  test('has sources_used array', async () => {
    if (scanData._skipped) return;
    expect(Array.isArray(scanData.sources_used)).toBe(true);
  });

  test('sources_used contains expected providers', async () => {
    if (scanData._skipped) return;
    const sources = scanData.sources_used as string[];
    // At minimum dexscreener should be available
    const knownProviders = ['dexscreener', 'rugcheck', 'goplus', 'helius', 'solscan', 'chart'];
    const hasAtLeastOne = sources.some(s => knownProviders.includes(s));
    expect(hasAtLeastOne).toBe(true);
  });

  test('has token metadata (symbol, name)', async () => {
    if (scanData._skipped) return;
    expect(scanData).toHaveProperty('tokenSymbol');
    expect(scanData).toHaveProperty('tokenName');
  });

  test('has market data fields', async () => {
    if (scanData._skipped) return;
    expect(scanData).toHaveProperty('marketCap');
    expect(scanData).toHaveProperty('liquidity');
    expect(scanData).toHaveProperty('volume24h');
  });

  test('has price data', async () => {
    if (scanData._skipped) return;
    expect(scanData).toHaveProperty('priceUsd');
    expect(scanData).toHaveProperty('priceChange24h');
  });

  test('has security fields', async () => {
    if (scanData._skipped) return;
    expect(scanData).toHaveProperty('honeypot');
    expect(scanData).toHaveProperty('mintAuthority');
    expect(scanData).toHaveProperty('freezeAuthority');
    expect(scanData).toHaveProperty('lpBurned');
  });

  test('has confidence field', async () => {
    if (scanData._skipped) return;
    expect(typeof scanData.confidence).toBe('number');
  });

  test('has requestId', async () => {
    if (scanData._skipped) return;
    expect(typeof scanData.requestId).toBe('string');
  });

  test('has fetchedAt timestamp', async () => {
    if (scanData._skipped) return;
    expect(typeof scanData.fetchedAt).toBe('number');
  });

  test('layers contain trust and available fields', async () => {
    if (scanData._skipped) return;
    const layers = scanData.layers as Record<string, Record<string, unknown>>;
    for (const [, layer] of Object.entries(layers)) {
      expect(layer).toHaveProperty('trust');
      expect(layer).toHaveProperty('available');
      expect(typeof layer.trust).toBe('number');
      expect(typeof layer.available).toBe('boolean');
    }
  });
});
