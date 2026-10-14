import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import type { VercelRequest, VercelResponse } from "@vercel/node";

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
  // The memory of the last time an issuer-backed token's market was read: none by default.
  getLastGoodResult: vi.fn().mockResolvedValue(null),
  setLastGoodResult: vi.fn(),
  // Single-flight lock: acquire always wins (fail-open), waiter no-ops, in
  // unit tests so the handler proceeds straight to runAnalysis as before.
  acquireScanLock: vi.fn().mockResolvedValue(true),
  releaseScanLock: vi.fn().mockResolvedValue(undefined),
  waitForCachedResult: vi.fn().mockResolvedValue(null),
  getCacheRedis: vi.fn().mockReturnValue({ setex: mockSetex }),
}));

// The rug database and the scan history: observed (a scan with a silent source has no verdict, so it is written into neither).
const mockRecordRug = vi.fn();
vi.mock("../api/_lib/rugdb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/_lib/rugdb")>();
  return { ...actual, recordRug: (...args: unknown[]) => mockRecordRug(...args) };
});
// The verdict the engine reached can be forced by a test (null: the real one). The layers are always the real ones.
const forced = vi.hoisted(() => ({ verdict: null as null | "SAFE" | "CAUTION" | "DANGER" | "RUG" }));
vi.mock("../api/_lib/decide", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/_lib/decide")>();
  const SCORES = { SAFE: 996, CAUTION: 850, DANGER: 500, RUG: 100 } as const;
  return {
    ...actual,
    decide: (...args: Parameters<typeof actual.decide>) => {
      const real = actual.decide(...args);
      if (!forced.verdict) return real;
      return { ...real, risk: forced.verdict, score: SCORES[forced.verdict], rugKind: forced.verdict === "RUG" ? "risk" : null };
    },
  };
});
const mockPushHistory = vi.fn();
vi.mock("../api/_lib/user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/_lib/user")>();
  return { ...actual, pushScanHistory: (...args: unknown[]) => mockPushHistory(...args) };
});

// What the handler counts for the share of Limited data scans (api/_lib/usage.ts recordScanOutcome): the causes, or none.
const mockRecordScanOutcome = vi.fn();
vi.mock("../api/_lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/_lib/usage")>();
  return { ...actual, recordScanOutcome: (...args: unknown[]) => mockRecordScanOutcome(...args) };
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
  heliusGetHolderPages: vi.fn().mockResolvedValue(null), // no chain holder count in these tests
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
    headers: { origin: "https://dexscreener.com", "x-forwarded-for": "1.2.3.4", "x-antares-install": "test-pro-install-0001" },
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
// These tests read the FULL scan, which only a Pro caller receives (api/_lib/pro-gate.ts): this install is a Pro one (the dev escape hatch).
process.env.DEV_PRO_INSTALLS = "test-pro-install-0001";

const { default: handler } = await import("../api/scan");
const { _resetCircuitBreakersForTests } = await import("../api/_lib/http");
const { noteSourceFailure, OUTAGE_THRESHOLD } = await import("../api/_lib/outage");
/** A source is DOWN (outage.ts): enough failed calls within the minute. The mocks below make a source silent; this makes the silence an outage. */
const OUTAGE_HOST = { helius: "mainnet.helius-rpc.com", rugcheck: "api.rugcheck.xyz", goplus: "api.gopluslabs.io" } as const;
const declareOutage = (source: keyof typeof OUTAGE_HOST) => { for (let i = 0; i < OUTAGE_THRESHOLD[source]; i++) noteSourceFailure(OUTAGE_HOST[source]); };
// The cache module is mocked above; import it AFTER the mock variables exist.
const { acquireScanLock, waitForCachedResult, getCachedResult, setCachedResult, setShortCachedResult, getLastGoodResult, setLastGoodResult, getCacheRedis } = await import("../api/_lib/cache");

// ─── Deadline behaviour ──────────────────────────────────────────────────────
// With every upstream merely SLOW (not down) the scan used to reach the global
// timer at the same instant it finished and answered 504; waiters on the
// single-flight lock gave up after a fixed 18 s and each started its own full
// scan. The scan now keeps a reserve at the end of its budget, only starts a
// serial step that can still finish, and waiters wait until their own deadline.

const GLOBAL_MS = 24000;
const WSOL = "So11111111111111111111111111111111111111112";

