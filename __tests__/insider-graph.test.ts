import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildInsiderGraph, initGraphCache } from "../api/_lib/insider-graph";

vi.mock("../api/_lib/helpers", () => ({
  fetchJson: vi.fn(),
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
});
