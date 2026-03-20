import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractBundlePct } from "../api/fetchers";
import type { RugCheckReport, RugCheckRisk, OHLCVCandle } from "../api/types";

// ─── extractBundlePct (pure function, no mocking needed) ─────────────────────
describe("extractBundlePct", () => {
  it("returns 0 for null input", () => {
    expect(extractBundlePct(null)).toBe(0);
  });

  it("returns 0 when no bundle risk exists", () => {
    const report = { risks: [{ name: "Low liquidity", score: 2000 }] } as unknown as RugCheckReport;
    expect(extractBundlePct(report)).toBe(0);
  });

  it("returns top1Percentage/100 when bundle risk exists and top1 > 0", () => {
    const report: RugCheckReport = {
      risks: [{ name: "Bundle detected", score: 5000 }],
      topHolders: { top1Percentage: 35 },
    };
    expect(extractBundlePct(report)).toBeCloseTo(0.35, 2);
  });

  it("returns 0.40 for bundle score >= 8000 with no top1", () => {
    const report: RugCheckReport = {
      risks: [{ name: "Bundle detected", score: 8000 }],
      topHolders: {},
    };
    expect(extractBundlePct(report)).toBe(0.40);
  });

  it("returns 0.25 for bundle score >= 5000 with no top1", () => {
    const report: RugCheckReport = {
      risks: [{ name: "Bundle activity", score: 5000 }],
      topHolders: {},
    };
    expect(extractBundlePct(report)).toBe(0.25);
  });

  it("returns 0.20 for low bundle score with no top1", () => {
    const report: RugCheckReport = {
      risks: [{ name: "Bundle activity", score: 1000 }],
      topHolders: {},
    };
    expect(extractBundlePct(report)).toBe(0.20);
  });

  it("returns 0 when risks array is empty", () => {
    const report: RugCheckReport = { risks: [] };
    expect(extractBundlePct(report)).toBe(0);
  });

  it("uses top1HolderPercentage when top1Percentage is missing", () => {
    const report: RugCheckReport = {
      risks: [{ name: "Bundle risk", score: 3000 }],
      topHolders: { top1HolderPercentage: 22 },
    };
    expect(extractBundlePct(report)).toBeCloseTo(0.22, 2);
  });
});

// ─── Mocked fetcher tests ────────────────────────────────────────────────────
// Mock the helpers module to control fetchJson / fetchJsonPost
const mockFetchJson = vi.fn();
const mockFetchJsonPost = vi.fn();

vi.mock("../api/helpers", async () => {
  const actual = await vi.importActual<typeof import("../api/helpers")>("../api/helpers");
  return {
    ...actual,
    fetchJson: (...args: unknown[]) => mockFetchJson(...args),
    fetchJsonPost: (...args: unknown[]) => mockFetchJsonPost(...args),
  };
});

// Import fetcher functions AFTER mock setup
const {
  heliusGetLargestAccounts,
  heliusGetTokenSupply,
  heliusGetCreatorReputation,
  solscanGetHoldersCount,
  fetchSolscan,
  fetchDexCandles,
} = await import("../api/fetchers");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("heliusGetLargestAccounts", () => {
  it("calls fetchJsonPost with correct params", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { value: [] } });
    const result = await heliusGetLargestAccounts("mint123", "key456");
    expect(mockFetchJsonPost).toHaveBeenCalledOnce();
    const [url, body] = mockFetchJsonPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toContain("api-key=key456");
    expect(body.method).toBe("getTokenLargestAccounts");
    expect(body.params).toEqual(["mint123"]);
    expect(result).toEqual({ result: { value: [] } });
  });

  it("returns null on failure", async () => {
    mockFetchJsonPost.mockResolvedValue(null);
    const result = await heliusGetLargestAccounts("mint", "key");
    expect(result).toBeNull();
  });
});

describe("heliusGetTokenSupply", () => {
  it("calls fetchJsonPost with getTokenSupply method", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { value: { uiAmount: 1000000 } } });
    const result = await heliusGetTokenSupply("mint123", "key456");
    const [, body] = mockFetchJsonPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.method).toBe("getTokenSupply");
    expect(result).toEqual({ result: { value: { uiAmount: 1000000 } } });
  });
});

describe("heliusGetCreatorReputation", () => {
  it("returns null for empty creator", async () => {
    const result = await heliusGetCreatorReputation("", "key");
    expect(result).toBeNull();
  });

  it("flags serial deployer with 3+ create txs", async () => {
    mockFetchJson.mockResolvedValue([
      { type: "create", description: "created token" },
      { type: "create", description: "created another" },
      { type: "create", description: "yet another" },
    ]);
    const result = await heliusGetCreatorReputation("creator1", "key1");
    expect(result?.flagged).toBe(true);
    expect(result?.priorTokens).toBeGreaterThanOrEqual(3);
  });

  it("returns clean for < 3 creates", async () => {
    mockFetchJson.mockResolvedValue([
      { type: "transfer", description: "sent SOL" },
      { type: "create", description: "initialize mint" },
    ]);
    const result = await heliusGetCreatorReputation("creator2", "key2");
    expect(result?.flagged).toBe(false);
  });

  it("returns null for non-array response", async () => {
    mockFetchJson.mockResolvedValue({ error: "invalid" });
    const result = await heliusGetCreatorReputation("creator3", "key3");
    expect(result).toBeNull();
  });
});

describe("solscanGetHoldersCount", () => {
  it("returns total when valid", async () => {
    mockFetchJson.mockResolvedValue({ total: 5000 });
    const result = await solscanGetHoldersCount("mint123");
    expect(result).toBe(5000);
  });

  it("returns null when total is 0", async () => {
    mockFetchJson.mockResolvedValue({ total: 0 });
    const result = await solscanGetHoldersCount("mint123");
    expect(result).toBeNull();
  });

  it("returns null on failure", async () => {
    mockFetchJson.mockResolvedValue(null);
    const result = await solscanGetHoldersCount("mint123");
    expect(result).toBeNull();
  });
});

describe("fetchDexCandles", () => {
  it("parses OHLCV data correctly", async () => {
    mockFetchJson.mockResolvedValue({
      data: {
        attributes: {
          ohlcv_list: [
            [1700000000, 1.0, 1.5, 0.9, 1.2, 100],
            [1700000300, 1.2, 1.8, 1.1, 1.6, 200],
          ],
        },
      },
    });
    const result = await fetchDexCandles("pairAddr");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ts: 1700000000, o: 1.0, h: 1.5, l: 0.9, c: 1.2, v: 100 });
  });

  it("returns empty array for null response", async () => {
    mockFetchJson.mockResolvedValue(null);
    const result = await fetchDexCandles("pairAddr");
    expect(result).toEqual([]);
  });

  it("returns empty array for missing ohlcv_list", async () => {
    mockFetchJson.mockResolvedValue({ data: { attributes: {} } });
    const result = await fetchDexCandles("pairAddr");
    expect(result).toEqual([]);
  });
});
