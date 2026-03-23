import { describe, it, expect, vi } from "vitest";
import {
  asNumber, _mean, _std, _pct, makeFlag, computeCacheTTL,
  apiError, isCorsAllowed, isValidDexScreenerResponse, isValidRugCheckSummary,
  isHeliusLargestAccountsResponse, isHeliusSupplyResponse,
  isSolscanMarketsResponse, isSolscanMeta, isSolscanTransfersResponse,
  isRugCheckReport,
} from "../api/_lib/helpers";
import { CA_RE } from "../api/_lib/constants";

describe("asNumber", () => {
  it("returns number directly", () => {
    expect(asNumber(42)).toBe(42);
  });
  it("parses string float", () => {
    expect(asNumber("3.14")).toBeCloseTo(3.14);
  });
  it("returns 0 for undefined", () => {
    expect(asNumber(undefined)).toBe(0);
  });
  it("returns 0 for NaN", () => {
    expect(asNumber(NaN)).toBe(0);
  });
  it("returns 0 for non-numeric string", () => {
    expect(asNumber("abc")).toBe(0);
  });
});

describe("_mean", () => {
  it("returns 0 for empty array", () => {
    expect(_mean([])).toBe(0);
  });
  it("returns single element", () => {
    expect(_mean([10])).toBe(10);
  });
  it("calculates mean of array", () => {
    expect(_mean([2, 4, 6])).toBe(4);
  });
});

describe("_std", () => {
  it("returns 0 for constant array", () => {
    expect(_std([5, 5, 5])).toBe(0);
  });
});

describe("_pct", () => {
  it("returns 0 when from is 0 (division guard)", () => {
    expect(_pct(0, 100)).toBe(0);
  });
  it("calculates percentage change", () => {
    expect(_pct(100, 150)).toBe(50);
  });
});

describe("makeFlag", () => {
  it("creates flag object", () => {
    expect(makeFlag("test", "warning", 5)).toEqual({
      label: "test",
      severity: "warning",
      impact: 5,
    });
  });
});

describe("computeCacheTTL", () => {
  it("returns 20 for null", () => {
    expect(computeCacheTTL(null)).toBe(20);
  });
  it("returns 15 for age < 60", () => {
    expect(computeCacheTTL(30)).toBe(15);
  });
  it("returns 30 for age 60-1440", () => {
    expect(computeCacheTTL(120)).toBe(30);
  });
  it("returns 120 for age > 1440", () => {
    expect(computeCacheTTL(2000)).toBe(120);
  });
});

