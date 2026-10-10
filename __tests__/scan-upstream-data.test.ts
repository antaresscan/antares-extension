import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { _resetGoPlusAuthForTests } from "../api/_lib/goplus-auth";

// What the scan handler does with the upstream data: holder count source order, Solscan availability, the mint /
// freeze / sell pills read from the chain, and the GoPlus credentials. The mock harness below mirrors scan.test.ts (each scan test file in this repo
// carries its own copy of it).

// ---- Mock all external modules BEFORE importing handler ----

// Mock @upstash/redis
vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    setex = vi.fn().mockResolvedValue("OK");
  }
  return { Redis: MockRedis };
});

// Mock @upstash/ratelimit
vi.mock("@upstash/ratelimit", () => {
  class MockRatelimit {
    limit = vi.fn().mockResolvedValue({ success: true, remaining: 29 });
    static slidingWindow = vi.fn();
  }
  return { Ratelimit: MockRatelimit };
});

// Mock middleware — pass through
vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return {
    ...actual,
    initRateLimiters: vi.fn(),
    checkRateLimit: vi.fn().mockResolvedValue(true),
  };
});

// Mock cache — short-cache helper replaces the ad-hoc getCacheRedis().setex
// call site that used to exist in scan.ts. The setex spy lives only to
// keep test introspection consistent with the previous version, in case
// any downstream assertion still pokes at it.
const mockSetex = vi.fn().mockResolvedValue("OK");
vi.mock("../api/_lib/cache", () => ({
  initCache: vi.fn(),
  getCachedResult: vi.fn().mockResolvedValue(null),
  setCachedResult: vi.fn(),
  setShortCachedResult: vi.fn(),
  // Single-flight lock: acquire always wins (fail-open), waiter no-ops, in
  // unit tests so the handler proceeds straight to runAnalysis as before.
  acquireScanLock: vi.fn().mockResolvedValue(true),
  releaseScanLock: vi.fn().mockResolvedValue(undefined),
  waitForCachedResult: vi.fn().mockResolvedValue(null),
  getCacheRedis: vi.fn().mockReturnValue({ setex: mockSetex }),
}));

// The rug database: the real module, except that writes are observable (a preview deployment must not make any).
const mockRecordRug = vi.fn();
vi.mock("../api/_lib/rugdb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/_lib/rugdb")>();
  return { ...actual, recordRug: (...args: unknown[]) => mockRecordRug(...args) };
});

// Mock @sentry/node
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

// Mock fetchers
const mockHeliusGetLargestAccounts = vi.fn();
const mockHeliusGetTokenSupply = vi.fn();
const mockHeliusGetMintAccount = vi.fn();
const mockHeliusGetHolderPages = vi.fn();
const mockHeliusGetCreatorReputation = vi.fn();
const mockHeliusGetHoldersCount = vi.fn();
const mockHeliusGetProgramAccountHolderCount = vi.fn();
const mockFetchSolscan = vi.fn();
const mockFetchDexCandles = vi.fn();
const mockHeliusResolveAccountOwners = vi.fn();
const mockPublicRpcGetLargestAccounts = vi.fn();
const mockPublicRpcGetTokenSupply = vi.fn();
const mockPublicRpcGetMintInfo = vi.fn();
const mockPublicRpcGetMintAccount = vi.fn();

// getAccountInfo(jsonParsed) on a mint, in the real shape (supply + authorities, as the Helius call now returns).
// Defaults: a classic mint, 100,000 supply, both authorities renounced.
function mintAccountResponse(o: { supply?: number; decimals?: number; mintAuthority?: string | null; freezeAuthority?: string | null; program?: string; extensions?: string[] } = {}) {
  const decimals = o.decimals ?? 0;
  return {
    result: {
      value: {
        data: {
          program: o.program ?? "spl-token",
          parsed: {
            type: "mint",
            info: {
              decimals,
              supply: String((o.supply ?? 100000) * 10 ** decimals),
              mintAuthority: o.mintAuthority ?? null,
              freezeAuthority: o.freezeAuthority ?? null,
              ...(o.extensions ? { extensions: o.extensions.map((extension) => ({ extension })) } : {}),
            },
          },
        },
      },
    },
  };
}

