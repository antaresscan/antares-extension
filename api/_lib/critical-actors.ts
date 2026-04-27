// api/_lib/critical-actors.ts — composes the 3-card "Critical Actors"
// preview for the token page hero. Input is what scan.ts already
// computes (creator + reputation + filtered top holders + optional
// insider-graph result); output is a small payload the frontend
// renders directly without any further client-side derivation.
//
// The shape mirrors the v5 design's three cards:
//   1. Dev      — tokenCreator + prior token launches (serial deployer flag)
//   2. Insider  — largest non-creator holder (single sniper / whale)
//   3. Cluster  — largest detected cluster from the insider-graph
// Any card can be null; the frontend hides those slots.

import type { CreatorReputation } from "./fetchers";
import type { HeliusHolder, CriticalActor } from "./types";
import type { InsiderGraphResult } from "./insider-graph";

export type { CriticalActor };

export interface ComposeCriticalActorsInput {
  tokenCreator: string | null;
  creatorReputation: CreatorReputation | null;
  realHolderAccounts: HeliusHolder[];
  totalSupplyUi: number;
  insiderGraph: InsiderGraphResult | null;
}

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a || "—";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function pctOfHolder(holder: HeliusHolder | undefined, supply: number): number {
  if (!holder || supply <= 0) return 0;
  const amount = typeof holder.uiAmount === "number" ? holder.uiAmount : 0;
  return Math.round((amount / supply) * 1000) / 10;
}

export function composeCriticalActors(input: ComposeCriticalActorsInput): CriticalActor[] {
  const { tokenCreator, creatorReputation, realHolderAccounts, totalSupplyUi, insiderGraph } = input;
  const out: CriticalActor[] = [];

  // ─── Dev card ────────────────────────────────────────────────
  // Shown whenever we have a tokenCreator — even if reputation is
  // unflagged ("Reputation · clean (1 prior token)") so the slot is
  // never empty when an address is known. The dev's holding pct is
  // looked up in the top holders if present.
  if (tokenCreator) {
    const devHolder = realHolderAccounts.find(h => h.owner === tokenCreator);
    const devPct = pctOfHolder(devHolder, totalSupplyUi);
    const priorTokens = creatorReputation?.priorTokens ?? 0;
    const flagged = creatorReputation?.flagged === true;

    let repLbl: string;
    let repWidth: number;
    let desc: string;
    if (flagged && priorTokens >= 3) {
      repLbl = `Reputation · ${priorTokens} prior token${priorTokens > 1 ? "s" : ""} launched`;
      repWidth = Math.min(95, 60 + priorTokens * 4);
      desc = creatorReputation?.reason ?? `Serial deployer — ${priorTokens} previous launches.`;
    } else if (priorTokens > 0) {
      repLbl = `Reputation · ${priorTokens} prior token${priorTokens > 1 ? "s" : ""}`;
      repWidth = Math.min(70, 30 + priorTokens * 8);
      desc = priorTokens === 1
        ? "First-time creator with one prior launch on record."
        : `Creator launched ${priorTokens} previous tokens — watch for serial-deployer pattern.`;
    } else {
      repLbl = "Reputation · clean record";
      repWidth = 20;
      desc = "No prior tokens detected for this creator wallet.";
    }

    out.push({
      type: "dev",
      tag: "Dev",
      pct: devPct,
      addr: shortAddr(tokenCreator),
      repLbl,
      repWidth,
      repWarn: false,
      desc,
    });
  }

  // ─── Insider card ────────────────────────────────────────────
  // Largest single holder excluding the creator (which is shown in
  // the Dev card). Uses the already-filtered realHolderAccounts so
  // LPs / foundation wallets / Raydium pools are not picked.
  const insider = realHolderAccounts.find(h => h.owner !== tokenCreator);
  if (insider) {
    const insiderPct = pctOfHolder(insider, totalSupplyUi);
    if (insiderPct > 0) {
      // Heuristic for the description — based on supply pct since we
      // don't have on-chain timing here. The "block-1 sniper" copy is
      // reserved for the live Holder Activity tab where we have tx
      // history; this card just describes the static position.
      let desc: string;
      let repLbl: string;
      let repWidth: number;
      if (insiderPct >= 5) {
        repLbl = "Concentration risk · single wallet";
        repWidth = Math.min(95, 60 + insiderPct * 3);
        desc = `Holds <b>${insiderPct.toFixed(1)}%</b> of supply — one-wallet dump would crash the price.`;
      } else if (insiderPct >= 2) {
        repLbl = "Significant single-wallet position";
        repWidth = Math.min(75, 30 + insiderPct * 8);
        desc = `Holds <b>${insiderPct.toFixed(1)}%</b> of supply — large enough to move the chart on exit.`;
      } else {
        repLbl = "Top non-dev holder";
        repWidth = Math.max(15, Math.round(insiderPct * 25));
        desc = `Holds <b>${insiderPct.toFixed(1)}%</b> of supply — moderate position, watch for accumulation.`;
      }

      out.push({
        type: "insider",
        tag: "Insider",
        pct: insiderPct,
        addr: shortAddr(insider.owner),
        repLbl,
        repWidth,
        repWarn: false,
        desc,
      });
    }
  }

  // ─── Cluster card ────────────────────────────────────────────
  // The largest cluster detected by the insider-graph (sibling wallets
  // that transacted with each other). Only emitted when a cluster has
  // 2+ wallets and the cluster total ≥ 1% of supply (smaller is noise).
  if (insiderGraph && insiderGraph.clusters.length > 0) {
    const top = insiderGraph.clusters[0];
    if (top.wallets.length >= 2 && top.totalPct >= 1) {
      // Coordination intensity: bigger cluster pct + more wallets = stronger signal
      const intensity = Math.min(95, Math.round(40 + top.totalPct * 4 + top.wallets.length * 5));
      out.push({
        type: "cluster",
        tag: top.label,
        pct: Math.round(top.totalPct * 10) / 10,
        addr: `${top.wallets.length} sibling wallets`,
        repLbl: "Coordination score",
        repWidth: intensity,
        repWarn: true,
        desc: `<b>${top.wallets.length} wallets</b> moved tokens between each other — coordinated buy or distribution pattern.`,
      });
    }
  }

  return out;
}
