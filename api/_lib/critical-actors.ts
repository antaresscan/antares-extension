// api/_lib/critical-actors.ts — composes the "Critical Actors" preview.
//
// Always emits up to 3 cards = the top 3 biggest non-LP holders, ranked.
// Each card's tag and description is enriched when the wallet matches
// the token's creator (Dev) or a cluster of coordinated wallets detected
// by the insider-graph. This guarantees the section is never empty:
// every scan with at least one real holder produces at least one card,
// and tokens with the typical 10+ non-LP holders fill all 3 slots.
//
// Previous design returned a heterogeneous Dev / Insider / Cluster mix
// where any slot could be missing — small / new tokens often only had
// the Insider card visible, leaving a half-empty section. The "always
// top 3" shape is denser and more informative across every scan.
//
// Backend → frontend contract: each CriticalActor object is rendered as
// a card by `buildCriticalActorsPreview` in js/token-app.js. The frontend
// keeps its existing fallback for empty arrays so we degrade gracefully
// on tokens where realHolderAccounts can't be resolved.

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

function pctOfHolder(holder: HeliusHolder, supply: number): number {
  if (supply <= 0) return 0;
  const amount = typeof holder.uiAmount === "number" ? holder.uiAmount : 0;
  return Math.round((amount / supply) * 1000) / 10;
}

/**
 * Compose the description + reputation labels for a single holder card.
 * Decisions:
 *   - If the holder is the token creator → tag "Creator", weave
 *     creator-reputation info (prior tokens, serial-deployer flag) into
 *     the description so we don't lose that signal.
 *   - If the holder is part of a detected cluster (≥2 wallets, ≥1%
 *     total) → tag "Cluster A/B/…" and reference the sibling count.
 *   - Otherwise → tag "Holder #1/#2/#3", description scales with
 *     concentration % (≥5% = single-wallet dump risk; ≥2% = significant
 *     position; <2% = moderate).
 */
function describeHolder(args: {
  rank: number;
  pct: number;
  isCreator: boolean;
  creatorReputation: CreatorReputation | null;
  clusterLabel: string | null;
  clusterWallets: number | null;
}): { tag: string; repLbl: string; repWidth: number; repWarn: boolean; desc: string } {
  const { rank, pct, isCreator, creatorReputation, clusterLabel, clusterWallets } = args;

  // ── Creator path ──────────────────────────────────────────────────
  if (isCreator) {
    const priorTokens = creatorReputation?.priorTokens ?? 0;
    const flagged = creatorReputation?.flagged === true;
    let repLbl: string;
    let repWidth: number;
    let desc: string;
    if (flagged && priorTokens >= 3) {
      repLbl = `Reputation · ${priorTokens} prior tokens launched`;
      repWidth = Math.min(95, 60 + priorTokens * 4);
      desc =
        creatorReputation?.reason ??
        `Token creator wallet — serial deployer with ${priorTokens} previous launches.`;
    } else if (priorTokens > 0) {
      repLbl = `Reputation · ${priorTokens} prior token${priorTokens > 1 ? "s" : ""}`;
      repWidth = Math.min(70, 30 + priorTokens * 8);
      desc =
        priorTokens === 1
          ? "Token creator wallet — first-time creator with one prior launch on record."
          : `Token creator wallet — launched ${priorTokens} previous tokens, watch for serial-deployer pattern.`;
    } else {
      repLbl = "Reputation · clean record";
      repWidth = 25;
      desc = `Token creator wallet — holds <b>${pct.toFixed(1)}%</b> of supply, no prior tokens detected.`;
    }
    return {
      tag: "Creator",
      repLbl,
      repWidth,
      repWarn: flagged,
      desc,
    };
  }

  // ── Cluster path ──────────────────────────────────────────────────
  if (clusterLabel && clusterWallets && clusterWallets >= 2) {
    const intensity = Math.min(95, 50 + clusterWallets * 6 + Math.round(pct * 2));
    return {
      tag: clusterLabel,
      repLbl: "Coordination score",
      repWidth: intensity,
      repWarn: true,
      desc: `In a cluster of <b>${clusterWallets} wallets</b> that moved tokens between each other — coordinated buy or distribution pattern.`,
    };
  }

  // ── Generic top-holder path ──────────────────────────────────────
  // Concentration risk scales with pct. ≥5% = dump-risk single wallet.
  // 2-5% = significant position. <2% = moderate, watch for accumulation.
  let repLbl: string;
  let repWidth: number;
  let desc: string;
  if (pct >= 5) {
    repLbl = "Concentration risk · single wallet";
    repWidth = Math.min(95, 60 + pct * 3);
    desc = `Holds <b>${pct.toFixed(1)}%</b> of supply — one-wallet dump would crash the price.`;
  } else if (pct >= 2) {
    repLbl = "Significant single-wallet position";
    repWidth = Math.min(75, 30 + pct * 8);
    desc = `Holds <b>${pct.toFixed(1)}%</b> of supply — large enough to move the chart on exit.`;
  } else if (pct >= 0.5) {
    repLbl = `Top-${rank} non-dev holder`;
    repWidth = Math.max(20, Math.round(pct * 20));
    desc = `Holds <b>${pct.toFixed(1)}%</b> of supply — moderate position, watch for accumulation.`;
  } else {
    repLbl = `Top-${rank} holder`;
    repWidth = Math.max(10, Math.round(pct * 30));
    desc = `Holds <b>${pct.toFixed(1)}%</b> of supply — small but visible enough to track.`;
  }
  return {
    tag: `Holder #${rank}`,
    repLbl,
    repWidth,
    repWarn: pct >= 5,
    desc,
  };
}