vi.mock("../api/_lib/fetchers", () => ({
  heliusGetLargestAccounts: (...args: unknown[]) => mockHeliusGetLargestAccounts(...args),
  heliusGetTokenSupply: (...args: unknown[]) => mockHeliusGetTokenSupply(...args),
  heliusGetMintAccount: (...args: unknown[]) => mockHeliusGetMintAccount(...args),
  heliusGetHolderPages: (...args: unknown[]) => mockHeliusGetHolderPages(...args),
  heliusGetCreatorReputation: (...args: unknown[]) => mockHeliusGetCreatorReputation(...args),
  heliusGetHoldersCount: (...args: unknown[]) => mockHeliusGetHoldersCount(...args),
  heliusGetProgramAccountHolderCount: (...args: unknown[]) => mockHeliusGetProgramAccountHolderCount(...args),
  fetchSolscan: (...args: unknown[]) => mockFetchSolscan(...args),
  fetchDexCandles: (...args: unknown[]) => mockFetchDexCandles(...args),
  fetchDexCandlesDaily: vi.fn().mockResolvedValue([]), // no daily candles in unit tests
  heliusResolveAccountOwners: (...args: unknown[]) => mockHeliusResolveAccountOwners(...args),
  publicRpcGetLargestAccounts: (...args: unknown[]) => mockPublicRpcGetLargestAccounts(...args),
  publicRpcGetTokenSupply: (...args: unknown[]) => mockPublicRpcGetTokenSupply(...args),
  publicRpcGetMintInfo: (...args: unknown[]) => mockPublicRpcGetMintInfo(...args),
  publicRpcGetMintAccount: (...args: unknown[]) => mockPublicRpcGetMintAccount(...args),
}));

// Mock global fetch for DexScreener, RugCheck, GoPlus
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---- Helpers ----
function createMockReq(query: Record<string, string> = {}, method = "GET"): VercelRequest {
  return {
    method,
    query,
    headers: { origin: "https://dexscreener.com", "x-forwarded-for": "1.2.3.4" },
    socket: { remoteAddress: "1.2.3.4" },
  } as unknown as VercelRequest;
}

function createMockRes(): VercelResponse {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;

  const res: Record<string, unknown> = {
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn(),
    getStatusCode: () => statusCode,
    getBody: () => body,
    getHeaders: () => headers,
  };
  (res.status as ReturnType<typeof vi.fn>).mockImplementation((code: number) => { statusCode = code; return res; });
  (res.json as ReturnType<typeof vi.fn>).mockImplementation((data: unknown) => { body = data; return res; });
  (res.end as ReturnType<typeof vi.fn>).mockImplementation(() => res);
  return res as unknown as VercelResponse;
}

