import { describe, it, expect, vi } from "vitest";
import {
  asNumber, _mean, _std, _pct, makeFlag, computeCacheTTL,
  apiError, isCorsAllowed, isValidDexScreenerResponse, isValidRugCheckSummary,
} from "../api/helpers";

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
