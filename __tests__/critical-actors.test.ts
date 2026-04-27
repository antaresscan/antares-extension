import { describe, it, expect } from "vitest";
import { composeCriticalActors } from "../api/_lib/critical-actors";
import type { HeliusHolder, CriticalActor } from "../api/_lib/types";
import type { InsiderGraphResult } from "../api/_lib/insider-graph";

const SUPPLY = 1_000_000;
const holder = (owner: string, uiAmount: number): HeliusHolder => ({
  address: owner + "_acct",
  owner,
  uiAmount,
});

describe("composeCriticalActors", () => {
  it("returns empty array when no creator and no holders", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [],
      totalSupplyUi: 0,
      insiderGraph: null,
    });
    expect(out).toEqual([]);
  });

  it("emits a Dev card when tokenCreator is known, even with no reputation data", () => {
    const out = composeCriticalActors({
      tokenCreator: "Creator111111111111111111111111111111111111",
      creatorReputation: null,
      realHolderAccounts: [],
      totalSupplyUi: 0,
      insiderGraph: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("dev");
    expect(out[0].tag).toBe("Dev");
    expect(out[0].repLbl).toMatch(/clean/i);
  });

  it("Dev card surfaces serial-deployer rep when flagged", () => {
    const out = composeCriticalActors({
      tokenCreator: "Creator111111111111111111111111111111111111",
      creatorReputation: { priorTokens: 5, flagged: true, reason: "Creator launched 5+ tokens — serial deployer" },
      realHolderAccounts: [],
      totalSupplyUi: 0,
      insiderGraph: null,
    });
    const dev = out.find((c: CriticalActor) => c.type === "dev")!;
    expect(dev.repLbl).toMatch(/5 prior/);
    expect(dev.desc).toMatch(/serial deployer/i);
    expect(dev.repWidth).toBeGreaterThan(70);
  });

  it("Dev card pct mirrors creator's holding share when creator is a top holder", () => {
    const creator = "Creator111111111111111111111111111111111111";
    const out = composeCriticalActors({
      tokenCreator: creator,
      creatorReputation: null,
      realHolderAccounts: [holder(creator, SUPPLY * 0.13)],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    const dev = out.find(c => c.type === "dev")!;
    expect(dev.pct).toBeCloseTo(13, 0);
  });

  it("emits an Insider card from the largest non-creator holder", () => {
    const creator = "Creator111111111111111111111111111111111111";
    const insider = "Insider22222222222222222222222222222222222";
    const out = composeCriticalActors({
      tokenCreator: creator,
      creatorReputation: null,
      realHolderAccounts: [
        holder(creator, SUPPLY * 0.13),
        holder(insider, SUPPLY * 0.084),
      ],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    const ins = out.find(c => c.type === "insider")!;
    expect(ins.tag).toBe("Insider");
    expect(ins.pct).toBeCloseTo(8.4, 0);
    expect(ins.addr).toMatch(/^Insi…2222$/);
  });

  it("escalates Insider description when single wallet holds > 5% of supply", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [holder("Whale1234567890", SUPPLY * 0.07)],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    const ins = out.find(c => c.type === "insider")!;
    expect(ins.desc).toMatch(/dump would crash/i);
    expect(ins.repWidth).toBeGreaterThan(70);
  });

  it("emits a Cluster card from the largest insider-graph cluster", () => {
    const graph: InsiderGraphResult = {
      nodes: [], edges: [],
      clusters: [
        { wallets: ["w1", "w2", "w3", "w4", "w5", "w6", "w7"], totalPct: 11.9, label: "Insider Group 1" },
        { wallets: ["x1", "x2"], totalPct: 0.4, label: "Insider Group 2" },
      ],
      stats: { totalHolders: 0, analyzedWallets: 0, clusterCount: 2, insiderPct: 12.3 },
      cachedAt: 0,
    };
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [],
      totalSupplyUi: SUPPLY,
      insiderGraph: graph,
    });
    const cluster = out.find(c => c.type === "cluster")!;
    expect(cluster).toBeDefined();
    expect(cluster.tag).toBe("Insider Group 1");
    expect(cluster.pct).toBeCloseTo(11.9, 1);
    expect(cluster.addr).toBe("7 sibling wallets");
    expect(cluster.repWarn).toBe(true);
  });

  it("skips noise clusters (< 1% supply or singletons)", () => {
    const graph: InsiderGraphResult = {
      nodes: [], edges: [],
      clusters: [{ wallets: ["x1", "x2"], totalPct: 0.4, label: "Insider Group 1" }],
      stats: { totalHolders: 0, analyzedWallets: 0, clusterCount: 1, insiderPct: 0.4 },
      cachedAt: 0,
    };
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [],
      totalSupplyUi: SUPPLY,
      insiderGraph: graph,
    });
    expect(out.find(c => c.type === "cluster")).toBeUndefined();
  });
});