beforeEach(() => {
  vi.clearAllMocks();
  forced.verdict = null;
  _resetCircuitBreakersForTests(); // a host that failed in one test (a 503 for RugCheck) must not be silent in the next: the clock is frozen
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  vi.mocked(acquireScanLock).mockResolvedValue(true);
  vi.mocked(waitForCachedResult).mockResolvedValue(null);
  vi.mocked(getCachedResult).mockReset();
  vi.mocked(getCachedResult).mockResolvedValue(null);
  vi.mocked(getLastGoodResult).mockReset();
  vi.mocked(getLastGoodResult).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

async function run(req: VercelRequest, res: VercelResponse, advanceMs = GLOBAL_MS + 1000) {
  const started = Date.now();
  let doneAt = -1;
  const p = handler(req, res).then(() => { doneAt = Date.now(); });
  await vi.advanceTimersByTimeAsync(advanceMs);
  await p;
  return { elapsedMs: doneAt - started };
}

const jsonBody = (res: VercelResponse) => (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown> | undefined;

// ─── A scan made while a data source did not answer has no verdict for the user ─────────────────────────────────────────────
// 2026-10-14: replayed on the 1 121 tokens of the replay corpus with ONE source silent at a time, the verdict a scan reaches without it is not the token's:
// without Helius 172 SAFE read CAUTION and 132 RUG read DANGER, without RugCheck 4 DANGER read SAFE, without GoPlus 21 SAFE read CAUTION. So such a scan is
// MARKED (`sourceGap`): the overlay shows "Limited data" instead of a verdict, counts down and asks again; the badge, the alerts, the history and the rug
// database ignore it. The mark is sent to Free callers too (the flags that say which source are Pro).
// 2026-10-14 evening: it is marked only when HELIUS is down (the source that moves the verdict: 387 of the 1 121), or when TWO of the three sources are down at the
// same time. RugCheck alone (13 verdicts move, and it answered nothing for the established tokens for hours: 5 tokens out of 8 open were "Limited data") or GoPlus
// alone (63) keeps the scan as it was before the feature: its verdict, its flag ("RugCheck unavailable" for Pro), cached for the usual time, recorded as usual.

const freeReq = (): VercelRequest => {
  const req = createMockReq({ ca: WSOL });
  (req as unknown as { headers: Record<string, string> }).headers["x-antares-install"] = "free-install-source-gap-0001";
  return req;
};

const { isScanIncomplete, isChartGapDegraded, isReportGapDegraded } = await import("../api/_lib/helpers");
// What the extension reads of the answer: the overlay (resilience.sourceGapOf: Limited data card) and the badge, the alerts and the history (scan-report).
const { sourceGapOf } = await import("../contents/modules/resilience");
const { buildScanResultMessage } = await import("../contents/modules/scan-report");

describe("isScanIncomplete: a source that is DOWN x every verdict (a last resort)", () => {
  const VERDICTS = ["SAFE", "CAUTION", "DANGER", "RUG"] as const;
  const SOURCES = ["dexscreener", "rugcheck", "goplus", "helius", "solscan", "chart"];
  const layersWith = (missing: string[]) => Object.fromEntries(SOURCES.map((n) => [n, { available: !missing.includes(n) }]));
  const DOWN_ALL = { helius: true, rugcheck: true, goplus: true };

  // The rule does not look at the verdict: it is the same for the four, which is what the title says (a token flipping from one verdict to another is not credible).
  describe.each(VERDICTS)("a scan that reached %s", () => {
    it.each([
      ["Helius", ["helius"]],
      ["Helius + GoPlus", ["helius", "goplus"]],
      ["Helius + RugCheck", ["helius", "rugcheck"]],
      ["RugCheck + GoPlus (two sources at once)", ["rugcheck", "goplus"]],
      ["Helius + RugCheck + GoPlus", ["helius", "rugcheck", "goplus"]],
    ])("%s silent AND down: marked, whatever the verdict (no verdict is shown for it)", (_name, missing) => {
      expect(isScanIncomplete({ layers: layersWith(missing), down: DOWN_ALL })).toBe(true);
    });

    it.each([
      ["RugCheck", ["rugcheck"]],
      ["GoPlus", ["goplus"]],
    ])("%s silent AND down, but ALONE (the other two answered): not marked, the scan keeps its verdict and its flag", (_name, missing) => {
      expect(isScanIncomplete({ layers: layersWith(missing), down: DOWN_ALL })).toBe(false);
    });

    it.each([
      ["Helius", ["helius"]],
      ["RugCheck", ["rugcheck"]],
      ["GoPlus", ["goplus"]],
      ["all three", ["helius", "rugcheck", "goplus"]],
    ])("%s silent but NOT down (it answered with nothing for this token: BONK, a brand-new token): not marked, the scan keeps its verdict and its flags", (_name, missing) => {
      expect(isScanIncomplete({ layers: layersWith(missing), down: {} })).toBe(false);
    });

    it("every source answered: complete, even while a source is down elsewhere", () => {
      expect(isScanIncomplete({ layers: layersWith([]), down: {} })).toBe(false);
      expect(isScanIncomplete({ layers: layersWith([]), down: DOWN_ALL })).toBe(false);
    });

    it("DexScreener, Solscan or the chart silent: never marked, down or not (not in the rule)", () => {
      for (const missing of [["dexscreener"], ["solscan"], ["chart"]]) expect(isScanIncomplete({ layers: layersWith(missing), down: DOWN_ALL })).toBe(false);
    });
  });

  it("a response with no layers assumes nothing", () => {
    expect(isScanIncomplete({ layers: undefined, down: DOWN_ALL })).toBe(false);
  });

  it("the chart of an old token and the RugCheck report of a pair address keep their own caching rule (degraded), and are not outages: they do not make a scan Limited data", () => {
    // isChartGapDegraded / isReportGapDegraded are unchanged (they only shorten the cache); they are no input of the rule any more.
    expect(isChartGapDegraded("SAFE", false, 100_000)).toBe(true);
    expect(isReportGapDegraded("SAFE", true, false)).toBe(true);
    expect(isScanIncomplete({ layers: layersWith(["chart"]), down: {} })).toBe(false);
  });
});

describe("scan — a source did not answer", () => {
  const silences: Array<[string, () => void]> = [
    ["Helius", () => { mockHeliusGetLargestAccounts.mockResolvedValue(null); mockHeliusGetMintAccount.mockResolvedValue(null); declareOutage("helius"); }],
    ["RugCheck", () => {
      const good = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
        String(url).includes("rugcheck") ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }) : good(url, ...rest));
      declareOutage("rugcheck");
    }],
    ["GoPlus", () => {
      const good = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
        String(url).includes("gopluslabs") ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }) : good(url, ...rest));
      declareOutage("goplus");
    }],
  ];

  it("witness: every source answered: not marked, kept for the full TTL, recorded, in the history", async () => {
    setupGoodTokenMocks();
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    const body = jsonBody(res);
    expect(body?.sourceGap).toBe(false);
    expect(body?.degraded).toBe(false);
    expect(vi.mocked(setCachedResult)).toHaveBeenCalled();
    expect(mockRecordRug).toHaveBeenCalledTimes(1);
    expect(mockPushHistory).toHaveBeenCalledTimes(1);
  });

  // The scans that ARE Limited data: Helius down, or two sources down at once. (RugCheck alone or GoPlus alone: see "DOWN, alone" below.)
  const marked: Array<[string, () => void]> = [
    ["Helius", silences[0][1]],
    ["RugCheck + GoPlus", () => { silences[1][1](); silences[2][1](); }],
  ];

  for (const [name, silence] of marked) {
    it(name + " silent | Pro: marked, degraded, kept 30 s, written nowhere (not the rug database, not the history, not the memory)", async () => {
      setupGoodTokenMocks();
      silence();
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      const body = jsonBody(res);
      expect(body?.sourceGap).toBe(true);
      expect(body?.degraded).toBe(true);
      expect(body?.freshForSec).toBe(30); // the overlay's countdown is counted from this answer
      expect(vi.mocked(setShortCachedResult)).toHaveBeenCalled();
      expect(vi.mocked(setCachedResult)).not.toHaveBeenCalled();
      expect(mockRecordRug).not.toHaveBeenCalled();
      expect(mockPushHistory).not.toHaveBeenCalled();
      expect(vi.mocked(setLastGoodResult)).not.toHaveBeenCalled();
    });

    it(name + " silent | Free: the mark too, and still no analysis (which source it is stays Pro)", async () => {
      setupGoodTokenMocks();
      silence();
      const res = createMockRes();
      await run(freeReq(), res);
      const body = (res as unknown as { getBody: () => Record<string, unknown> }).getBody();
      expect(body?.proLocked).toBe(true);
      expect(body?.sourceGap).toBe(true);
      expect(body?.freshForSec).toBe(30);
      expect(body?.layers).toBeUndefined();
      expect(body?.aiSummary).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/Helius|RugCheck|GoPlus|holder concentration/i);
    });
  }

  // 2026-10-14: RugCheck answered nothing for the established tokens for hours, GoPlus can do the same: ONE of them down is not "Limited data". The scan is what it was
  // before the feature: the verdict, the flag, cached for the usual time, recorded and in the history.
  for (const [name, silence] of [silences[1], silences[2]]) {
    it(name + " DOWN, alone | Pro: the verdict as before, not marked, cached for the usual time, recorded and in the history", async () => {
      setupGoodTokenMocks();
      silence();
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      const body = jsonBody(res);
      expect(body?.sourceGap).toBe(false);
      expect(sourceGapOf(body as never)).toBe(false);
      expect(body?.freshForSec).not.toBe(30);
      expect(vi.mocked(setCachedResult)).toHaveBeenCalled();
      expect(mockRecordRug).toHaveBeenCalledTimes(1);
      expect(mockPushHistory).toHaveBeenCalledTimes(1);
      expect(mockRecordScanOutcome.mock.calls[0][0]).toEqual([]); // counted as a cold scan, with no cause
    });

    it(name + " DOWN, alone | Free: not marked either, the same verdict word as Pro", async () => {
      setupGoodTokenMocks();
      silence();
      const pro = createMockRes();
      await run(createMockReq({ ca: WSOL }), pro);
      setupGoodTokenMocks();
      silence();
      const free = createMockRes();
      await run(freeReq(), free);
      const body = (free as unknown as { getBody: () => Record<string, unknown> }).getBody();
      expect(body?.sourceGap).toBe(false);
      expect(sourceGapOf(body as never)).toBe(false);
      expect(body?.risk).toBe(jsonBody(pro)?.risk);
    });
  }

  describe("the emergency switch (LIMITED_DATA=off)", () => {
    const saved = process.env.LIMITED_DATA;
    afterEach(() => { if (saved === undefined) delete process.env.LIMITED_DATA; else process.env.LIMITED_DATA = saved; });

    for (const [name, silence] of marked) {
      it(name + " silent with the switch off: not marked, the engine's verdict as before, still degraded (cached 30 s), recorded and in the history as before", async () => {
        process.env.LIMITED_DATA = "off";
        setupGoodTokenMocks();
        silence();
        const res = createMockRes();
        await run(createMockReq({ ca: WSOL }), res);
        const body = jsonBody(res);
        expect(body?.sourceGap).toBe(false);
        expect(body?.degraded).toBe(true);
        expect(body?.freshForSec).toBe(30);
        expect(vi.mocked(setShortCachedResult)).toHaveBeenCalled();
        expect(mockRecordRug).toHaveBeenCalledTimes(1);
        expect(mockPushHistory).toHaveBeenCalledTimes(1);
      });
    }

    it("a Free caller gets no mark either, and the extension would show the verdict, not the Limited data card", async () => {
      process.env.LIMITED_DATA = "off";
      setupGoodTokenMocks();
      silences[0][1]();
      const res = createMockRes();
      await run(freeReq(), res);
      const body = (res as unknown as { getBody: () => Record<string, unknown> }).getBody();
      expect(body?.sourceGap).toBe(false);
      expect(sourceGapOf(body as never)).toBe(false);
    });

    it("witness: switched back on (or never off), the same silent source is marked again", async () => {
      process.env.LIMITED_DATA = "on";
      setupGoodTokenMocks();
      silences[0][1]();
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      expect(jsonBody(res)?.sourceGap).toBe(true);
    });
  });

  it("the handler counts every cold scan, with the causes when it was answered Limited data", async () => {
    // complete
    setupGoodTokenMocks();
    await run(createMockReq({ ca: WSOL }), createMockRes());
    expect(mockRecordScanOutcome).toHaveBeenLastCalledWith([]);
    // one source at a time, then two
    for (const [name, silence] of silences) {
      mockRecordScanOutcome.mockClear();
      setupGoodTokenMocks();
      silence();
      await run(createMockReq({ ca: WSOL }), createMockRes());
      expect(mockRecordScanOutcome, name).toHaveBeenCalledTimes(1);
      expect(mockRecordScanOutcome.mock.calls[0][0], name).toEqual(name === "Helius" ? ["helius"] : []); // RugCheck or GoPlus alone: no cause, it is not Limited data
    }
    mockRecordScanOutcome.mockClear();
    setupGoodTokenMocks();
    silences[0][1](); // Helius
    silences[2][1](); // GoPlus
    await run(createMockReq({ ca: WSOL }), createMockRes());
    expect(mockRecordScanOutcome.mock.calls[0][0]).toEqual(["helius", "goplus"]);
    mockRecordScanOutcome.mockClear();
    setupGoodTokenMocks();
    silences[1][1](); // RugCheck
    silences[2][1](); // GoPlus
    await run(createMockReq({ ca: WSOL }), createMockRes());
    expect(mockRecordScanOutcome.mock.calls[0][0]).toEqual(["rugcheck", "goplus"]);
  });

  it("the chart silent on an old token, or a source with nothing for this token, is no outage: the scan is counted (a cold scan) with no cause", async () => {
    setupGoodTokenMocks();
    mockFetchDexCandles.mockResolvedValue([]);
    await run(createMockReq({ ca: WSOL }), createMockRes());
    expect(mockRecordScanOutcome).toHaveBeenLastCalledWith([]);
    mockRecordScanOutcome.mockClear();
    setupGoodTokenMocks();
    mockHeliusGetLargestAccounts.mockResolvedValue(null); // Helius has nothing for this token, and has not failed
    mockHeliusGetMintAccount.mockResolvedValue(null);
    await run(createMockReq({ ca: WSOL }), createMockRes());
    expect(mockRecordScanOutcome).toHaveBeenLastCalledWith([]);
  });

  it("a Free caller's scan is counted exactly like a Pro one", async () => {
    setupGoodTokenMocks();
    silences[0][1]();
    await run(freeReq(), createMockRes());
    expect(mockRecordScanOutcome.mock.calls[0][0]).toEqual(["helius"]);
  });

  it("DexScreener silent: not marked (no pool cannot be told from a token that has none), as before", async () => {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes("dexscreener") ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: null }) }) : good(url, ...rest));
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    expect(jsonBody(res)?.sourceGap).toBe(false);
  });

  it("Solscan silent: nothing changes at all (it only gives the token's age and holder count)", async () => {
    setupGoodTokenMocks();
    const withSolscan = createMockRes();
    await run(createMockReq({ ca: WSOL }), withSolscan);
    setupGoodTokenMocks();
    mockFetchSolscan.mockResolvedValue(null);
    const without = createMockRes();
    await run(createMockReq({ ca: WSOL }), without);
    const a = jsonBody(withSolscan);
    const b = jsonBody(without);
    expect(b?.risk).toBe(a?.risk);
    expect(b?.score).toBe(a?.score);
    expect(b?.sourceGap).toBe(a?.sourceGap);
    expect(b?.degraded).toBe(a?.degraded);
  });

  it("the chart silent on an old token that read SAFE or CAUTION: NOT marked (not an outage: a rate limit, a dead token), but still cached only 30 s as before", async () => {
    setupGoodTokenMocks();
    mockFetchDexCandles.mockResolvedValue([]);
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    expect(["SAFE", "CAUTION"]).toContain(jsonBody(res)?.risk);
    expect(jsonBody(res)?.sourceGap).toBe(false);
    expect(jsonBody(res)?.degraded).toBe(true);
    expect(vi.mocked(setShortCachedResult)).toHaveBeenCalled();
  });

  // ─── LAST RESORT: a source without data for THIS token is not an outage ──────────────────────────────────────────────────────────────────
  // 2026-10-14, on the previews: BONK and JUP answered "Limited data" every time, scanned alone, because Helius does not give the holders of a token with millions of
  // them. Nothing was down. "Limited data" is for a source that does not ANSWER (several failed calls within the minute); a source that answered with nothing for this
  // token keeps the scan as it was before: its verdict, its flag ("Holder concentration unverified" for Pro), cached for the usual time, recorded as usual.
  describe("a source that answered with nothing for this token is not an outage", () => {
    const answeredNothing: Array<[string, () => void]> = [
      ["Helius (no holder list, as for BONK)", () => { mockHeliusGetLargestAccounts.mockResolvedValue(null); mockHeliusGetMintAccount.mockResolvedValue(null); }],
      ["RugCheck (404: it does not know the token)", () => {
        const good = mockFetch.getMockImplementation()!;
        mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
          String(url).includes("rugcheck") ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }) : good(url, ...rest));
      }],
      ["GoPlus (404: no entry for the token)", () => {
        const good = mockFetch.getMockImplementation()!;
        mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
          String(url).includes("gopluslabs") ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }) : good(url, ...rest));
      }],
    ];

    for (const [name, silence] of answeredNothing) {
      it(name + " | Pro: not marked, the engine's verdict as before, cached for the usual time, recorded and in the history", async () => {
        setupGoodTokenMocks();
        silence();
        const res = createMockRes();
        await run(createMockReq({ ca: WSOL }), res);
        const body = jsonBody(res);
        expect(body?.sourceGap).toBe(false);
        expect(sourceGapOf(body as never)).toBe(false); // the overlay shows the verdict, not the Limited data card
        expect(body?.freshForSec).not.toBe(30);
        expect(vi.mocked(setCachedResult)).toHaveBeenCalled();
        expect(mockRecordRug).toHaveBeenCalledTimes(1);
        expect(mockPushHistory).toHaveBeenCalledTimes(1);
      });

      it(name + " | Free: not marked either", async () => {
        setupGoodTokenMocks();
        silence();
        const res = createMockRes();
        await run(freeReq(), res);
        const body = (res as unknown as { getBody: () => Record<string, unknown> }).getBody();
        expect(body?.sourceGap).toBe(false);
        expect(sourceGapOf(body as never)).toBe(false);
      });
    }

    it("Helius without a holder list: Pro still reads the flag that says so, and Free reads the same verdict word as Pro (the scan is as before)", async () => {
      setupGoodTokenMocks();
      answeredNothing[0][1]();
      const pro = createMockRes();
      await run(createMockReq({ ca: WSOL }), pro);
      expect((jsonBody(pro)?.flags as Array<{ label: string }>).some((f) => /holder concentration unverified/i.test(f.label))).toBe(true);
      setupGoodTokenMocks();
      answeredNothing[0][1]();
      const free = createMockRes();
      await run(freeReq(), free);
      const freeBody = (free as unknown as { getBody: () => { risk: string } }).getBody();
      expect(freeBody.risk).toBe(jsonBody(pro)?.risk);
    });
  });

  describe("a real outage: several failed calls within the minute", () => {
    const fail503 = (host: string) => {
      const good = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
        String(url).includes(host) ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }) : good(url, ...rest));
    };

    it("RugCheck failing for real (no seeding), alone: its calls of this scan are the outage, but ONE source is not enough: the scan keeps its verdict and its flag", async () => {
      setupGoodTokenMocks();
      fail503("rugcheck");
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      expect(jsonBody(res)?.sourceGap).toBe(false);
      expect(((jsonBody(res)?.layers ?? {}) as Record<string, { available: boolean }>).rugcheck?.available).toBe(false);
    });

    it("GoPlus failing for real (no seeding), alone: a lookup makes two calls, the authenticated one and the public one, both failing is the outage, but ONE source is not enough", async () => {
      setupGoodTokenMocks();
      fail503("gopluslabs");
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      expect(jsonBody(res)?.sourceGap).toBe(false);
    });

    it("RugCheck AND GoPlus failing for real at the same time (no seeding): two sources at once, so the scan is Limited data", async () => {
      setupGoodTokenMocks();
      fail503("rugcheck");
      fail503("gopluslabs");
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      expect(jsonBody(res)?.sourceGap).toBe(true);
    });

    it("the outage ends: a minute later the same silent source, now with nothing for the token (no new failure), is not an outage any more", async () => {
      declareOutage("helius");
      await vi.advanceTimersByTimeAsync(61_000);
      setupGoodTokenMocks();
      mockHeliusGetLargestAccounts.mockResolvedValue(null);
      mockHeliusGetMintAccount.mockResolvedValue(null);
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      expect(jsonBody(res)?.sourceGap).toBe(false);
    });

    it("an outage of a source that DID answer in this scan changes nothing (Helius down, but this token's holders came back)", async () => {
      declareOutage("helius");
      setupGoodTokenMocks();
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      expect(jsonBody(res)?.sourceGap).toBe(false);
    });
  });

  it("a scan with a silent source is never the memory of an issuer's asset (a verdict born from it is not the token's)", async () => {
    setupGoodTokenMocks();
    mockHeliusGetLargestAccounts.mockResolvedValue(null);
    mockHeliusGetMintAccount.mockResolvedValue(null);
    await run(createMockReq({ ca: WSOL }), createMockRes());
    expect(vi.mocked(setLastGoodResult)).not.toHaveBeenCalled();
  });

  it("a verdict served again from memory (an issuer's asset, DexScreener silent) is not a Limited data answer, whatever else was silent: it is not counted as one", async () => {
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // in the issuer registry (stable)
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes("dexscreener") ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: null }) }) : good(url, ...rest));
    mockHeliusGetLargestAccounts.mockResolvedValue(null);
    mockHeliusGetMintAccount.mockResolvedValue(null);
    vi.mocked(getLastGoodResult).mockResolvedValueOnce({
      score: 850, risk: "CAUTION", rugKind: null, flags: [], pair: null, resolvedMint: USDC, confidence: 90, sources_used: ["dexscreener", "rugcheck", "goplus", "helius"],
      tokenSymbol: "USDC", tokenName: "USD Coin", priceUsd: 1.0001, liquidity: 52_000_000, fetchedAt: Date.now() - 6 * 60_000, requestId: "old",
    } as never);
    const res = createMockRes();
    await run(createMockReq({ ca: USDC }), res);
    const body = jsonBody(res);
    expect(body?.servedFromMemory).toBe(true);
    expect(body?.sourceGap).toBe(false); // the overlay shows "Scanned 6 min ago", not the Limited data card
    expect(mockRecordScanOutcome).toHaveBeenCalledTimes(1);
    expect(mockRecordScanOutcome.mock.calls[0][0]).toEqual([]);
  });
});