describe("apiError", () => {
  function mockRes() {
    const jsonFn = vi.fn();
    const statusFn = vi.fn(() => ({ json: jsonFn }));
    return { status: statusFn, json: jsonFn } as unknown as import("@vercel/node").VercelResponse;
  }

  it("returns correct status and error message", () => {
    const res = mockRes();
    apiError(res, 400, "Bad request");
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("includes details when provided", () => {
    const res = mockRes();
    apiError(res, 500, "Server error", { code: "INTERNAL" });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("omits details key when details is undefined", () => {
    const jsonFn = vi.fn();
    const statusFn = vi.fn(() => ({ json: jsonFn }));
    const res = { status: statusFn, json: jsonFn } as unknown as import("@vercel/node").VercelResponse;
    apiError(res, 404, "Not found");
    expect(jsonFn).toHaveBeenCalledWith({ error: "Not found" });
  });
});

describe("isCorsAllowed", () => {
  const origins = ["https://dexscreener.com", "https://birdeye.so"];

  it("allowed origin -> true", () => {
    expect(isCorsAllowed("https://dexscreener.com", origins)).toBe(true);
  });

  it("allowed origin with path -> true (startsWith)", () => {
    expect(isCorsAllowed("https://dexscreener.com/solana/abc", origins)).toBe(true);
  });

  it("chrome-extension://abc123 -> true", () => {
    expect(isCorsAllowed("chrome-extension://abc123", origins)).toBe(true);
  });

  it("evil.com -> false", () => {
    expect(isCorsAllowed("https://evil.com", origins)).toBe(false);
  });

  it("empty string -> false", () => {
    expect(isCorsAllowed("", origins)).toBe(false);
  });

  it("chrome-extension:// exactly -> true", () => {
    expect(isCorsAllowed("chrome-extension://", origins)).toBe(true);
  });

  it("dexscreener.org (different TLD) -> false", () => {
    expect(isCorsAllowed("https://dexscreener.org", origins)).toBe(false);
  });
});

describe("isValidDexScreenerResponse", () => {
  it("{ pairs: [] } -> true (valid with empty pairs array)", () => {
    expect(isValidDexScreenerResponse({ pairs: [] })).toBe(true);
  });

  it("{ pairs: [{ pairAddress: 'abc' }] } -> true", () => {
    expect(isValidDexScreenerResponse({ pairs: [{ pairAddress: "abc" }] })).toBe(true);
  });

  it("{ pair: { pairAddress: 'abc' } } -> true (single pair)", () => {
    expect(isValidDexScreenerResponse({ pair: { pairAddress: "abc" } })).toBe(true);
  });

  it("null -> false", () => {
    expect(isValidDexScreenerResponse(null)).toBe(false);
  });

  it("string -> false", () => {
    expect(isValidDexScreenerResponse("string")).toBe(false);
  });

  it("42 -> false", () => {
    expect(isValidDexScreenerResponse(42)).toBe(false);
  });

  it("{} -> false (no pairs or pair key)", () => {
    expect(isValidDexScreenerResponse({})).toBe(false);
  });

  it("{ pairs: 'not-array' } -> false (pairs must be array)", () => {
    expect(isValidDexScreenerResponse({ pairs: "not-array" })).toBe(false);
  });
});

describe("isValidRugCheckSummary", () => {
  it("{ lpBurned: true } -> true", () => {
    expect(isValidRugCheckSummary({ lpBurned: true })).toBe(true);
  });

  it("{ risks: [] } -> true", () => {
    expect(isValidRugCheckSummary({ risks: [] })).toBe(true);
  });

  it("{ error: 'not found' } -> true", () => {
    expect(isValidRugCheckSummary({ error: "not found" })).toBe(true);
  });

  it("{ lpBurned: false, risks: [], mintAuthorityEnabled: true } -> true", () => {
    expect(isValidRugCheckSummary({ lpBurned: false, risks: [], mintAuthorityEnabled: true })).toBe(true);
  });

  it("null -> false", () => {
    expect(isValidRugCheckSummary(null)).toBe(false);
  });

  it("string -> false", () => {
    expect(isValidRugCheckSummary("string")).toBe(false);
  });

  it("{} -> false (no recognizable fields)", () => {
    expect(isValidRugCheckSummary({})).toBe(false);
  });

  it("{ randomField: true } -> false", () => {
    expect(isValidRugCheckSummary({ randomField: true })).toBe(false);
  });
});

// ─── Runtime Type Guards (Session 6) ─────────────────────────────────────────
describe("isHeliusLargestAccountsResponse", () => {
  it("accepts valid response", () => {
    expect(isHeliusLargestAccountsResponse({ result: { value: [] } })).toBe(true);
  });
  it("rejects null", () => {
    expect(isHeliusLargestAccountsResponse(null)).toBe(false);
  });
  it("rejects missing result", () => {
    expect(isHeliusLargestAccountsResponse({ foo: "bar" })).toBe(false);
  });
});

describe("isHeliusSupplyResponse", () => {
  it("accepts valid response", () => {
    expect(isHeliusSupplyResponse({ result: { value: { uiAmount: 1000 } } })).toBe(true);
  });
  it("rejects null", () => {
    expect(isHeliusSupplyResponse(null)).toBe(false);
  });
});

describe("isSolscanMarketsResponse", () => {
  it("accepts valid response", () => {
    expect(isSolscanMarketsResponse({ data: [] })).toBe(true);
  });
  it("rejects non-array data", () => {
    expect(isSolscanMarketsResponse({ data: "nope" })).toBe(false);
  });
});

describe("isSolscanMeta", () => {
  it("accepts valid meta", () => {
    expect(isSolscanMeta({ data: { created_time: 123 } })).toBe(true);
  });
  it("rejects non-object data", () => {
    expect(isSolscanMeta({ data: 42 })).toBe(false);
  });
});

describe("isSolscanTransfersResponse", () => {
  it("accepts valid response", () => {
    expect(isSolscanTransfersResponse({ data: [{ from: "a", to: "b" }] })).toBe(true);
  });
  it("rejects null", () => {
    expect(isSolscanTransfersResponse(null)).toBe(false);
  });
});

describe("isRugCheckReport", () => {
  it("accepts report with risks", () => {
    expect(isRugCheckReport({ risks: [] })).toBe(true);
  });
  it("accepts report with topHolders", () => {
    expect(isRugCheckReport({ topHolders: {} })).toBe(true);
  });
  it("rejects empty object", () => {
    expect(isRugCheckReport({})).toBe(false);
  });
});

describe("CA_RE consistency", () => {
  it("should match valid Solana addresses", () => {
    expect(CA_RE.test("So11111111111111111111111111111111111111112")).toBe(true);
    expect(CA_RE.test("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).toBe(true);
  });
  it("should reject invalid addresses", () => {
    expect(CA_RE.test("short")).toBe(false);
    expect(CA_RE.test("")).toBe(false);
    expect(CA_RE.test("invalid!@#$%^&*()characters1234567890ab")).toBe(false);
  });
});