// Standard mock responses for a "good" token
function setupGoodTokenMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("dexscreener")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          pairs: [{
            pairAddress: "pair1",
            baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Wrapped SOL" },
            liquidity: { usd: 500000 },
            volume: { h24: 200000, h1: 50000 },
            priceChange: { m5: 1.2, h1: 3.5, h6: 8, h24: 12 },
            txns: { m5: { buys: 15, sells: 12 } },
            priceUsd: "150.25",
            marketCap: 50000000,
            fdv: 50000000,
            pairCreatedAt: Date.now() - 90 * 24 * 3600 * 1000,
            info: {
              socials: [{ type: "twitter", url: "https://twitter.com/test" }],
              websites: [{ url: "https://test.com" }],
              imageUrl: "https://img.test.com/icon.png",
            },
          }],
        }),
      });
    }
    if (url.includes("rugcheck") && url.includes("summary")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          lpBurned: true,
          lpLocked: false,
          metaMutable: false,
          topHolders: { top10Percentage: 25, top1Percentage: 5 },
          risks: [],
        }),
      });
    }
    if (url.includes("rugcheck") && url.includes("report")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          risks: [],
          topHolders: { top10Percentage: 25, top1Percentage: 5 },
          totalHolders: 5000,
        }),
      });
    }
    if (url.includes("gopluslabs")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          result: {
            So11111111111111111111111111111111111111112: {
              is_honeypot: "0",
              cannot_sell_all: "0",
              mint_authority: "0",
              freeze_authority: "0",
              is_blacklisted: "0",
              sell_tax: "0",
              buy_tax: "0",
              owner_percent: "0",
              creator_percent: "0",
            },
          },
        }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });

  mockHeliusGetLargestAccounts.mockResolvedValue({
    result: {
      value: [
        { address: "holder1", uiAmount: 1000 },
        { address: "holder2", uiAmount: 800 },
        { address: "holder3", uiAmount: 600 },
      ],
    },
  });
  mockHeliusResolveAccountOwners.mockImplementation(async (holders: Record<string, unknown>[]) =>
    holders.map((h: Record<string, unknown>) => ({ ...h, owner: h.owner || h.address }))
  );
  mockHeliusGetMintAccount.mockResolvedValue(mintAccountResponse());
  mockHeliusGetHolderPages.mockResolvedValue(null); // no chain holder count unless a test provides a page
  mockPublicRpcGetMintAccount.mockResolvedValue(null);
  mockHeliusGetCreatorReputation.mockResolvedValue(null);
  mockHeliusGetHoldersCount.mockResolvedValue(null);
  mockHeliusGetProgramAccountHolderCount.mockResolvedValue(null);
  mockPublicRpcGetLargestAccounts.mockResolvedValue(null);
  mockPublicRpcGetTokenSupply.mockResolvedValue(null);
  mockPublicRpcGetMintInfo.mockResolvedValue(null);
  mockFetchSolscan.mockImplementation((endpoint: string) => {
    if (endpoint.includes("meta")) {
      return Promise.resolve({
        data: {
          created_time: Math.floor(Date.now() / 1000) - 90 * 24 * 3600,
          icon: "https://img.test.com/icon.png",
          creator: "creator123",
          decimals: 9,
          supply: 100000,
        },
      });
    }
    if (endpoint.includes("transfer")) {
      return Promise.resolve({ data: [] });
    }
    if (endpoint.includes("markets")) {
      return Promise.resolve({
        data: [{ liquidity: 500000, volume: 200000, trade: 1000, trader: 500 }],
      });
    }
    return Promise.resolve(null);
  });
  mockFetchDexCandles.mockResolvedValue([
    { ts: 1, o: 100, h: 102, l: 98, c: 101, v: 5000 },
    { ts: 2, o: 101, h: 103, l: 99, c: 100, v: 5500 },
    { ts: 3, o: 100, h: 102, l: 98, c: 101, v: 5200 },
    { ts: 4, o: 101, h: 103, l: 99, c: 100, v: 5100 },
    { ts: 5, o: 100, h: 102, l: 98, c: 101, v: 5300 },
    { ts: 6, o: 101, h: 103, l: 99, c: 100, v: 5400 },
    { ts: 7, o: 100, h: 102, l: 98, c: 101, v: 5000 },
    { ts: 8, o: 101, h: 103, l: 99, c: 100, v: 5200 },
    { ts: 9, o: 100, h: 102, l: 98, c: 101, v: 5100 },
    { ts: 10, o: 101, h: 103, l: 99, c: 100, v: 5300 },
  ]);
}

process.env.UPSTASH_REDIS_REST_URL = "https://mock.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";
process.env.HELIUS_API_KEY = "mock-helius-key";

const { default: handler } = await import("../api/scan");

beforeEach(() => {
  vi.clearAllMocks();
});


// ─── HOLDER COUNT + SOLSCAN AVAILABILITY ────────────────────────────────────────
//
// Verified live (BONK): GoPlus holder_count 1,024,740 = GeckoTerminal 1,024,731 (+-10); the RugCheck /report totalHolders
// is 2,088,973 (it counts 2-3x too many on large tokens). Helius getTokenAccounts' `total` is the PAGE size, but a page
// that is not full holds every holder: the chain count is exact for tokens under 1000 holders (BREAK 53, PAPER 37 while
// RugCheck said 173 and 427, because it also counts emptied accounts) - and those are the tokens GoPlus and RugCheck fail
// on. So: the exact chain page first, then GoPlus, then RugCheck, then the full-page floor; never the maximum, and never
// the number of wallets in a top-20 list (that read "20 holders" on tokens with hundreds).
const MINT = "So11111111111111111111111111111111111111112";
// The real /report returns topHolders as an ARRAY of holders.
const REAL_SHAPE_TOP_HOLDERS = [{ address: "a", amount: 1, decimals: 6, pct: 13.7, uiAmount: 1, owner: "o", insider: false }];

