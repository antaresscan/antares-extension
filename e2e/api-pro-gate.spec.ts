import { test, expect } from '@playwright/test';
import { HAS_PRO, PRO_HEADERS, SKIP_NO_PRO } from './pro';

// THE PAYWALL. Pro is paid and Free is not: the line is drawn on the server, not in a button. An anonymous caller of /api/scan is a Free
// caller; it receives the verdict, the score, the Sell/Mint/Freeze/LP line and public market data, and none of the analysis.
// This is the guard that the line holds on the deployment under test. (api/_lib/pro-gate.ts)

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
const ORIGIN = process.env.E2E_ORIGIN || 'https://antares-extension.vercel.app';
// POPCAT: see api-scan.spec.ts for why not WSOL.
const TOKEN = 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82';

/** What only a Pro caller may ever receive. */
const PRO_ONLY = ['layers', 'sources_used', 'confidence', 'aiSummary', 'criticalActors', 'verdictHistory', 'holderActivity', 'holders', 'tokenCreator', 'recentTransfers', 'safeBlockedReasons'];

test.describe('/api/scan — Free is not Pro', () => {
  test('an anonymous caller gets the Free view: the verdict, and nothing of the analysis', async ({ playwright }) => {
    // Explicitly WITHOUT the Pro install the other API specs send (playwright.config.ts).
    const ctx = await playwright.request.newContext({ extraHTTPHeaders: { 'User-Agent': 'Antares-E2E/2.0', Origin: ORIGIN } });
    const r = await ctx.get(`${BASE}/api/scan?ca=${TOKEN}`);
    test.skip(r.status() === 429, 'Rate-limited (429) on shared CI — soft skip, not a product bug');
    expect(r.ok(), `API returned ${r.status()}`).toBe(true);
    const b = await r.json();

    expect(b.proLocked, 'the answer is not marked as the Free view').toBe(true);
    expect(['SAFE', 'CAUTION', 'DANGER', 'RUG']).toContain(b.risk);
    expect(typeof b.score).toBe('number');
    expect(Array.isArray(b.flags)).toBe(true);
    for (const field of PRO_ONLY) expect(b, `a Free caller received "${field}": the paywall leaks`).not.toHaveProperty(field);
    // The flags are placeholders: severity only, no text.
    for (const f of b.flags as Array<{ label: string }>) expect(f.label).toBe('Part of Antares Pro');
    await ctx.dispose();
  });

  test('the same scan for a Pro caller has the analysis (and the same verdict)', async ({ playwright, request }) => {
    test.skip(!HAS_PRO, SKIP_NO_PRO);
    const anon = await playwright.request.newContext({ extraHTTPHeaders: { 'User-Agent': 'Antares-E2E/2.0', Origin: ORIGIN } });
    const free = await anon.get(`${BASE}/api/scan?ca=${TOKEN}`);
    const pro = await request.get(`${BASE}/api/scan?ca=${TOKEN}`, { headers: PRO_HEADERS });
    test.skip(free.status() === 429 || pro.status() === 429, 'Rate-limited (429) on shared CI — soft skip, not a product bug');
    expect(free.ok() && pro.ok(), `API returned ${free.status()}/${pro.status()}`).toBe(true);
    const f = await free.json();
    const p = await pro.json();

    expect(p.proLocked, 'the Pro install is not recognised: is its value in DEV_PRO_INSTALLS on Vercel?').toBeUndefined();
    expect(p.layers).toBeDefined();
    expect(Array.isArray(p.sources_used)).toBe(true);
    // The gate shows less; it never decides differently. (The second request reads the scan the first one cached.)
    expect(f.risk).toBe(p.risk);
    await anon.dispose();
  });
});
