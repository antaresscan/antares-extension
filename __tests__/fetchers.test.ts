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
  heliusGetHoldersCount,
  heliusGetProgramAccountHolderCount,
  solscanGetHoldersCount,
  fetchDexCandles,
  publicRpcGetLargestAccounts,
  publicRpcGetTokenSupply,
  publicRpcGetMintInfo,
} = await import("../api/_lib/fetchers");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("heliusGetLargestAccounts", () => {
  it("calls fetchJsonPost with correct params", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { value: [] } });
    const result = await heliusGetLargestAccounts("mint123", "key456");
    expect(mockFetchJsonPost).toHaveBeenCalledOnce();
    const [url, body, , , headers] = mockFetchJsonPost.mock.calls[0] as [string, Record<string, unknown>, number, number, Record<string, string>];
    // The documented ?api-key= form goes first; the Bearer header is the fallback
    // (see __tests__/helius.test.ts).
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=key456");
    expect(headers).toEqual({});
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

  // Helius Enhanced Transactions (/v0/*) only accepts the key as ?api-key=:
  // a Bearer header gets a 401 that fetchJson swallowed as null, so creator
  // reputation never resolved. The key is a query parameter, with no header.
  it("sends the key as ?api-key= and no Authorization header", async () => {
    mockFetchJson.mockResolvedValue([]);
    await heliusGetCreatorReputation("creator9", "key-xyz");
    const [url, init] = mockFetchJson.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("https://api.helius.xyz/v0/addresses/creator9/transactions?limit=200&api-key=key-xyz");
    expect(init?.headers).toBeUndefined();
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

// ─── Helius DAS getTokenAccounts (DAS API extension) ────────────────────────
describe("heliusGetHoldersCount", () => {
  it("returns total holders count from result.total", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { total: 1234, items: [] } });
    const result = await heliusGetHoldersCount("mintXYZ", "k");
    expect(result).toBe(1234);
  });

  it("returns null when total is missing", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { items: [] } });
    expect(await heliusGetHoldersCount("mintXYZ", "k")).toBeNull();
  });

  it("returns null on null response", async () => {
    mockFetchJsonPost.mockResolvedValue(null);
    expect(await heliusGetHoldersCount("mintXYZ", "k")).toBeNull();
  });

  it("falls back to top-level total field", async () => {
    mockFetchJsonPost.mockResolvedValue({ total: 42 });
    expect(await heliusGetHoldersCount("mintXYZ", "k")).toBe(42);
  });
});

// ─── Helius getProgramAccounts holder count (canonical method) ──────────────
describe("heliusGetProgramAccountHolderCount", () => {
  it("returns the length of the result array (= # of token accounts for the mint)", async () => {
    const items = Array.from({ length: 87 }, (_, i) => ({ pubkey: `addr${i}` }));
    mockFetchJsonPost.mockResolvedValue({ result: items });
    expect(await heliusGetProgramAccountHolderCount("mint", "k")).toBe(87);
  });

  it("returns null when the response shape is missing result", async () => {
    mockFetchJsonPost.mockResolvedValue({ error: { code: -32012, message: "scan aborted" } });
    expect(await heliusGetProgramAccountHolderCount("mint", "k")).toBeNull();
  });

  it("returns null on thrown error (network / timeout)", async () => {
    mockFetchJsonPost.mockRejectedValue(new Error("timeout"));
    expect(await heliusGetProgramAccountHolderCount("mint", "k")).toBeNull();
  });

  it("calls getProgramAccounts on the SPL Token program with the mint memcmp filter", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: [] });
    await heliusGetProgramAccountHolderCount("MINT_PUBKEY_42", "key");
    const body = (mockFetchJsonPost.mock.calls[0] as [string, Record<string, unknown>, ...unknown[]])[1];
    expect(body.method).toBe("getProgramAccounts");
    const params = body.params as [string, { filters?: unknown[]; dataSlice?: unknown }];
    expect(params[0]).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    // Filters must include both the dataSize and the mint memcmp.
    const filters = params[1].filters as Array<Record<string, unknown>>;
    expect(filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataSize: 165 }),
      expect.objectContaining({ memcmp: expect.objectContaining({ offset: 0, bytes: "MINT_PUBKEY_42" }) }),
    ]));
    // dataSlice {0, 0} keeps the response small — only addresses come back.
    expect(params[1].dataSlice).toEqual({ offset: 0, length: 0 });
  });
});

// ─── Public Solana RPC pool fallback ────────────────────────────────────────
describe("publicRpc helpers", () => {
  it("publicRpcGetTokenSupply returns the response when first provider answers", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { value: { uiAmount: 1000, decimals: 9 } } });
    const res = await publicRpcGetTokenSupply("mint") as { result?: { value?: { uiAmount?: number } } } | null;
    expect(res?.result?.value?.uiAmount).toBe(1000);
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
  });

  it("publicRpcGetTokenSupply iterates the pool until a provider returns a result", async () => {
    mockFetchJsonPost
      .mockResolvedValueOnce({ error: { message: "rate limit" } })
      .mockResolvedValueOnce({ result: { value: { uiAmount: 555 } } });
    const res = await publicRpcGetTokenSupply("mint") as { result?: { value?: { uiAmount?: number } } } | null;
    expect(res?.result?.value?.uiAmount).toBe(555);
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(2);
  });

  it("publicRpcGetTokenSupply returns null when every provider in the pool fails", async () => {
    mockFetchJsonPost.mockResolvedValue({ error: { message: "blocked" } });
    const res = await publicRpcGetTokenSupply("mint");
    expect(res).toBeNull();
  });

  it("publicRpcGetLargestAccounts uses the same pool iteration", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { value: [{ address: "a", uiAmount: 10 }] } });
    const res = await publicRpcGetLargestAccounts("mint") as { result?: { value?: unknown[] } } | null;
    expect(Array.isArray(res?.result?.value)).toBe(true);
  });

  it("publicRpcGetMintInfo parses supply + decimals from getAccountInfo response", async () => {
    mockFetchJsonPost.mockResolvedValue({
      result: {
        value: {
          data: {
            parsed: {
              info: { decimals: 6, supply: "1000000000" }, // 1000 tokens at 6 decimals
            },
          },
        },
      },
    });
    const res = await publicRpcGetMintInfo("mint");
    expect(res).toEqual({ supplyUi: 1000, decimals: 6 });
  });

  it("publicRpcGetMintInfo returns null when info missing", async () => {
    mockFetchJsonPost.mockResolvedValue({ result: { value: null } });
    expect(await publicRpcGetMintInfo("mint")).toBeNull();
  });

  it("publicRpcGetMintInfo returns null on zero supply", async () => {
    mockFetchJsonPost.mockResolvedValue({
      result: { value: { data: { parsed: { info: { decimals: 9, supply: "0" } } } } },
    });
    expect(await publicRpcGetMintInfo("mint")).toBeNull();
  });
});