function setupUpstream(opts: { goplusHolderCount?: string; rugTotalHolders?: number; solscan?: boolean; heliusPages?: unknown[] | null }) {
  setupGoodTokenMocks();
  if (opts.heliusPages !== undefined) mockHeliusGetHolderPages.mockResolvedValue(opts.heliusPages);
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation((url: string, init?: unknown) => {
    if (url.includes("gopluslabs")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          code: 1,
          result: { [MINT]: { mintable: { status: "0", authority: [] }, freezable: { status: "0", authority: [] }, ...(opts.goplusHolderCount ? { holder_count: opts.goplusHolderCount } : {}) } },
        }),
      });
    }
    if (url.includes("rugcheck") && url.includes("report") && !url.includes("summary")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ risks: [], topHolders: REAL_SHAPE_TOP_HOLDERS, ...(opts.rugTotalHolders !== undefined ? { totalHolders: opts.rugTotalHolders } : {}) }),
      });
    }
    return base(url, init);
  });
  if (opts.solscan === false) mockFetchSolscan.mockResolvedValue(null);
}

async function scan() {
  const res = createMockRes();
  await handler(createMockReq({ ca: MINT }), res);
  return (res as unknown as { getBody: () => unknown }).getBody() as {
    holders: number | null; sources_used: string[]; layers: Record<string, { available: boolean }>;
  };
}

// A real getTokenAccounts answer (HqNtPF3w..., captured 2026-10-10): 53 holders in one page that is NOT full, cursor sent anyway.
const REAL_SMALL_PAGE = JSON.parse(readFileSync(new URL("./fixtures/upstream-real/helius-token-accounts-small.json", import.meta.url), "utf8")) as unknown;
// A FULL page (1000 accounts, same shape as the real one); `k` makes the owners of each page distinct.
const fullPage = (k = 0) => ({ jsonrpc: "2.0", id: "holder-count", result: { total: 1000, limit: 1000, cursor: "next", token_accounts: Array.from({ length: 1000 }, (_, i) => ({ address: `a${k}-${i}`, owner: `o${k}-${i}`, amount: i + 1 })) } });
// A page that is not full: the end of the list (`n` holders).
const lastPage = (n: number, k = 0) => ({ jsonrpc: "2.0", id: "holder-count", result: { total: n, limit: 1000, cursor: "next", token_accounts: Array.from({ length: n }, (_, i) => ({ address: `a${k}-${i}`, owner: `o${k}-${i}`, amount: i + 1 })) } });