// ─── THE GUARANTEE: a source is silent -> Limited data, whatever the verdict, Free or Pro ────────────────────────────────────────────────
// Every silent source (and combinations of them) x every verdict the engine can reach x Free and Pro, through the whole handler: the real engine decides which
// source is silent; the verdict it reached is forced. What the extension reads of the answer is checked with the extension's own code: the overlay shows the
// Limited data card for it (sourceGapOf), and the badge, the alerts and the history hear nothing of it (buildScanResultMessage), nor the rug database.

describe("a silent source: Limited data, whatever the verdict, Free or Pro", () => {
  const VERDICTS = ["SAFE", "CAUTION", "DANGER", "RUG"] as const;
  const down = (host: string) => {
    const good = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes(host) ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }) : good(url, ...rest));
    declareOutage(host === "gopluslabs" ? "goplus" : "rugcheck"); // a silent source is DOWN: several failed calls within the minute (outage.ts)
  };
  const heliusDown = () => { mockHeliusGetLargestAccounts.mockResolvedValue(null); mockHeliusGetMintAccount.mockResolvedValue(null); declareOutage("helius"); };
  const SILENCES: Array<[string, () => void]> = [
    ["Helius", () => heliusDown()],
    ["Helius + GoPlus", () => { heliusDown(); down("gopluslabs"); }],
    ["Helius + RugCheck", () => { heliusDown(); down("rugcheck"); }],
    ["RugCheck + GoPlus (two sources at once)", () => { down("rugcheck"); down("gopluslabs"); }],
    ["Helius + RugCheck + GoPlus", () => { heliusDown(); down("rugcheck"); down("gopluslabs"); }],
  ];
  const bodyOf = (res: VercelResponse, tier: "pro" | "free") =>
    (tier === "free" ? (res as unknown as { getBody: () => Record<string, unknown> }).getBody() : jsonBody(res)) as Record<string, unknown>;

  for (const [name, silence] of SILENCES) {
    for (const verdict of VERDICTS) {
      for (const tier of ["pro", "free"] as const) {
        it(name + " silent | the engine reached " + verdict + " | " + tier + ": Limited data, and nothing is told to the badge, the alerts, the history or the rug database", async () => {
          forced.verdict = verdict;
          setupGoodTokenMocks();
          silence();
          const res = createMockRes();
          await run(tier === "free" ? freeReq() : createMockReq({ ca: WSOL }), res);
          const body = bodyOf(res, tier);
          // the tier is the one asked for
          expect(body.proLocked === true).toBe(tier === "free");
          // the mark the overlay reads, Free included
          expect(body.sourceGap).toBe(true);
          expect(sourceGapOf(body)).toBe(true);
          expect(body.degraded).toBe(true);
          expect(body.freshForSec).toBe(30);
          // the extension's other surfaces
          expect(buildScanResultMessage(WSOL, body as never)).toBeNull();
          expect(mockRecordRug).not.toHaveBeenCalled();
          expect(mockPushHistory).not.toHaveBeenCalled();
          // and it is kept for 30 s only, never as the memory of a verdict
          expect(vi.mocked(setCachedResult)).not.toHaveBeenCalled();
          expect(vi.mocked(setLastGoodResult)).not.toHaveBeenCalled();
        });
      }
    }
  }

  // ONE of RugCheck or GoPlus down is not enough (2026-10-14: RugCheck answered nothing for the established tokens for hours, 5 tokens out of 8 open at once were
  // "Limited data"). The scan keeps its verdict and, for Pro, the flag that says the source is unavailable; badge, alerts, history and rug database hear of it as before.
  for (const [name, silence] of [["RugCheck", () => down("rugcheck")], ["GoPlus", () => down("gopluslabs")]] as Array<[string, () => void]>) {
    for (const verdict of VERDICTS) {
      for (const tier of ["pro", "free"] as const) {
        it(name + " DOWN, alone | the engine reached " + verdict + " | " + tier + ": the verdict, never Limited data; badge, history and rug database are told", async () => {
          forced.verdict = verdict;
          setupGoodTokenMocks();
          silence();
          const res = createMockRes();
          await run(tier === "free" ? freeReq() : createMockReq({ ca: WSOL }), res);
          const body = bodyOf(res, tier);
          expect(body.risk).toBe(verdict);
          expect(body.sourceGap).toBe(false);
          expect(sourceGapOf(body)).toBe(false);
          expect(body.freshForSec).not.toBe(30);
          expect(buildScanResultMessage(WSOL, body as never)?.risk).toBe(verdict);
          expect(mockRecordRug).toHaveBeenCalledTimes(1);
          expect(mockPushHistory).toHaveBeenCalledTimes(1);
        });
      }
    }
  }

  // The other half of the credibility: it never shows when every source answered.
  for (const verdict of VERDICTS) {
    for (const tier of ["pro", "free"] as const) {
      it("every source answered | " + verdict + " | " + tier + ": the verdict, never Limited data; badge, alerts, history and rug database are told", async () => {
        forced.verdict = verdict;
        setupGoodTokenMocks();
        const res = createMockRes();
        await run(tier === "free" ? freeReq() : createMockReq({ ca: WSOL }), res);
        const body = bodyOf(res, tier);
        expect(body.risk).toBe(verdict);
        expect(body.sourceGap).toBe(false);
        expect(sourceGapOf(body)).toBe(false);
        expect(body.degraded).toBe(false);
        expect(buildScanResultMessage(WSOL, body as never)?.risk).toBe(verdict);
        expect(mockRecordRug).toHaveBeenCalledTimes(1);
        expect(mockPushHistory).toHaveBeenCalledTimes(1);
        expect(vi.mocked(setCachedResult)).toHaveBeenCalled();
      });
    }
  }
});

