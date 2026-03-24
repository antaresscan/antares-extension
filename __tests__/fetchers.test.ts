import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractBundlePct } from "../api/_lib/fetchers";

// ─── extractBundlePct (pure function, no mocking needed) ─────────────────────
describe("extractBundlePct", () => {
  it("returns 0 for null input", () => {
    expect(extractBundlePct(null)).toBe(0);
  });

  it("returns 0 when no bundle risk exists", () => {
    const report = { risks: [{ name: "Low liquidity", score: 2000 }] };
    expect(extractBundlePct(report)).toBe(0);
  });

  it("extracts percentage from bundle risk description", () => {
    const report = {
      risks: [{ name: "Bundle detected", score: 5000, description: "Bundle holds 35% of supply" }],
    };
    expect(extractBundlePct(report)).toBeCloseTo(0.35, 2);
  });

  it("should parse percentage from description", () => {
    const mockReport = {
      risks: [{ name: "Bundle detected", description: "Bundle holds 45% of supply", score: 5000 }]
    };
    expect(extractBundlePct(mockReport)).toBe(0.45);
  });

  it("should parse decimal percentage", () => {
    const mockReport = {
      risks: [{ name: "Bundle activity", description: "Bundled 12.5% of total supply", score: 3000 }]
    };
    expect(extractBundlePct(mockReport)).toBe(0.125);
  });

  it("should fallback to score heuristic when no percentage in description", () => {
    const mockReport = {
      risks: [{ name: "Bundle detected", description: "Suspicious bundling activity", score: 8000 }]
    };
    expect(extractBundlePct(mockReport)).toBe(0.35);
  });

  it("should return 0 when no bundle risk", () => {
    const mockReport = {
      risks: [{ name: "Other risk", description: "Something else", score: 1000 }]
    };
    expect(extractBundlePct(mockReport)).toBe(0);
  });

  it("returns 0.35 for bundle score >= 8000 with no description %", () => {
    const report = {
      risks: [{ name: "Bundle detected", score: 8000 }],
    };
    expect(extractBundlePct(report)).toBe(0.35);
  });

  it("returns 0.20 for bundle score >= 5000 with no description %", () => {
    const report = {
      risks: [{ name: "Bundle activity", score: 5000 }],
    };
    expect(extractBundlePct(report)).toBe(0.20);
  });

  it("returns 0.10 for bundle score >= 2000 with no description %", () => {
    const report = {
      risks: [{ name: "Bundle activity", score: 2000 }],
    };
    expect(extractBundlePct(report)).toBe(0.10);
  });

  it("returns 0.08 for low bundle score with no description %", () => {
    const report = {
      risks: [{ name: "Bundle activity", score: 1000 }],
    };
    expect(extractBundlePct(report)).toBe(0.08);
  });

  it("returns 0.50 for bundle score >= 10000", () => {
    const report = {
      risks: [{ name: "Bundle detected", score: 10000 }],
    };
    expect(extractBundlePct(report)).toBe(0.50);
  });

  it("returns 0 when risks array is empty", () => {
    const report = { risks: [] };
    expect(extractBundlePct(report)).toBe(0);
  });

  it("should parse percentage from description (45%)", () => {
    const mockReport = {
      risks: [{ name: "Bundle detected", description: "Bundle holds 45% of supply", score: 5000 }]
    };
    expect(extractBundlePct(mockReport)).toBe(0.45);
  });

  it("should parse decimal percentage (12.5%)", () => {
    const mockReport = {
      risks: [{ name: "Bundle activity", description: "Bundled 12.5% of total supply", score: 3000 }]
    };
    expect(extractBundlePct(mockReport)).toBe(0.125);
  });

  it("never uses top1Percentage (regression test)", () => {
    // extractBundlePct should only look at risks array, not topHolders.top1Percentage
    const report = {
      risks: [],
      topHolders: { top1Percentage: 50 },
    };
    expect(extractBundlePct(report)).toBe(0);
  });
});

// ─── Mocked fetcher tests ────────────────────────────────────────────────────
// Mock the http module (fetchJson/fetchJsonPost now live in api/http.ts)
const mockFetchJson = vi.fn();
const mockFetchJsonPost = vi.fn();

vi.mock("../api/_lib/http", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/http")>("../api/_lib/http");
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
  fetchDexCandles,
} = await import("../api/_lib/fetchers");

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
      { type: "initialize_mint", description: "initialize mint" },
      { type: "initialize_mint", description: "initialize mint for token 2" },
      { type: "initialize_mint", description: "initialize mint for token 3" },
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