describe("holder count: exact chain pages first, then GoPlus, RugCheck, the chain floor; never the top 20", () => {
  it("a token under 1000 holders: the chain count (53) beats an inflated RugCheck total (it counts emptied accounts)", async () => {
    setupUpstream({ heliusPages: [REAL_SMALL_PAGE], rugTotalHolders: 268 });
    expect((await scan()).holders).toBe(53);
  });

  it("RugCheck and GoPlus both silent (the '20 holders' case): the chain count still answers", async () => {
    setupUpstream({ heliusPages: [REAL_SMALL_PAGE] });
    expect((await scan()).holders).toBe(53); // was 3 (the non-empty accounts of the mocked top-20 list) before
  });

  it("asks Helius for the holder pages of the scanned mint", async () => {
    setupUpstream({ heliusPages: [REAL_SMALL_PAGE] });
    await scan();
    expect(mockHeliusGetHolderPages).toHaveBeenCalledTimes(1);
    expect(mockHeliusGetHolderPages.mock.calls[0][0]).toBe(MINT);
  });

  it("a mid-size token (2,347 holders over 3 pages): exact, and GoPlus' overcount (+105 % seen live) and RugCheck's are ignored", async () => {
    setupUpstream({ heliusPages: [fullPage(0), fullPage(1), lastPage(347, 2)], goplusHolderCount: "4800", rugTotalHolders: 8000 });
    expect((await scan()).holders).toBe(2347);
  });

  it("every page up to the cap is full (a token above the cap): GoPlus answers, even when RugCheck reports a larger (inflated) total", async () => {
    setupUpstream({ heliusPages: Array.from({ length: 10 }, (_, k) => fullPage(k)), goplusHolderCount: "1024740", rugTotalHolders: 2088973 });
    expect((await scan()).holders).toBe(1024740);
  });

  it("above the cap and GoPlus silent (rate limited): RugCheck keeps the right order of magnitude", async () => {
    setupUpstream({ heliusPages: Array.from({ length: 10 }, (_, k) => fullPage(k)), rugTotalHolders: 2088973 });
    expect((await scan()).holders).toBe(2088973);
  });

  it("above the cap and nobody else: the floor (10,000 read so far), not the top-20 size", async () => {
    setupUpstream({ heliusPages: Array.from({ length: 10 }, (_, k) => fullPage(k)) });
    expect((await scan()).holders).toBe(10000);
  });

  it("a figure from GoPlus below what the chain already counted is impossible: the floor wins", async () => {
    setupUpstream({ heliusPages: Array.from({ length: 10 }, (_, k) => fullPage(k)), goplusHolderCount: "6000" });
    expect((await scan()).holders).toBe(10000);
  });

  it("a page missing in the middle (Helius rate limit): not exact, so GoPlus decides (never below the pages read)", async () => {
    setupUpstream({ heliusPages: [fullPage(0), fullPage(1), null, lastPage(200, 3)], goplusHolderCount: "3300" });
    expect((await scan()).holders).toBe(3300);
  });

  it("Helius unavailable: GoPlus, then RugCheck, as before", async () => {
    setupUpstream({ heliusPages: null, goplusHolderCount: "777", rugTotalHolders: 478 });
    expect((await scan()).holders).toBe(777);
    setupUpstream({ heliusPages: null, rugTotalHolders: 478 });
    expect((await scan()).holders).toBe(478);
  });

  it("an empty page (index not caught up with a brand-new token) is not a count of 0", async () => {
    setupUpstream({ heliusPages: [{ jsonrpc: "2.0", id: "x", result: { total: 0, limit: 1000, token_accounts: [] } }], rugTotalHolders: 90 });
    expect((await scan()).holders).toBe(90);
  });

  it("nothing counts holders: null (not shown), never the number of wallets in the top-20 list", async () => {
    setupUpstream({});
    expect((await scan()).holders).toBeNull(); // the mocked largest-accounts response has 3 non-empty accounts
  });

  it("a malformed Helius answer is ignored", async () => {
    setupUpstream({ heliusPages: [{ result: { token_accounts: "nope" } }], rugTotalHolders: 478 });
    expect((await scan()).holders).toBe(478);
  });
});

describe("Solscan is only an available source when Solscan answered", () => {
  it("is available when its endpoints return data", async () => {
    setupUpstream({ goplusHolderCount: "100" });
    const body = await scan();
    expect(body.layers.solscan.available).toBe(true);
    expect(body.sources_used).toContain("solscan");
  });

  it("is NOT available when every Solscan call returned nothing (the age then comes from DexScreener)", async () => {
    setupUpstream({ goplusHolderCount: "100", solscan: false });
    const body = await scan();
    expect(body.layers.solscan.available).toBe(false);
    expect(body.sources_used).not.toContain("solscan");
  });
});

// ─── MINT / FREEZE / SELL PILLS: what the overlay receives ────────────────────────
//
// The overlay used to show "Mint check, Freeze check, Sell check" for EVERY token: the pills were derived from flag labels
// that nothing ever produced. They now come from the chain (getAccountInfo on the mint, one Helius call that replaces
// getTokenSupply), with GoPlus as a relay, and "not verified" stays null. Real on-chain mint accounts are used below.
const fxMint = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/upstream-real/mint-${name}.json`, import.meta.url), "utf8"));
const fxGoplus = (name: string): Record<string, unknown> => {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/upstream-real/goplus-${name}.json`, import.meta.url), "utf8")) as { result: Record<string, Record<string, unknown>> };
  return Object.values(raw.result)[0];
};

