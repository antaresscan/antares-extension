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
const { acquireScanLock, waitForCachedResult, getCachedResult, setCachedResult, setShortCachedResult, getLastGoodResult, setLastGoodResult } = await import("../api/_lib/cache");

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
      ["RugCheck", ["rugcheck"]],
      ["GoPlus", ["goplus"]],
      ["Helius + GoPlus", ["helius", "goplus"]],
      ["Helius + RugCheck + GoPlus", ["helius", "rugcheck", "goplus"]],
    ])("%s silent AND down: marked, whatever the verdict (no verdict is shown for it)", (_name, missing) => {
      expect(isScanIncomplete({ layers: layersWith(missing), down: DOWN_ALL })).toBe(true);
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

  for (const [name, silence] of silences) {
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

  describe("the emergency switch (LIMITED_DATA=off)", () => {
    const saved = process.env.LIMITED_DATA;
    afterEach(() => { if (saved === undefined) delete process.env.LIMITED_DATA; else process.env.LIMITED_DATA = saved; });

    for (const [name, silence] of silences) {
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

    it("RugCheck failing for real (no seeding): its calls of this scan are the outage, so the scan is Limited data", async () => {
      setupGoodTokenMocks();
      fail503("rugcheck");
      const res = createMockRes();
      await run(createMockReq({ ca: WSOL }), res);
      expect(jsonBody(res)?.sourceGap).toBe(true);
    });

    it("GoPlus failing for real (no seeding): a lookup makes two calls, the authenticated one and the public one, both failing is the outage, so the scan is Limited data", async () => {
      setupGoodTokenMocks();
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
    ["RugCheck", () => down("rugcheck")],
    ["GoPlus", () => down("gopluslabs")],
    ["Helius + GoPlus", () => { heliusDown(); down("gopluslabs"); }],
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
//   which source: Helius, RugCheck and GoPlus can make a scan Limited data (and only in the "outage" state); Solscan, DexScreener and the chart never do.

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

  /** The rule, as the product owner stated it: Limited data only for a real outage of one of the three sources. */
  const expectLimited = (src: Source, mode: Mode): boolean => DECIDES.has(src) && mode === "outage";

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
    { name: "Helius and RugCheck silent, only RugCheck down", silent: ["helius", "rugcheck"], down: ["rugcheck"], limited: true },
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
    lines.push("## Summary", "", `- ${rows.length} scans, ${limitedCount} Limited data, ${rows.length - limitedCount} with their verdict.`, "- Limited data happens only in the **outage** column of Helius, RugCheck and GoPlus.", "- Solscan, DexScreener and the chart never make a scan Limited data.", "- Free and Pro always agree.", "");
    writeFileSync(out, lines.join("\n"));
  });
});
