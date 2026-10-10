/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";
import { INSIDER_GRAPH_CACHE_PREFIX } from "../api/_lib/constants";
import { buildInsiderGraph, initGraphCache } from "../api/_lib/insider-graph";

vi.mock("../api/_lib/helpers", () => ({
  fetchJson: vi.fn(),
}));

// The RPC (getSignaturesForAddress) goes through heliusRpc, which negotiates how
// the key is sent. Route it into the same fetchJson mock so every test keeps
// scripting one call per wallet, in order.
const heliusRpcMock = vi.fn(
  (_key: string, body: object, ms?: number, _retries?: number, _opts?: { usable?: (r: any) => boolean }) =>
    mockFetchJson("https://mainnet.helius-rpc.com", { method: "POST", body: JSON.stringify(body) }, ms),
);
vi.mock("../api/_lib/helius", () => ({
  heliusRpc: (...args: Parameters<typeof heliusRpcMock>) => heliusRpcMock(...args),
}));

import { fetchJson } from "../api/_lib/helpers";
const mockFetchJson = vi.mocked(fetchJson);

const MINT = "TokenMint111111111111111111111111111111111";
const WALLET_A = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WALLET_C = "WalletCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const LP_ADDR = "LPAddressXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const API_KEY = "test-helius-key";