interface ScanBody {
  risk: string;
  lpBurned: boolean;
  flags: Array<{ label: string; severity: string }>;
  mintAuthority: boolean | null; freezeAuthority: boolean | null; honeypot: boolean | null;
  aiSummary: string | null;
  layers: Record<string, { available: boolean }>;
}

function setupContract(opts: { heliusMint?: unknown; publicMint?: unknown; goplus?: Record<string, unknown> }) {
  setupGoodTokenMocks();
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation((url: string, init?: unknown) => {
    // RugCheck in its REAL shape (the shared harness answers in an older, invented one: topHolders.top10Percentage...),
    // so no legacy comparison muddies what these tests look at.
    if (url.includes("rugcheck") && url.includes("summary")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", risks: [], score: 1, score_normalised: 1, lpLockedPct: 0 }) });
    }
    if (url.includes("gopluslabs")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ code: 1, result: { [MINT]: { holder_count: "100000", dex: [{ burn_percent: 100, tvl: "500000" }], ...opts.goplus } } }),
      });
    }
    return base(url, init);
  });
  mockHeliusGetMintAccount.mockResolvedValue(opts.heliusMint ?? null);
  mockPublicRpcGetMintAccount.mockResolvedValue(opts.publicMint ?? null);
}

async function scanFull(): Promise<ScanBody> {
  const res = createMockRes();
  await handler(createMockReq({ ca: MINT }), res);
  return (res as unknown as { getBody: () => unknown }).getBody() as ScanBody;
}

const GP_CLEAN = { mintable: { status: "0", authority: [] }, freezable: { status: "0", authority: [] } };
const authorityFlags = (b: ScanBody) => b.flags.filter((f) => /authority/i.test(f.label));

describe("pills come from the chain, not from flag labels", () => {
  it("RENDER (mint AND freeze authority active on-chain): both pills are true, the sale is not guaranteed, and the verdict leaves SAFE", async () => {
    setupContract({ heliusMint: fxMint("render"), goplus: fxGoplus("render") });
    const b = await scanFull();
    expect([b.mintAuthority, b.freezeAuthority, b.honeypot]).toEqual([true, true, null]);
    expect(authorityFlags(b).map((f) => f.severity)).toEqual(["critical", "critical"]);
    expect(b.risk).not.toBe("SAFE");
  });

  it("BONK (renounced): pills are false / false / false and no authority flag is raised", async () => {
    setupContract({ heliusMint: fxMint("bonk"), goplus: fxGoplus("bonk") });
    const b = await scanFull();
    expect([b.mintAuthority, b.freezeAuthority, b.honeypot]).toEqual([false, false, false]);
    expect(authorityFlags(b)).toEqual([]);
  });

  it("HNT (mint authority active but GoPlus lists it as trusted): the pill is true, the flag is information, not critical", async () => {
    setupContract({ heliusMint: fxMint("hnt"), goplus: fxGoplus("hnt") });
    const b = await scanFull();
    expect(b.mintAuthority).toBe(true);
    expect(authorityFlags(b).map((f) => f.severity)).toEqual(["info"]);
    expect(b.flags.some((f) => f.severity === "critical" && /authority/i.test(f.label))).toBe(false);
  });

  it("Token-2022: harmless extensions keep the sale verdict false, risky ones make it unknown", async () => {
    setupContract({ heliusMint: fxMint("paper"), goplus: GP_CLEAN });
    expect((await scanFull()).honeypot).toBe(false);
    const risky = JSON.parse(JSON.stringify(fxMint("pyusd"))) as { result: { value: { data: { parsed: { info: { freezeAuthority: string | null } } } } } };
    risky.result.value.data.parsed.info.freezeAuthority = null; // isolate the extensions
    setupContract({ heliusMint: risky, goplus: GP_CLEAN });
    expect((await scanFull()).honeypot).toBeNull();
  });

  it("Helius did not answer: the free public RPC pool provides the same on-chain facts", async () => {
    setupContract({ heliusMint: null, publicMint: fxMint("render"), goplus: GP_CLEAN });
    const b = await scanFull();
    expect([b.mintAuthority, b.freezeAuthority]).toEqual([true, true]);
  });

  it("the chain is unreadable: GoPlus relays the authorities, and the sale stays unknown without its hook / fee fields", async () => {
    setupContract({ goplus: GP_CLEAN });
    const b = await scanFull();
    expect([b.mintAuthority, b.freezeAuthority, b.honeypot]).toEqual([false, false, null]);
  });

  it("nothing readable anywhere: every pill is null (shown as unknown), never false, and no authority flag", async () => {
    setupContract({ goplus: {} });
    const b = await scanFull();
    expect([b.mintAuthority, b.freezeAuthority, b.honeypot]).toEqual([null, null, null]);
    expect(authorityFlags(b)).toEqual([]);
  });

  it("the chain and GoPlus disagree: the chain wins, a warning is raised, and the cross-validation layer is a real source", async () => {
    setupContract({ heliusMint: fxMint("render"), goplus: { mintable: { status: "0" }, freezable: { status: "1" } } });
    const b = await scanFull();
    expect(b.mintAuthority).toBe(true);
    expect(b.flags.some((f) => f.severity === "warning" && /mint authority conflict/i.test(f.label))).toBe(true);
    expect(b.layers.crossvalidation.available).toBe(true);
  });

  it("the cross-validation layer is not available when there was nothing to compare", async () => {
    setupContract({ goplus: GP_CLEAN }); // chain unreadable
    expect((await scanFull()).layers.crossvalidation.available).toBe(false);
  });

  it("asks Helius for the mint account (supply + authorities in one call) and no longer for getTokenSupply", async () => {
    setupContract({ heliusMint: fxMint("bonk"), goplus: GP_CLEAN });
    await scanFull();
    expect(mockHeliusGetMintAccount).toHaveBeenCalledWith(MINT, "mock-helius-key");
    expect(mockHeliusGetTokenSupply).not.toHaveBeenCalled();
  });
});

