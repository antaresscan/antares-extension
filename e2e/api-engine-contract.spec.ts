import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

// ENGINE CONTRACT — what the scan engine guarantees once its upstreams are wired the right way.
//
// The other API specs check the SHAPE of a response (fields, types, ranges). They keep passing when a pull request
// silently breaks the data itself: a layer that no longer reads its upstream, a "renounced" shown for an authority
// that was never read, a holder count taken from the wrong place. This test asserts on the facts a pull request must
// not change, on real tokens, against the deployment under test (E2E_BASE_URL: the preview of the commit in CI).
//
// Why every scan here is `fresh=1`: the Upstash database is shared with production, and a cached answer would be the
// answer of whatever code cached it. fresh=1 bypasses the cache READ, so the engine of the deployment under test runs
// (api/_lib/deployment.ts keeps a preview from writing into production's cache).
//
// Why ONE test made of steps with soft assertions: the scans are slow (~10 s each) and shared by every check. Separate
// tests would re-scan after each failure (a failed test restarts its worker), and a serial group would stop at the first
// failure and hide the others. Here every failure of the run is reported at once, each under the step it belongs to.
//
// Tokens are chosen for facts that do not move:
//   BONK    both authorities renounced, LP mostly NOT burned (its biggest pools are not), a million holders
//   WIF     both authorities renounced, LP burned
//   RENDER  mint AND freeze authority still active, classic token program
// Live upstreams flap (a rate limit, a timeout): a scan is retried while a layer is missing, and a rate limit (429)
// skips the test instead of failing it. A deployment that is really broken fails on every attempt.

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const RENDER = 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof';

interface Layer { available?: boolean; trust?: number }
interface Flag { label: string; severity: string }
interface Scan {
  risk: string;
  score: number;
  holders: number | null;
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  honeypot: boolean | null;
  lpBurned: boolean | null;
  layers: Record<string, Layer>;
  sources_used: string[];
  flags: Flag[];
}
interface Outcome { body: Scan | null; status: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const available = (b: Scan, ...names: string[]) => names.every((n) => b.layers?.[n]?.available === true);

/** A cold scan of `mint` on the deployment under test; retried while `ready` says an upstream was missing. */
async function scanFresh(request: APIRequestContext, mint: string, ready: (b: Scan) => boolean = () => true, attempts = 3): Promise<Outcome> {
  let last: Outcome = { body: null, status: 0 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = await request.get(`${BASE}/api/scan?fresh=1&ca=${mint}`, { timeout: 50_000 });
    last = { body: r.ok() ? ((await r.json()) as Scan) : null, status: r.status() };
    if (last.body && ready(last.body)) return last;
    if (last.status === 429) return last; // retrying a rate limit only makes it worse
    if (last.status >= 400 && last.status < 500) return last; // a refusal (unknown token...) will not change
    if (attempt < attempts - 1) await sleep(6_000 * (attempt + 1));
  }
  return last;
}

// ── chain truth for the holder count (public RPC, no key) ───────────────────
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

/** Token accounts of `mint` with a non-zero balance, read straight from a public RPC. null when it cannot be read. */
async function chainHolders(mint: string): Promise<number | null> {
  for (const program of TOKEN_PROGRAMS) {
    try {
      const res = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [program, { encoding: 'base64', filters: [{ memcmp: { offset: 0, bytes: mint } }], dataSlice: { offset: 64, length: 8 } }] }),
      });
      const j = (await res.json()) as { result?: Array<{ account: { data: [string, string] } }> };
      if (Array.isArray(j.result) && j.result.length > 0) {
        return j.result.filter((a) => Buffer.from(a.account.data[0], 'base64').readBigUInt64LE(0) > 0n).length;
      }
    } catch { /* try the next program */ }
  }
  return null;
}

/** Recently listed Solana tokens (they are small: the range where GoPlus and RugCheck are wrong or silent). */
async function recentSolanaMints(): Promise<string[]> {
  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(20_000) });
    const list = (await res.json()) as Array<{ chainId: string; tokenAddress: string }>;
    return list.filter((t) => t.chainId === 'solana').map((t) => t.tokenAddress).slice(0, 14);
  } catch { return []; }
}

