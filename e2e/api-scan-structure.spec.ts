import { test, expect } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';

/** Retry a GET request up to `retries` times with exponential backoff on 429/5xx */
async function fetchWithRetry(
  request: APIRequestContext,
  url: string,
  retries = 5,
  baseDelay = 3000
): Promise<APIResponse> {
  for (let i = 0; i < retries; i++) {
    const r = await request.get(url);
    if (r.ok() || (r.status() !== 429 && r.status() < 500)) return r;
    const delay = baseDelay * Math.pow(2, i);
    console.log(`Retry ${i + 1}/${retries}: status ${r.status()}, waiting ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return request.get(url);
}

test.describe('/api/scan Response Structure Validation', () => {
  let scanData: Record<string, unknown> | null = null;

  test.beforeAll(async ({ request }) => {
    const r = await fetchWithRetry(request, `${BASE}/api/scan?ca=${SOL_WRAPPED}`);
    expect(r.ok(), `Scan API returned ${r.status()} after retries`).toBeTruthy();
    scanData = await r.json() as Record<string, unknown>;
  });

  test('has risk field (SAFE|CAUTION|DANGER|RUG)', async () => {
    expect(scanData).not.toBeNull();
    expect(scanData!.risk).toBeDefined();
    expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(scanData!.risk);
  });

  test('has numeric score between 0 and 1000', async () => {
    expect(scanData).not.toBeNull();
    expect(typeof scanData!.score).toBe('number');
    expect(scanData!.score as number).toBeGreaterThanOrEqual(0);
    expect(scanData!.score as number).toBeLessThanOrEqual(1000);
  });

  test('has scoring_version string', async () => {
    expect(scanData).not.toBeNull();
    expect(typeof scanData!.scoring_version).toBe('string');
    expect((scanData!.scoring_version as string).length).toBeGreaterThan(0);
  });

  test('has flags array', async () => {
    expect(scanData).not.toBeNull();
    expect(Array.isArray(scanData!.flags)).toBeTruthy();
  });

  test('each flag has label and severity', async () => {
    expect(scanData).not.toBeNull();
    const flags = scanData!.flags as Array<Record<string, unknown>>;
    for (const flag of flags) {
      expect(flag.label).toBeDefined();
      expect(typeof flag.label).toBe('string');
      expect(flag.severity).toBeDefined();
    }
  });

  test('has layers object', async () => {
    expect(scanData).not.toBeNull();
    expect(typeof scanData!.layers).toBe('object');
    expect(scanData!.layers).not.toBeNull();
  });

  test('has sources_used array', async () => {
    expect(scanData).not.toBeNull();
    expect(Array.isArray(scanData!.sources_used)).toBeTruthy();
  });

  test('sources_used contains expected providers', async () => {
    expect(scanData).not.toBeNull();
    const sources = scanData!.sources_used as string[];
    expect(sources, 'Missing source: dexscreener').toContain('dexscreener');
    expect(sources.length, `Only ${sources.length} source(s)`).toBeGreaterThanOrEqual(2);
    const knownSources = ['dexscreener', 'rugcheck', 'goplus', 'helius', 'solscan', 'chart'];
    for (const src of sources) {
      expect(knownSources, `Unknown source: ${src}`).toContain(src);
    }
  });

  test('has token metadata (symbol, name)', async () => {
    expect(scanData).not.toBeNull();
    expect(scanData!.tokenSymbol || scanData!.symbol).toBeDefined();
  });

  test('has market data fields', async () => {
    expect(scanData).not.toBeNull();
    const hasMarket = scanData!.liqUsd !== undefined || scanData!.volume24h !== undefined ||
      scanData!.marketCap !== undefined || scanData!.priceUsd !== undefined ||
      scanData!.liquidity !== undefined;
    expect(hasMarket).toBeTruthy();
  });

  test('has price data', async () => {
    expect(scanData).not.toBeNull();
    expect(scanData!.priceUsd !== undefined || scanData!.priceSol !== undefined).toBeTruthy();
  });

  test('has security fields', async () => {
    expect(scanData).not.toBeNull();
    const hasSecurity = scanData!.mintAuthority !== undefined || scanData!.freezeAuthority !== undefined ||
      scanData!.isMintable !== undefined || scanData!.isFreezable !== undefined ||
      (scanData!.layers && typeof scanData!.layers === 'object');
    expect(hasSecurity).toBeTruthy();
  });

  test('has confidence field', async () => {
    expect(scanData).not.toBeNull();
    expect(scanData!.confidence !== undefined || scanData!.conf !== undefined).toBeTruthy();
  });

  test('response is not excessively large (< 50KB)', async ({ request }) => {
    const r = await fetchWithRetry(request, `${BASE}/api/scan?ca=${SOL_WRAPPED}`);
    expect(r.ok(), `API returned ${r.status()}`).toBeTruthy();
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
      const r = await fetchWithRetry(request, `${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.ok()) {
        const data = await r.json() as Record<string, unknown>;
        risks.push(data.risk as string);
      }
    }
    expect(risks.length, 'Not enough successful scans').toBeGreaterThanOrEqual(2);
    const uniqueRisks = [...new Set(risks)];
    expect(uniqueRisks).toHaveLength(1);
  });

  test('same token scanned 3x returns consistent score (within 50 points)', async ({ request }) => {
    const scores: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetchWithRetry(request, `${BASE}/api/scan?ca=${SOL_WRAPPED}`);
      if (r.ok()) {
        const data = await r.json() as Record<string, unknown>;
        scores.push(data.score as number);
      }
    }
    expect(scores.length, 'Not enough successful scans').toBeGreaterThanOrEqual(2);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    expect(max - min).toBeLessThanOrEqual(50);
  });
});