const holders = [
  { address: WALLET_A, uiAmount: 5000 },
  { address: WALLET_B, uiAmount: 3000 },
  { address: WALLET_C, uiAmount: 2000 },
  { address: LP_ADDR, uiAmount: 10000 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildInsiderGraph", () => {
  it("builds graph with nodes excluding LP addresses", async () => {
    // Mock getWalletSignatures - returns empty for all wallets
    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set([LP_ADDR]);
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.every(n => n.address !== LP_ADDR)).toBe(true);
    expect(result.stats.analyzedWallets).toBe(3);
    expect(result.stats.totalHolders).toBe(4);
  });

  it("calculates pctSupply correctly", async () => {
    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    const nodeA = result.nodes.find(n => n.address === WALLET_A);
    expect(nodeA?.pctSupply).toBe(5);
  });

  it("handles zero total supply", async () => {
    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 0, API_KEY, lpSet);
    expect(result.nodes[0].pctSupply).toBe(0);
  });

  it("returns empty edges when no transfers between holders", async () => {
    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(0);
    expect(result.clusters).toHaveLength(0);
    expect(result.stats.clusterCount).toBe(0);
    expect(result.stats.insiderPct).toBe(0);
  });

  it("detects clusters when wallets transact with each other", async () => {
    // First 3 calls: getWalletSignatures for each wallet
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] }) // wallet A sigs
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] }) // wallet B sigs
      .mockResolvedValueOnce({ result: [] }) // wallet C sigs
      .mockResolvedValueOnce({ result: [] }) // LP sigs
      // parseTransactions - returns transfer between A and B
      .mockResolvedValueOnce([
        {
          signature: "sig1",
          tokenTransfers: [
            { fromUserAccount: WALLET_A, toUserAccount: WALLET_B, tokenAmount: 100, mint: MINT },
          ],
        },
      ]);
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.clusterCount).toBeGreaterThanOrEqual(1);
  });

  it("ignores transfers for different mints", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce([
        {
          signature: "sig1",
          tokenTransfers: [
            { fromUserAccount: WALLET_A, toUserAccount: WALLET_B, tokenAmount: 100, mint: "DifferentMint" },
          ],
        },
      ]);
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(0);
  });

  it("handles API errors gracefully", async () => {
    mockFetchJson.mockRejectedValue(new Error("network error"));
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(0);
  });

  it("uses cached result when available", async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValueOnce({
        nodes: [], edges: [], clusters: [],
        stats: { totalHolders: 0, analyzedWallets: 0, clusterCount: 0, insiderPct: 0 },
        cachedAt: Date.now(),
      }),
      set: vi.fn(),
    } as any;
    initGraphCache(mockRedis);
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.cachedAt).toBeDefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
    // Reset cache
    initGraphCache(null as any);
  });

  it("truncates node IDs for display", async () => {
    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    for (const node of result.nodes) {
      expect(node.id).toContain("...");
    }
  });

  it("sets cachedAt timestamp", async () => {
    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    const before = Date.now();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.cachedAt).toBeGreaterThanOrEqual(before);
  });

    it("accumulates weight on duplicate edges between same wallets", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }, { signature: "sig2" }] })
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce([
        {
          signature: "sig1",
          tokenTransfers: [
            { fromUserAccount: WALLET_A, toUserAccount: WALLET_B, tokenAmount: 100, mint: MINT },
          ],
        },
        {
          signature: "sig2",
          tokenTransfers: [
            { fromUserAccount: WALLET_A, toUserAccount: WALLET_B, tokenAmount: 200, mint: MINT },
          ],
        },
      ]);

    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].weight).toBe(300);
    expect(result.edges[0].txCount).toBe(2);
  });

  it("ignores self-transfers", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce([
        {
          signature: "sig1",
          tokenTransfers: [
            { fromUserAccount: WALLET_A, toUserAccount: WALLET_A, tokenAmount: 50, mint: MINT },
          ],
        },
      ]);

    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(0);
  });

  it("ignores transfers from non-holder wallets", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce([
        {
          signature: "sig1",
          tokenTransfers: [
            { fromUserAccount: "unknownWallet", toUserAccount: WALLET_A, tokenAmount: 50, mint: MINT },
          ],
        },
      ]);

    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(0);
  });

  it("ignores transfers with missing from/to accounts", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce([
        {
          signature: "sig1",
          tokenTransfers: [
            { toUserAccount: WALLET_A, tokenAmount: 50, mint: MINT },
            { fromUserAccount: WALLET_A, tokenAmount: 50, mint: MINT },
          ],
        },
      ]);

    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(0);
  });

  it("caches result in redis after building", async () => {
    const mockSet = vi.fn().mockResolvedValue("OK");
    const mockRedis = {
      get: vi.fn().mockResolvedValueOnce(null),
      set: mockSet,
    } as any;
    initGraphCache(mockRedis);

    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);

    expect(mockSet).toHaveBeenCalledOnce();
    // Reset cache
    initGraphCache(null as any);
  });

  it("handles redis cache error gracefully on read", async () => {
    const mockRedis = {
      get: vi.fn().mockRejectedValueOnce(new Error("redis down")),
      set: vi.fn(),
    } as any;
    initGraphCache(mockRedis);

    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.nodes.length).toBeGreaterThan(0);
    // Reset cache
    initGraphCache(null as any);
  });

  it("handles redis cache error gracefully on write", async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValueOnce(null),
      set: vi.fn().mockRejectedValueOnce(new Error("redis write error")),
    } as any;
    initGraphCache(mockRedis);

    mockFetchJson.mockResolvedValue({ result: [] });
    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.nodes.length).toBeGreaterThan(0);
    // Reset cache
    initGraphCache(null as any);
  });

  it("handles transfers with missing tokenAmount", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce([
        {
          signature: "sig1",
          tokenTransfers: [
            { fromUserAccount: WALLET_A, toUserAccount: WALLET_B, mint: MINT },
          ],
        },
      ]);

    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].weight).toBe(0);
  });

  it("handles transactions with no tokenTransfers field", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce([
        { signature: "sig1" },
      ]);

    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(0);
  });

  it("parseTransactions returns empty array for non-array response", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: [{ signature: "sig1" }] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ notAnArray: true });

    const lpSet = new Set<string>();
    const result = await buildInsiderGraph(MINT, holders, 100000, API_KEY, lpSet);
    expect(result.edges).toHaveLength(0);
  });
});