export function composeCriticalActors(input: ComposeCriticalActorsInput): CriticalActor[] {
  const { tokenCreator, creatorReputation, realHolderAccounts, totalSupplyUi, insiderGraph } = input;
  const out: CriticalActor[] = [];

  // Build a quick lookup: which wallets are in detected clusters? Maps
  // wallet → { label, walletCount } for the largest cluster the wallet
  // belongs to. We only consider clusters of ≥2 wallets and ≥1% total
  // supply (smaller is noise from the insider-graph).
  const walletToCluster = new Map<
    string,
    { label: string; walletCount: number }
  >();
  if (insiderGraph && Array.isArray(insiderGraph.clusters)) {
    for (const cluster of insiderGraph.clusters) {
      if (cluster.wallets.length < 2 || cluster.totalPct < 1) continue;
      for (const w of cluster.wallets) {
        // Only set if not already mapped — first cluster wins (clusters
        // are pre-sorted by totalPct desc, so first = largest).
        if (!walletToCluster.has(w)) {
          walletToCluster.set(w, {
            label: cluster.label,
            walletCount: cluster.wallets.length,
          });
        }
      }
    }
  }

  // Iterate top holders in order (already filtered for LP/foundation by
  // scan.ts before passing as realHolderAccounts) and emit up to 3.
  for (const holder of realHolderAccounts) {
    if (out.length >= 3) break;
    if (!holder.owner) continue;
    const pct = pctOfHolder(holder, totalSupplyUi);
    if (pct <= 0) continue;
    const isCreator = holder.owner === tokenCreator;
    const cluster = walletToCluster.get(holder.owner) ?? null;

    const meta = describeHolder({
      rank: out.length + 1,
      pct,
      isCreator,
      creatorReputation,
      clusterLabel: cluster?.label ?? null,
      clusterWallets: cluster?.walletCount ?? null,
    });

    out.push({
      type: isCreator ? "dev" : cluster ? "cluster" : "insider",
      tag: meta.tag,
      pct,
      addr: shortAddr(holder.owner),
      repLbl: meta.repLbl,
      repWidth: meta.repWidth,
      repWarn: meta.repWarn,
      desc: meta.desc,
    });
  }

  return out;
}