describe("the summary never narrates what was not verified", () => {
  it("nothing verified: no renounced / revoked / honeypot claim at all", async () => {
    setupContract({ goplus: {} });
    expect((await scanFull()).aiSummary ?? "").not.toMatch(/renounced|revoked|no honeypot/i);
  });

  it("active authorities (RENDER): the summary names an authority", async () => {
    setupContract({ heliusMint: fxMint("render"), goplus: fxGoplus("render") });
    expect((await scanFull()).aiSummary ?? "").toMatch(/(mint|freeze) authority/i);
  });
});

// ─── GOPLUS CREDENTIALS IN THE SCAN ───────────────────────────────────────────────
//
// With GOPLUS_APP_KEY and GOPLUS_APP_SECRET the scan exchanges them for a token (verified live: the token GoPlus returns
// already starts with "Bearer", and adding a second prefix gives code 4012) and calls GoPlus authenticated. Without them,
// or when the exchange fails, it is the same anonymous call as before: credentials can only add headroom.
interface GoplusCall { url: string; method: string; authorization: string | undefined; body: string | undefined }

function setupGoplusAuth(tokenOk: boolean): GoplusCall[] {
  setupGoodTokenMocks();
  const base = mockFetch.getMockImplementation()!;
  const calls: GoplusCall[] = [];
  const reply = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  mockFetch.mockImplementation((url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (!url.includes("gopluslabs")) return base(url, init);
    calls.push({ url, method: init?.method ?? "GET", authorization: init?.headers?.Authorization, body: init?.body });
    if (url.endsWith("/token")) {
      return reply(tokenOk ? { code: 1, message: "ok", result: { access_token: "Bearer tok-123", expires_in: 7200 } } : { code: 4010, message: "bad credentials" });
    }
    const authed = init?.headers?.Authorization === "Bearer tok-123";
    if (init?.headers?.Authorization && !authed) return reply({ code: 4012, message: "signature verification failure" }); // e.g. a doubled Bearer prefix
    return reply({ code: 1, result: { [MINT]: { holder_count: authed ? "777" : "100", mintable: { status: "0" }, freezable: { status: "0" } } } });
  });
  return calls;
}