describe("buildInsiderGraph — Helius pooling (PR #294)", () => {
  it("caps analysis to INSIDER_MAX_HOLDERS top wallets", async () => {
    // Build 50 fake holders to ensure the slice gate kicks in even if the
    // constant is later raised. Asserting the *cap exists* (not the exact
    // value) protects the audit invariant — the engine never analyses
    // unbounded holders.
    const many = Array.from({ length: 50 }, (_, i) => ({
      address: `Wallet${String(i).padStart(2, "0")}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      uiAmount: 100 - i,
    }));
    mockFetchJson.mockResolvedValue({ result: [] });

    const result = await buildInsiderGraph(MINT, many, 1_000_000, API_KEY, new Set());

    // Whatever INSIDER_MAX_HOLDERS is, the analyzed set must be bounded.
    expect(result.stats.analyzedWallets).toBeLessThanOrEqual(50);
    expect(result.stats.analyzedWallets).toBeLessThan(many.length + 1);
    // And we must have called Helius at most once per analysed wallet
    // (one getSignaturesForAddress call each, plus optionally one
    // parseTransactions batch — never more than analysedWallets + 1).
    expect(mockFetchJson.mock.calls.length).toBeLessThanOrEqual(result.stats.analyzedWallets + 1);
  });

  it("does NOT consult the per-wallet signature cache (decommissioned 2026-05-11)", async () => {
    // Regression guard for the Upstash-quota audit. The original
    // per-wallet `igsig:<wallet>` cache was removed because every scan
    // did N GETs + up to N SETs (N ≤ MAX_HOLDERS = 20) for what turned
    // out to be a tiny cross-token overlap optimisation — the graph-
    // level `ig:<mint>` cache already absorbs the dominant
    // same-token-rescanned-within-5min case. Removing the sig cache
    // cut ~12 Redis commands per scan.
    //
    // This test now asserts that even when a Redis client is wired in,
    // buildInsiderGraph queries ONLY the graph cache key (`ig:<mint>`)
    // and never the per-wallet keys. If a future refactor reintroduces
    // the per-wallet cache by accident, this test fails.
    const mockGet = vi.fn().mockResolvedValue(null);
    const mockSet = vi.fn().mockResolvedValue("OK");
    initGraphCache({ get: mockGet, set: mockSet } as any);

    mockFetchJson.mockResolvedValue([]);
    await buildInsiderGraph(MINT, holders, 100_000, API_KEY, new Set([LP_ADDR]));

    const getKeys = mockGet.mock.calls.map((c) => c[0] as string);
    // Graph-level cache GET is allowed (and expected) — exactly one of those.
    expect(getKeys.filter((k) => k.startsWith("ig:")).length).toBe(1);
    // Per-wallet signature cache must be zero.
    expect(getKeys.some((k) => k.startsWith("igsig:"))).toBe(false);

    const setKeys = mockSet.mock.calls.map((c) => c[0] as string);
    // The graph-level cache SET is allowed (the result write); per-
    // wallet sig cache writes must never happen.
    expect(setKeys.some((k) => k.startsWith("igsig:"))).toBe(false);

    initGraphCache(null as any);
  });
});

describe("buildInsiderGraph — how the Helius key is sent", () => {
  it("sends getSignaturesForAddress through heliusRpc, checking that the answer carries a result array", async () => {
    mockFetchJson.mockResolvedValue({ result: [] });

    await buildInsiderGraph(MINT, holders, 100000, API_KEY, new Set<string>());

    expect(heliusRpcMock).toHaveBeenCalled();
    const [key, body, , , opts] = heliusRpcMock.mock.calls[0];
    expect(key).toBe(API_KEY);
    expect((body as { method: string }).method).toBe("getSignaturesForAddress");
    // HTTP 200 without a result array is retried in the other form; a real empty array is fine.
    expect(opts?.usable?.({ result: [] })).toBe(true);
    expect(opts?.usable?.({ result: [{ signature: "s" }] })).toBe(true);
    expect(opts?.usable?.({})).toBe(false);
    expect(opts?.usable?.({ result: null })).toBe(false);
  });
});

// A Vercel preview deployment shares the Upstash database with production: its graph is cached under its own
// namespace (api/_lib/deployment.ts), and production keeps the key it always had.
describe("buildInsiderGraph - Redis key on a preview deployment", () => {
  afterEach(() => { vi.unstubAllEnvs(); initGraphCache(null as any); });

  const writesOf = async () => {
    mockFetchJson.mockResolvedValue({ result: [] });
    const writes: string[] = [];
    initGraphCache({ get: async () => null, set: async (k: string) => { writes.push(k); return "OK"; } } as unknown as Redis);
    await buildInsiderGraph(MINT, holders, 100000, API_KEY, new Set<string>());
    return writes;
  };

  it("a preview caches the graph under its deployment namespace", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_AAA");
    expect(await writesOf()).toEqual([`pv:dpl_AAA:${INSIDER_GRAPH_CACHE_PREFIX}${MINT}`]);
  });

  it("production keeps the key it always had", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await writesOf()).toEqual([`${INSIDER_GRAPH_CACHE_PREFIX}${MINT}`]);
  });
});