test('engine contract: every upstream is read, authorities come from the chain, holders and LP burn are right', async ({ request }) => {
  test.setTimeout(420_000);

  // One at a time: GoPlus rate limits a burst, and a skipped upstream is exactly what this test must not hide.
  const everyUpstream = (b: Scan) => available(b, 'dexscreener', 'rugcheck', 'goplus', 'helius');
  const outcomes = {
    BONK: await scanFresh(request, BONK, everyUpstream),
    WIF: await scanFresh(request, WIF, everyUpstream),
    RENDER: await scanFresh(request, RENDER, everyUpstream),
  };
  test.skip(Object.values(outcomes).some((o) => o.status === 429), 'rate limited (429) on a shared runner: nothing to assert');

  const scans: Partial<Record<keyof typeof outcomes, Scan>> = {};
  for (const [name, o] of Object.entries(outcomes) as Array<[keyof typeof outcomes, Outcome]>) {
    expect.soft(o.body, `${name}: /api/scan answered ${o.status}`).not.toBeNull();
    if (o.body) scans[name] = o.body;
  }
  const { BONK: bonk, WIF: wif, RENDER: render } = scans;

  await test.step('every upstream is read: DexScreener, RugCheck, GoPlus and Helius answer and count as sources', async () => {
    for (const [name, b] of Object.entries(scans) as Array<[string, Scan]>) {
      for (const layer of ['dexscreener', 'rugcheck', 'goplus', 'helius']) {
        expect.soft(b.layers?.[layer]?.available, `${name}: layer ${layer} is not available, the engine no longer reads that upstream`).toBe(true);
        expect.soft(b.sources_used, `${name}: ${layer} missing from sources_used`).toContain(layer);
      }
    }
    const flags = [bonk, render].flatMap((b) => (b ? b.flags.map((f) => f.label) : []));
    expect.soft(flags.some((l) => /mutable metadata/i.test(l)), 'no RugCheck-derived flag on BONK or RENDER ("Mutable metadata"): the RugCheck layer reads nothing').toBe(true);
  });

  await test.step('mint / freeze / sell come from the chain, and "not verified" is never shown as OK', async () => {
    if (bonk) {
      expect.soft(bonk.mintAuthority, 'BONK mint authority (renounced)').toBe(false);
      expect.soft(bonk.freezeAuthority, 'BONK freeze authority (renounced)').toBe(false);
      expect.soft(bonk.honeypot, 'BONK sell check (nothing can block a sale)').toBe(false);
    }
    if (wif) {
      expect.soft(wif.mintAuthority, 'WIF mint authority (renounced)').toBe(false);
      expect.soft(wif.freezeAuthority, 'WIF freeze authority (renounced)').toBe(false);
    }
    if (render) {
      expect.soft(render.mintAuthority, 'RENDER mint authority is active: it was reported as not active').toBe(true);
      expect.soft(render.freezeAuthority, 'RENDER freeze authority is active: it was reported as not active').toBe(true);
      expect.soft(render.flags.some((f) => f.severity === 'critical' && /mint authority/i.test(f.label)), 'RENDER: no critical flag for the active mint authority').toBe(true);
      expect.soft(render.flags.some((f) => f.severity === 'critical' && /freeze authority/i.test(f.label)), 'RENDER: no critical flag for the active freeze authority').toBe(true);
      expect.soft(render.risk, 'RENDER (active mint and freeze authority) must never be SAFE').not.toBe('SAFE');
      expect.soft(render.honeypot, 'RENDER: with a freeze authority the sell check cannot be passed, it stays "not verified" and never false').not.toBe(false);
    }
  });

  await test.step('large tokens report their real number of holders (never the size of a top-20 list)', async () => {
    if (bonk) {
      expect.soft(bonk.holders, 'BONK holders').not.toBeNull();
      expect.soft(bonk.holders ?? 0, 'BONK holders').toBeGreaterThan(900_000);
      expect.soft(bonk.holders ?? 0, 'BONK holders').toBeLessThan(1_300_000);
    }
    if (wif) expect.soft(wif.holders ?? 0, 'WIF holders').toBeGreaterThan(100_000);
    if (render) expect.soft(render.holders ?? 0, 'RENDER holders').toBeGreaterThan(50_000);
  });

  await test.step('a small token reports the holders the chain counts, not RugCheck\'s inflated total or a top-20 size', async () => {
    let checked = 0;
    for (const mint of await recentSolanaMints()) {
      const truth = await chainHolders(mint);
      if (truth === null || truth < 3 || truth > 900) continue; // the range where the chain page is exact
      const o = await scanFresh(request, mint, () => true, 1);
      if (!o.body || o.body.holders == null) continue; // no pair yet, or the scan failed: try another token
      const tolerance = Math.max(6, Math.round(0.1 * truth));
      expect.soft(
        Math.abs(o.body.holders - truth),
        `${mint}: the API says ${o.body.holders} holders, the chain has ${truth} (RugCheck counts emptied accounts, GoPlus is silent on new tokens)`,
      ).toBeLessThanOrEqual(tolerance);
      if (++checked >= 2) break;
    }
    if (checked === 0) test.info().annotations.push({ type: 'skipped-step', description: 'no recent small token could be read on the chain and scanned right now' });
  });

  await test.step('LP burn is weighed over the measurable liquidity, not taken from the best single pool', async () => {
    if (bonk) {
      expect.soft(bonk.lpBurned, 'BONK is not burned: a $5k pool burned at 94 % must not make the whole token read as burned').toBe(false);
      expect.soft(bonk.flags.some((f) => /LP Burned/i.test(f.label)), 'BONK got an "LP Burned" bonus').toBe(false);
    }
    if (wif) {
      expect.soft(wif.lpBurned, 'WIF is burned (its large pool is burned at 99.7 %)').toBe(true);
      expect.soft(wif.flags.some((f) => /LP Burned/i.test(f.label)), 'WIF lost its "LP Burned" bonus').toBe(true);
    }
  });
});
