import { describe, it, expect } from "vitest";
import { composeCriticalActors } from "../api/_lib/critical-actors";
import type { HeliusHolder } from "../api/_lib/types";
import type { InsiderGraphResult } from "../api/_lib/insider-graph";

const SUPPLY = 1_000_000;
const holder = (owner: string, uiAmount: number): HeliusHolder => ({
  address: owner + "_acct",
  owner,
  uiAmount,
});

describe("composeCriticalActors — top-3 holders model", () => {
  it("returns empty array when there are no holders (no dummy fallback)", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [],
      totalSupplyUi: 0,
      insiderGraph: null,
    });
    expect(out).toEqual([]);
  });

  it("emits up to 3 cards in holder order — never more", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [
        holder("AAAA1111111111111111111111111111111111111111", SUPPLY * 0.20),
        holder("BBBB2222222222222222222222222222222222222222", SUPPLY * 0.10),
        holder("CCCC3333333333333333333333333333333333333333", SUPPLY * 0.05),
        holder("DDDD4444444444444444444444444444444444444444", SUPPLY * 0.03),
      ],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    expect(out).toHaveLength(3);
    expect(out[0].pct).toBeCloseTo(20, 0);
    expect(out[1].pct).toBeCloseTo(10, 0);
    expect(out[2].pct).toBeCloseTo(5, 0);
  });

  it("tags rank #1 / #2 / #3 by default (no creator, no cluster)", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [
        holder("AAAA1111111111111111111111111111111111111111", SUPPLY * 0.10),
        holder("BBBB2222222222222222222222222222222222222222", SUPPLY * 0.05),
        holder("CCCC3333333333333333333333333333333333333333", SUPPLY * 0.02),
      ],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    expect(out[0].tag).toBe("Holder #1");
    expect(out[1].tag).toBe("Holder #2");
    expect(out[2].tag).toBe("Holder #3");
  });

  it("flags top holder as 'Creator' when its address matches tokenCreator", () => {
    const creator = "Creator11111111111111111111111111111111111111";
    const out = composeCriticalActors({
      tokenCreator: creator,
      creatorReputation: null,
      realHolderAccounts: [
        holder(creator, SUPPLY * 0.13),
        holder("OtherWhale222222222222222222222222222222222222", SUPPLY * 0.07),
      ],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    expect(out[0].type).toBe("dev");
    expect(out[0].tag).toBe("Creator");
    expect(out[0].pct).toBeCloseTo(13, 0);
    // Second card stays as a regular Holder
    expect(out[1].tag).toBe("Holder #2");
  });

  it("Creator card surfaces serial-deployer reputation when flagged", () => {
    const creator = "Creator11111111111111111111111111111111111111";
    const out = composeCriticalActors({
      tokenCreator: creator,
      creatorReputation: { priorTokens: 5, flagged: true, reason: "Creator launched 5+ tokens — serial deployer" },
      realHolderAccounts: [holder(creator, SUPPLY * 0.13)],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    const dev = out[0];
    expect(dev.tag).toBe("Creator");
    expect(dev.repLbl).toMatch(/5 prior/);
    expect(dev.desc).toMatch(/serial deployer/i);
    expect(dev.repWarn).toBe(true);
  });

  it("escalates description when single wallet holds > 5% of supply", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [holder("Whale12345678901234567890123456789012345", SUPPLY * 0.07)],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    expect(out[0].desc).toMatch(/dump would crash/i);
    expect(out[0].repWidth).toBeGreaterThan(70);
    expect(out[0].repWarn).toBe(true);
  });

  it("flags a holder that's part of a detected cluster (≥2 wallets, ≥1% supply)", () => {
    const w1 = "ClusterWallet1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const w2 = "ClusterWallet2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const graph: InsiderGraphResult = {
      nodes: [],
      edges: [],
      clusters: [
        { wallets: [w1, w2, "x", "y", "z"], totalPct: 11.9, label: "Insider Group 1" },
      ],
      stats: { totalHolders: 0, analyzedWallets: 0, clusterCount: 1, insiderPct: 11.9 },
      cachedAt: 0,
    };
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [
        holder(w1, SUPPLY * 0.06),
        holder(w2, SUPPLY * 0.04),
      ],
      totalSupplyUi: SUPPLY,
      insiderGraph: graph,
    });
    expect(out[0].type).toBe("cluster");
    expect(out[0].tag).toBe("Insider Group 1");
    expect(out[0].repWarn).toBe(true);
    expect(out[0].desc).toMatch(/cluster of <b>5 wallets<\/b>/);
  });

  it("ignores noise clusters (< 1% supply or singletons)", () => {
    const w1 = "ClusterWallet1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const graph: InsiderGraphResult = {
      nodes: [],
      edges: [],
      clusters: [{ wallets: [w1, "x"], totalPct: 0.4, label: "Insider Group 1" }],
      stats: { totalHolders: 0, analyzedWallets: 0, clusterCount: 1, insiderPct: 0.4 },
      cachedAt: 0,
    };
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [holder(w1, SUPPLY * 0.06)],
      totalSupplyUi: SUPPLY,
      insiderGraph: graph,
    });
    // Cluster too small to flag — falls back to generic Holder #1 tag
    expect(out[0].tag).toBe("Holder #1");
    expect(out[0].type).toBe("insider");
  });

  it("skips holders with 0% supply (zero-balance accounts)", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [
        holder("Real111111111111111111111111111111111111111", SUPPLY * 0.10),
        holder("Zero222222222222222222222222222222222222222", 0),
        holder("Real333333333333333333333333333333333333333", SUPPLY * 0.04),
      ],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    expect(out).toHaveLength(2);
    expect(out[0].pct).toBeCloseTo(10, 0);
    expect(out[1].pct).toBeCloseTo(4, 0);
  });

  it("addresses are short-formatted (4…4 chars)", () => {
    const out = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: [holder("ABCD1234567890qwertyabcd1234567890qwertyEFGH", SUPPLY * 0.05)],
      totalSupplyUi: SUPPLY,
      insiderGraph: null,
    });
    expect(out[0].addr).toBe("ABCD…EFGH");
  });
});