// ─── WHEN DOES "LIMITED DATA" ACTIVATE? Every verdict x every missing source x how it is missing x Free and Pro ──────────────────────────────────────────────
// "Limited data" is a last resort. It must show for a real outage and for nothing else, so that a token is never seen switching from one verdict to another, and never
// shows because a source has nothing for one token. This is the whole table, through the real handler (the real engine decides which layer is silent; the verdict it
// reached is forced so that every verdict is covered). Set LIMITED_MATRIX_REPORT=<file> to also write the table as markdown (the file is read in the morning, not the tests).
//
//   how it is missing (the state of the outage ledger, api/_lib/outage.ts, when the scan ends):
//     nothing  the source answered with nothing for this token (a 200 with no data, a 404): no failed call. The scan keeps its verdict and its flags.
//     blip     one failed call fewer than the threshold within the minute: a blip.
//     outage   the threshold of failed calls within the minute (Helius 3, RugCheck 2, GoPlus 2): the source is DOWN.
//     ended    the same failures, but more than a minute ago: the outage is over.
//   which source: HELIUS alone can make a scan Limited data (only in the "outage" state); RugCheck and GoPlus only together, or with Helius (the combinations below);
//   Solscan, DexScreener and the chart never do.

describe("WHEN Limited data activates: verdict x missing source x how it is missing x tier", () => {
  const VERDICTS = ["SAFE", "CAUTION", "DANGER", "RUG"] as const;
  const TIERS = ["pro", "free"] as const;
  const SOURCES = ["helius", "rugcheck", "goplus", "solscan", "dexscreener", "chart"] as const;
  const MODES = ["nothing", "blip", "outage", "ended"] as const;
  type Source = (typeof SOURCES)[number];
  type Mode = (typeof MODES)[number];
  const DECIDES: ReadonlySet<Source> = new Set(["helius", "rugcheck", "goplus"]);

  /** The host whose failures the outage ledger would keep for this source (Solscan, DexScreener and the chart are not tracked: the ledger ignores them). */
  const HOST: Record<Source, string> = {
    helius: "mainnet.helius-rpc.com", rugcheck: "api.rugcheck.xyz", goplus: "api.gopluslabs.io",
    solscan: "pro-api.solscan.io", dexscreener: "api.dexscreener.com", chart: "api.geckoterminal.com",
  };
  const threshold = (src: Source): number => (DECIDES.has(src) ? OUTAGE_THRESHOLD[src as "helius" | "rugcheck" | "goplus"] : 3);

  /** Make the source silent in THIS scan: its layer is unavailable (the source answered with nothing, or did not answer). */
  const silenceLayer = (src: Source): void => {
    const good = (): ((url: string, ...rest: unknown[]) => Promise<unknown>) => mockFetch.getMockImplementation()! as never;
    const answerNothing = (host: string) => {
      const base = good();
      mockFetch.mockImplementation((url: string, ...rest: unknown[]) => (String(url).includes(host) ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }) : base(url, ...rest)));
    };
    if (src === "helius") { mockHeliusGetLargestAccounts.mockResolvedValue(null); mockHeliusGetMintAccount.mockResolvedValue(null); }
    else if (src === "rugcheck") answerNothing("rugcheck");
    else if (src === "goplus") answerNothing("gopluslabs");
    else if (src === "solscan") mockFetchSolscan.mockResolvedValue(null);
    else if (src === "dexscreener") {
      const base = good();
      mockFetch.mockImplementation((url: string, ...rest: unknown[]) => (String(url).includes("dexscreener") ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: null }) }) : base(url, ...rest)));
    } else if (src === "chart") mockFetchDexCandles.mockResolvedValue([]);
  };

  /** Put the outage ledger in the state of `mode` for `src` (fake clock: the minute is the test's). */
  const seedLedger = async (src: Source, mode: Mode): Promise<void> => {
    const k = threshold(src);
    const n = mode === "nothing" ? 0 : mode === "blip" ? k - 1 : k;
    for (let i = 0; i < n; i++) noteSourceFailure(HOST[src]);
    if (mode === "ended") await vi.advanceTimersByTimeAsync(61_000);
  };

  /** The rule, as the product owner stated it (2026-10-14): Limited data only for a real outage of Helius, or of two of the three sources at once (the combinations below). */
  const expectLimited = (src: Source, mode: Mode): boolean => src === "helius" && mode === "outage";

  const rows: Array<{ tier: string; verdict: string; src: Source; mode: Mode; limited: boolean; degraded: boolean | undefined; badge: string | null }> = [];

  for (const verdict of VERDICTS) {
    for (const src of SOURCES) {
      for (const mode of MODES) {
        for (const tier of TIERS) {
          const limited = expectLimited(src, mode);
          it(`${verdict} | ${src} missing, ${mode} | ${tier}: ${limited ? "LIMITED DATA" : "the verdict, as before"}`, async () => {
            forced.verdict = verdict;
            setupGoodTokenMocks();
            silenceLayer(src);
            await seedLedger(src, mode);
            const res = createMockRes();
            await run(tier === "free" ? freeReq() : createMockReq({ ca: WSOL }), res);
            const body = (tier === "free" ? (res as unknown as { getBody: () => Record<string, unknown> }).getBody() : jsonBody(res)) as Record<string, unknown>;
            expect(body.proLocked === true).toBe(tier === "free");
            rows.push({ tier, verdict, src, mode, limited: body.sourceGap === true, degraded: body.degraded as boolean | undefined, badge: buildScanResultMessage(WSOL, body as never)?.risk ?? null });

            // THE question: does the overlay show the Limited data card?
            expect(body.sourceGap, "sourceGap").toBe(limited);
            expect(sourceGapOf(body), "what the overlay reads").toBe(limited);
            if (limited) {
              // a real outage: no verdict anywhere, the answer kept 30 s only
              expect(body.degraded).toBe(true);
              expect(body.freshForSec).toBe(30);
              expect(buildScanResultMessage(WSOL, body as never)).toBeNull();
              expect(mockRecordRug).not.toHaveBeenCalled();
              expect(mockPushHistory).not.toHaveBeenCalled();
              expect(vi.mocked(setCachedResult)).not.toHaveBeenCalled();
            } else {
              // anything else: the scan is what it was before this feature: the verdict (the same word for Free and Pro), the badge, the history, the rug database
              expect(body.risk).toBe(verdict);
              expect(buildScanResultMessage(WSOL, body as never)?.risk).toBe(verdict);
              expect(mockRecordRug).toHaveBeenCalledTimes(1);
              expect(mockPushHistory).toHaveBeenCalledTimes(1);
              // its caching rule is the old one: short only for what was already short (no pool, the chart of an old SAFE or CAUTION), the usual time otherwise
              const shortAnyway = src === "dexscreener" || (src === "chart" && (verdict === "SAFE" || verdict === "CAUTION"));
              expect(body.degraded === true).toBe(shortAnyway);
              expect(body.freshForSec === 30).toBe(shortAnyway);
            }
          });
        }
      }
    }
  }

  // Combinations: several sources silent at once. Only the ones that are DOWN make it Limited data; the others do not add anything.
  const COMBOS: Array<{ name: string; silent: Source[]; down: Source[]; limited: boolean }> = [
    { name: "Helius and RugCheck silent, only Helius down", silent: ["helius", "rugcheck"], down: ["helius"], limited: true },
    { name: "Helius and RugCheck silent, only RugCheck down (one source is not enough)", silent: ["helius", "rugcheck"], down: ["rugcheck"], limited: false },
    { name: "RugCheck silent and down, alone", silent: ["rugcheck"], down: ["rugcheck"], limited: false },
    { name: "GoPlus silent and down, alone", silent: ["goplus"], down: ["goplus"], limited: false },
    { name: "RugCheck and GoPlus silent, both down (two sources at once)", silent: ["rugcheck", "goplus"], down: ["rugcheck", "goplus"], limited: true },
    { name: "RugCheck and GoPlus silent, only RugCheck down", silent: ["rugcheck", "goplus"], down: ["rugcheck"], limited: false },
    { name: "RugCheck silent and down, GoPlus down but it answered", silent: ["rugcheck"], down: ["rugcheck", "goplus"], limited: false },
    { name: "Helius and RugCheck silent, neither down (both have nothing for this token)", silent: ["helius", "rugcheck"], down: [], limited: false },
    { name: "all three silent, none down", silent: ["helius", "rugcheck", "goplus"], down: [], limited: false },
    { name: "all three silent, all down", silent: ["helius", "rugcheck", "goplus"], down: ["helius", "rugcheck", "goplus"], limited: true },
    { name: "Helius down but it answered, RugCheck silent with nothing", silent: ["rugcheck"], down: ["helius"], limited: false },
    { name: "Solscan, DexScreener and the chart all silent, the three sources answered", silent: ["solscan", "dexscreener", "chart"], down: [], limited: false },
    { name: "Solscan silent and Helius down and silent", silent: ["solscan", "helius"], down: ["helius"], limited: true },
  ];
  for (const verdict of VERDICTS) {
    for (const combo of COMBOS) {
      for (const tier of TIERS) {
        it(`${verdict} | ${combo.name} | ${tier}: ${combo.limited ? "LIMITED DATA" : "the verdict, as before"}`, async () => {
          forced.verdict = verdict;
          setupGoodTokenMocks();
          for (const src of combo.silent) silenceLayer(src);
          for (const src of combo.down) for (let i = 0; i < threshold(src); i++) noteSourceFailure(HOST[src]);
          const res = createMockRes();
          await run(tier === "free" ? freeReq() : createMockReq({ ca: WSOL }), res);
          const body = (tier === "free" ? (res as unknown as { getBody: () => Record<string, unknown> }).getBody() : jsonBody(res)) as Record<string, unknown>;
          expect(body.sourceGap).toBe(combo.limited);
          expect(sourceGapOf(body)).toBe(combo.limited);
        });
      }
    }
  }

  afterAll(() => {
    const out = process.env.LIMITED_MATRIX_REPORT;
    if (!out || rows.length === 0) return;
    const lines: string[] = [
      "# When does \"Limited data\" activate?",
      "",
      `Generated by __tests__/scan-source-gap.test.ts (${rows.length} scans through the real handler). **LIMITED** = the overlay shows the Limited data card, no verdict. **verdict** = the scan is what it was before.`,
      "",
      "A source is *down* when it has failed several calls within the last minute (Helius 3, RugCheck 2, GoPlus 2). *nothing* = it answered with nothing for this token, *blip* = one failed call fewer than the threshold, *outage* = down, *ended* = down more than a minute ago.",
      "",
    ];
    for (const verdict of VERDICTS) {
      for (const tier of TIERS) {
        lines.push(`## The engine reached ${verdict} (${tier})`, "", "| source missing | nothing | blip | outage | ended |", "|---|---|---|---|---|");
        for (const src of SOURCES) {
          const cells = MODES.map((m) => {
            const r = rows.find((x) => x.verdict === verdict && x.tier === tier && x.src === src && x.mode === m);
            return r ? (r.limited ? "**LIMITED**" : "verdict") : "?";
          });
          lines.push(`| ${src} | ${cells.join(" | ")} |`);
        }
        lines.push("");
      }
    }
    const limitedCount = rows.filter((r) => r.limited).length;
    lines.push("## Summary", "", `- ${rows.length} scans, ${limitedCount} Limited data, ${rows.length - limitedCount} with their verdict.`, "- Limited data happens only in the **outage** column of Helius, or when two of Helius, RugCheck and GoPlus are down at once (RugCheck alone or GoPlus alone keeps its verdict).", "- Solscan, DexScreener and the chart never make a scan Limited data.", "- Free and Pro always agree.", "");
    writeFileSync(out, lines.join("\n"));
  });
});