describe("GoPlus credentials in the scan", () => {
  beforeEach(() => {
    _resetGoPlusAuthForTests();
    process.env.GOPLUS_APP_KEY = "test-app-key";
    process.env.GOPLUS_APP_SECRET = "test-app-secret";
  });
  afterEach(() => {
    _resetGoPlusAuthForTests();
    delete process.env.GOPLUS_APP_KEY;
    delete process.env.GOPLUS_APP_SECRET;
  });

  it("exchanges the credentials once and calls GoPlus with the token exactly as returned (no second Bearer)", async () => {
    const calls = setupGoplusAuth(true);
    const body = await scan();
    expect(body.holders).toBe(777); // the authenticated answer was used
    const exchange = calls.find((c) => c.url.endsWith("/token"));
    expect(exchange?.method).toBe("POST");
    expect(JSON.parse(exchange?.body ?? "{}")).toMatchObject({ app_key: "test-app-key" });
    expect(exchange?.body).not.toContain("test-app-secret"); // the secret never leaves: only the signature does
    const security = calls.filter((c) => c.url.includes("token_security"));
    expect(security).toHaveLength(1);
    expect(security[0].authorization).toBe("Bearer tok-123");
  });

  it("reuses the token on the next scan: a single exchange", async () => {
    const calls = setupGoplusAuth(true);
    await scan();
    await scan();
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("token_security"))).toHaveLength(2);
  });

  it("the exchange fails: the scan still reads GoPlus anonymously and does not fail", async () => {
    const calls = setupGoplusAuth(false);
    const body = await scan();
    expect(body.holders).toBe(100); // the anonymous answer
    const security = calls.filter((c) => c.url.includes("token_security"));
    expect(security).toHaveLength(1);
    expect(security[0].authorization).toBeUndefined();
  });

  it("no credentials: one anonymous call and no token request", async () => {
    delete process.env.GOPLUS_APP_KEY;
    delete process.env.GOPLUS_APP_SECRET;
    const calls = setupGoplusAuth(true);
    const body = await scan();
    expect(body.holders).toBe(100);
    expect(calls.some((c) => c.url.endsWith("/token"))).toBe(false);
    expect(calls.filter((c) => c.url.includes("token_security"))).toHaveLength(1);
  });
});

describe("lpBurned in the response comes from the burn of the measurable liquidity, not from the best single pool", () => {
  it("BONK: not burned (about 28 %: its $5k pool burned at 94 % no longer makes the whole token read as burned)", async () => {
    setupContract({ heliusMint: fxMint("bonk"), goplus: fxGoplus("bonk") });
    const b = await scanFull();
    expect(b.lpBurned).toBe(false);
    expect(b.flags.some((f) => /LP Burned/i.test(f.label))).toBe(false);
  });

  it("WIF: burned", async () => {
    setupContract({ heliusMint: fxMint("bonk"), goplus: fxGoplus("wif") });
    const b = await scanFull();
    expect(b.lpBurned).toBe(true);
    expect(b.flags.some((f) => /LP Burned/i.test(f.label))).toBe(true);
  });
});

// A preview deployment (a pull request, the e2e tests) shares production's Upstash database: its scans must not write
// into the rug database, which lists tokens for real users for 90 days (see api/_lib/deployment.ts).
describe("the rug database is written by production, never by a preview deployment", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("a scan on production (or a local run) records the token", async () => {
    mockRecordRug.mockClear();
    vi.stubEnv("VERCEL_ENV", "production");
    setupUpstream({ goplusHolderCount: "100" });
    await scan();
    expect(mockRecordRug).toHaveBeenCalledTimes(1);
  });

  it("a scan on a preview deployment records nothing", async () => {
    mockRecordRug.mockClear();
    vi.stubEnv("VERCEL_ENV", "preview");
    setupUpstream({ goplusHolderCount: "100" });
    const body = await scan();
    expect(body.holders).toBe(100); // the scan itself ran normally
    expect(mockRecordRug).not.toHaveBeenCalled();
  });
});
