import { describe, it, expect } from "vitest";
import { composeHolderActivity } from "../api/_lib/holder-activity";
import type { HeliusHolder, SolscanTransfer } from "../api/_lib/types";
import type { InsiderGraphResult } from "../api/_lib/insider-graph";

const SUPPLY = 1_000_000;
const NOW = Date.now();
const MIN = 60_000;

const holder = (owner: string, uiAmount: number): HeliusHolder => ({
  address: `${owner}_acct`, owner, uiAmount,
});
const transfer = (from: string, to: string, amount: number, ageMin: number): SolscanTransfer => ({
  from_address: from, to_address: to, amount, block_time: Math.floor((NOW - ageMin * MIN) / 1000),
});
const emptyGraph: InsiderGraphResult = {
  nodes: [], edges: [], clusters: [],
  stats: { totalHolders: 0, analyzedWallets: 0, clusterCount: 0, insiderPct: 0 },
  cachedAt: 0,
};

describe("composeHolderActivity", () => {
  it("returns empty rows when no holders", () => {
    const out = composeHolderActivity({
      realHolderAccounts: [],
      tokenCreator: null,
      totalSupplyUi: 0,
      recentTransfers: [],
      insiderGraph: null,
    });
    expect(out.rows).toEqual([]);
    expect(out.netFlowDirection).toBe("flat");
  });

  it("classifies a wallet with no recent activity as Static", () => {
    const out = composeHolderActivity({
      realHolderAccounts: [holder("DormantWallet1", 100_000)],
      tokenCreator: null,
      totalSupplyUi: SUPPLY,
      recentTransfers: [],
      insiderGraph: null,
    });
    expect(out.rows[0].label).toBe("Static");
    expect(out.rows[0].pctChangeDisp).toBe("±0%");
  });

  it("classifies a net-buy wallet as Buying when above +5% threshold", () => {
    const w = "BuyerWallet1";
    const out = composeHolderActivity({
      realHolderAccounts: [holder(w, 100_000)],
      tokenCreator: null,
      totalSupplyUi: SUPPLY,
      recentTransfers: [transfer("Source", w, 10_000, 10)], // +10% in last 10min
      insiderGraph: null,
    });
    expect(out.rows[0].label).toBe("Buying");
    expect(out.rows[0].pctChange).toBeCloseTo(10, 0);
  });

  it("classifies a net-sell wallet as Reducing when below -10%", () => {
    const w = "SellerWallet1";
    const out = composeHolderActivity({
      realHolderAccounts: [holder(w, 100_000)],
      tokenCreator: null,
      totalSupplyUi: SUPPLY,
      recentTransfers: [transfer(w, "Sink", 15_000, 5)], // -15%
      insiderGraph: null,
    });
    expect(out.rows[0].label).toBe("Reducing");
    expect(out.rows[0].pctChange).toBeCloseTo(-15, 0);
  });

  it("classifies a small net-sell as Selling", () => {
    const w = "SellerWallet2";
    const out = composeHolderActivity({
      realHolderAccounts: [holder(w, 100_000)],
      tokenCreator: null,
      totalSupplyUi: SUPPLY,
      recentTransfers: [transfer(w, "Sink", 3_000, 5)], // -3%
      insiderGraph: null,
    });
    expect(out.rows[0].label).toBe("Selling");
  });

  it("ignores transfers older than the window", () => {
    const w = "OldWallet1";
    const out = composeHolderActivity({
      realHolderAccounts: [holder(w, 100_000)],
      tokenCreator: null,
      totalSupplyUi: SUPPLY,
      recentTransfers: [transfer(w, "Sink", 50_000, 120)], // 2h ago, outside 1h window
      insiderGraph: null,
    });
    expect(out.rows[0].label).toBe("Static");
  });

  it("labels the creator wallet as Dev role", () => {
    const creator = "CreatorWallet1";
    const out = composeHolderActivity({
      realHolderAccounts: [holder(creator, 100_000)],
      tokenCreator: creator,
      totalSupplyUi: SUPPLY,
      recentTransfers: [],
      insiderGraph: null,
    });
    expect(out.rows[0].role).toBe("dev");
    expect(out.rows[0].avatar).toBe("DEV");
  });

  it("attaches cluster label when wallet is in a cluster", () => {
    const w = "ClusterMember1";
    const graph: InsiderGraphResult = {
      ...emptyGraph,
      clusters: [{ wallets: [w, "x", "y", "z"], totalPct: 11.9, label: "Insider Group 1" }],
    };
    const out = composeHolderActivity({
      realHolderAccounts: [holder(w, 50_000)],
      tokenCreator: null,
      totalSupplyUi: SUPPLY,
      recentTransfers: [],
      insiderGraph: graph,
    });
    expect(out.rows[0].role).toBe("coord");
    expect(out.rows[0].avatar).toBe("Cluster A");
    expect(out.rows[0].addr).toBe("4 sibling wallets");
  });

  it("computes net-flow direction across all top holders", () => {
    const w1 = "OutFlow1";
    const w2 = "OutFlow2";
    const out = composeHolderActivity({
      realHolderAccounts: [holder(w1, 100_000), holder(w2, 100_000)],
      tokenCreator: null,
      totalSupplyUi: SUPPLY,
      recentTransfers: [
        transfer(w1, "Sink", 30_000, 10),
        transfer(w2, "Sink", 20_000, 5),
      ],
      insiderGraph: null,
    });
    expect(out.netFlowDirection).toBe("out");
    expect(out.netFlowPct).toBeLessThan(0);
  });
});