// ─── RugCheck's memory, through the real handler ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// RugCheck is the source that fails the most. A token scanned before keeps its last good RugCheck answer for a while (api/_lib/rugcheck-memory.ts), read only for what RugCheck
// does not give back: during an outage the scan of such a token has its RugCheck layer. RugCheck alone being down is no longer "Limited data" (Helius alone, or two sources at
// once, are): the memory matters when a SECOND source is down too, because it keeps RugCheck's layer and so leaves a single source missing.
describe("RugCheck's memory: a token scanned before survives a RugCheck outage", () => {
  const kept = new Map<string, unknown>();
  const sets: Array<{ key: string; opts: unknown }> = [];
  const fakeRedis = (over: { get?: () => Promise<unknown> } = {}) => ({
    get: over.get ?? (async (k: string) => kept.get(k) ?? null),
    set: async (k: string, v: unknown, opts: unknown) => { sets.push({ key: k, opts }); kept.set(k, v); return "OK"; },
    setex: mockSetex,
  });
  const rugcheckDown = () => {
    const good = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes("rugcheck") ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }) : good(url, ...rest));
    declareOutage("rugcheck");
  };
  const goplusDown = () => {
    const good = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes("gopluslabs") ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) }) : good(url, ...rest));
    declareOutage("goplus");
  };
  const rugcheckAndGoplusDown = () => { rugcheckDown(); goplusDown(); };
  const flagLabels = (b: Record<string, unknown> | undefined) => ((b?.flags ?? []) as Array<{ label: string }>).map((f) => f.label).filter((l) => !/RugCheck unavailable/i.test(l)).sort();
  const layerUp = (b: Record<string, unknown> | undefined) => (b?.layers as Record<string, { available: boolean }> | undefined)?.rugcheck?.available;

  beforeEach(() => { kept.clear(); sets.length = 0; vi.mocked(getCacheRedis).mockReturnValue(fakeRedis() as never); });
  afterEach(() => { vi.mocked(getCacheRedis).mockReturnValue({ setex: mockSetex } as never); });

  async function scanOnce(prepare: () => void = () => {}, tier: "pro" | "free" = "pro") {
    setupGoodTokenMocks();
    prepare();
    const res = createMockRes();
    await run(tier === "free" ? freeReq() : createMockReq({ ca: WSOL }), res);
    return tier === "free" ? ((res as unknown as { getBody: () => Record<string, unknown> }).getBody()) : jsonBody(res);
  }

  it("a scan that got RugCheck's answer keeps it, one entry, 6 hours", async () => {
    await scanOnce();
    const entries = sets.filter((s) => s.key.startsWith("antares:rugcheck:"));
    expect(entries).toHaveLength(1);
    expect(entries[0].opts).toEqual({ ex: 6 * 3600 });
  });

  it("then RugCheck goes down: the same token's scan has its RugCheck layer, is NOT Limited data, and reads the same verdict and the same flags", async () => {
    const before = await scanOnce();
    expect(layerUp(before)).toBe(true);
    const during = await scanOnce(rugcheckDown);
    expect(during?.sourceGap).toBe(false);
    expect(layerUp(during)).toBe(true);
    expect(during?.risk).toBe(before?.risk);
    expect(during?.score).toBe(before?.score);
    expect(flagLabels(during)).toEqual(flagLabels(before));
    expect(during?.degraded).toBe(false); // cached for the usual time, recorded as usual
  });

  it("Free is told the same (not Limited data)", async () => {
    await scanOnce();
    const during = await scanOnce(rugcheckDown, "free");
    expect(during?.sourceGap).toBe(false);
  });

  it("a token never scanned before, RugCheck down ALONE: its verdict and its flag, not Limited data (the 2026-10-14 case)", async () => {
    const during = await scanOnce(rugcheckDown);
    expect(during?.sourceGap).toBe(false);
    expect(layerUp(during)).toBe(false);
  });

  it("a token never scanned before, RugCheck AND GoPlus down together: Limited data (two sources at once)", async () => {
    const during = await scanOnce(rugcheckAndGoplusDown);
    expect(during?.sourceGap).toBe(true);
  });

  it("a token scanned before, RugCheck AND GoPlus down together: the memory keeps RugCheck's layer, so one source is missing, not two: not Limited data", async () => {
    await scanOnce();
    const during = await scanOnce(rugcheckAndGoplusDown);
    expect(layerUp(during)).toBe(true);
    expect(during?.sourceGap).toBe(false);
  });

  it("a memory older than 6 hours is not read: with a second source down, Limited data", async () => {
    await scanOnce();
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    const during = await scanOnce(rugcheckAndGoplusDown);
    expect(during?.sourceGap).toBe(true);
  });

  it("a Redis that fails on the read: the scan goes on without the memory (Limited data if a second source is down), it does not fail", async () => {
    await scanOnce();
    vi.mocked(getCacheRedis).mockReturnValue(fakeRedis({ get: async () => { throw new Error("redis down"); } }) as never);
    const during = await scanOnce(rugcheckAndGoplusDown);
    expect(during?.sourceGap).toBe(true);
  });

  it("no Redis at all: the scan is what it was (no memory, nothing breaks)", async () => {
    vi.mocked(getCacheRedis).mockReturnValue(null as never);
    const body = await scanOnce();
    expect(body?.sourceGap).toBe(false);
    expect(sets).toHaveLength(0);
  });

  it("RugCheck answering \"not found\" for the token is an answer: the memory is not read for it", async () => {
    await scanOnce();
    sets.length = 0;
    const body = await scanOnce(() => {
      const good = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
        String(url).includes("rugcheck") && String(url).includes("summary")
          ? Promise.resolve({ ok: true, json: () => Promise.resolve({ error: "not found" }) })
          : good(url, ...rest));
    });
    expect(body?.sourceGap).toBe(false); // not an outage: RugCheck answered
    expect(sets.filter((s) => s.key.startsWith("antares:rugcheck:"))).toHaveLength(0); // and an answer that is not an analysis is not kept
  });
});

// ─── The answer says which kind of issuer's asset the token is (the overlay draws its Mint / Freeze / LP Lock as dashes, not crosses) ────────────────────
// `issuerKind` comes from the registry by mint ADDRESS (api/_lib/issuer-assets.ts), null for any other token, and Free callers get it too.
describe("issuerKind: the answer names the issuer's asset", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const marketOf = (mint: string, symbol: string) => {
    const good = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes("dexscreener")
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: [{
            pairAddress: "pairUsdc", baseToken: { address: mint, symbol, name: symbol }, quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
            liquidity: { usd: 5_000_000 }, volume: { h24: 900_000, h1: 40_000 }, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { m5: { buys: 10, sells: 10 } },
            priceUsd: "1.0001", marketCap: 40_000_000_000, fdv: 40_000_000_000, pairCreatedAt: Date.now() - 900 * 24 * 3600 * 1000,
            info: { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }], imageUrl: "https://img.test.com/icon.png" },
          }] }) })
        : good(url, ...rest));
  };
  const freeReqFor = (ca: string): VercelRequest => {
    const req = createMockReq({ ca });
    (req as unknown as { headers: Record<string, string> }).headers["x-antares-install"] = "free-install-source-gap-0001";
    return req;
  };
  const bodyFor = async (ca: string, tier: "pro" | "free") => {
    const res = createMockRes();
    await run(tier === "free" ? freeReqFor(ca) : createMockReq({ ca }), res);
    return (tier === "free" ? (res as unknown as { getBody: () => Record<string, unknown> }).getBody() : jsonBody(res)) as Record<string, unknown>;
  };

  for (const tier of ["pro", "free"] as const) {
    it(tier + " | an ordinary token: issuerKind is null", async () => {
      setupGoodTokenMocks();
      const body = await bodyFor(WSOL, tier);
      expect(body.issuerKind).toBeNull();
    });
  }

  for (const tier of ["pro", "free"] as const) {
    it(tier + " | a stablecoin of the registry, its market read: issuerKind is \"stable\"", async () => {
      setupGoodTokenMocks();
      marketOf(USDC, "USDC");
      const res = createMockRes();
      await run(tier === "free" ? freeReqFor(USDC) : createMockReq({ ca: USDC }), res);
      const body = (tier === "free" ? (res as unknown as { getBody: () => Record<string, unknown> }).getBody() : jsonBody(res)) as Record<string, unknown>;
      expect(body.issuerKind).toBe("stable");
    });
  }

  it("a verdict served again from the memory of the last time the market was read (DexScreener silent) names the asset too, even if that memory is older than the field", async () => {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes("dexscreener") ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: null }) }) : good(url, ...rest));
    vi.mocked(getLastGoodResult).mockResolvedValueOnce({
      score: 850, risk: "CAUTION", rugKind: null, flags: [], pair: null, resolvedMint: USDC, confidence: 90, sources_used: ["dexscreener", "rugcheck", "goplus", "helius"],
      tokenSymbol: "USDC", tokenName: "USD Coin", priceUsd: 1.0001, liquidity: 52_000_000, fetchedAt: Date.now() - 6 * 60_000, requestId: "old",
    } as never); // no issuerKind in it: it was stored before the field existed
    const res = createMockRes();
    await run(createMockReq({ ca: USDC }), res);
    const body = jsonBody(res);
    expect(body?.servedFromMemory).toBe(true);
    expect(body?.issuerKind).toBe("stable");
  });
});
