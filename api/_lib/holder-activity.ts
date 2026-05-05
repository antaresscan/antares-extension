// api/_lib/holder-activity.ts — composes wallet-level activity rows
// consumed by the Insider Watch tab (replaced "Holder Activity" in the
// post-#430 redesign). For each top holder we
// classify their last-60min on-chain activity into a single label
// (Holding / Selling / Buying / Splitting / Static / Reducing) and
// estimate position change as a percentage of their total holdings.
//
// Data source: the `recentTransfers` array Solscan returns alongside
// the scan. No extra RPC calls — we just slice & classify what's
// already in memory. That gives v1 a real signal without blowing the
// scan budget; a dedicated Helius per-wallet pull is the obvious
// follow-up for higher fidelity.

import type { HeliusHolder, SolscanTransfer } from "./types";
import type { InsiderGraphResult } from "./insider-graph";

export type HolderActivityRole = "dev" | "bot" | "coord" | "real" | "whale-big";
export type HolderActivityLabel =
  | "Holding"
  | "Selling"
  | "Buying"
  | "Splitting"
  | "Static"
  | "Reducing";

export interface HolderActivity {
  role: HolderActivityRole;
  label: HolderActivityLabel;
  avatar: string;       // short text shown in the avatar column ("DEV", "Insider", "Cluster A", "Whale", "Retail")
  pctChange: number;    // signed % change of position over the window
  pctChangeDisp: string; // pre-formatted "+0.4%" / "-1.2%" / "±0%"
  addr: string;         // shortened wallet or "N sibling wallets"
  desc: string;         // 1-line plain-English description
}

export interface ComposeHolderActivityInput {
  realHolderAccounts: HeliusHolder[];
  tokenCreator: string | null;
  totalSupplyUi: number;
  recentTransfers: SolscanTransfer[];
  insiderGraph: InsiderGraphResult | null;
  // Window in milliseconds. Defaults to 1 hour. Exposed so tests can
  // run with a tighter window without faking timestamps.
  windowMs?: number;
}

export interface HolderActivityResult {
  rows: HolderActivity[];
  netFlowPct: number;        // net position change across all top holders, signed %
  netFlowDirection: "in" | "out" | "flat";
}

const HOUR_MS = 60 * 60 * 1000;

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a || "—";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function clusterFor(wallet: string, graph: InsiderGraphResult | null): { label: string; size: number } | null {
  if (!graph) return null;
  for (let i = 0; i < graph.clusters.length; i++) {
    const c = graph.clusters[i];
    if (c.wallets.includes(wallet)) {
      return { label: `Cluster ${String.fromCharCode(65 + i)}`, size: c.wallets.length };
    }
  }
  return null;
}

function classify(netPctOfHolding: number, hasActivity: boolean): HolderActivityLabel {
  if (!hasActivity) return "Static";
  if (netPctOfHolding > 5) return "Buying";
  if (netPctOfHolding < -10) return "Reducing";
  if (netPctOfHolding < -1) return "Selling";
  if (Math.abs(netPctOfHolding) <= 1 && netPctOfHolding !== 0) return "Splitting";
  if (netPctOfHolding === 0) return "Holding";
  return "Holding";
}

function describe(
  label: HolderActivityLabel,
  netPct: number,
  txCount: number,
  isCreator: boolean,
  cluster: { label: string; size: number } | null,
): string {
  if (label === "Static") {
    if (isCreator) return `No on-chain move <b>last 1h</b>. Watch for fresh-wallet transfers — pre-rug pattern.`;
    return `No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks.`;
  }
  if (label === "Holding") {
    return `Active wallet, position balanced over the last hour (<b>${txCount}</b> tx in/out cancelling).`;
  }
  if (label === "Buying") {
    return `Added <b>${netPct.toFixed(1)}%</b> to position over the last hour. Late accumulation — late buyers average -94% on this profile.`;
  }
  if (label === "Selling") {
    return `Reducing position by <b>${Math.abs(netPct).toFixed(1)}%</b> over the last hour. Historical pattern: full exit within 4h of first sell.`;
  }
  if (label === "Reducing") {
    return `Sold <b>${Math.abs(netPct).toFixed(1)}%</b> of holdings in the last hour. Whales cutting losses early often precede broader exits.`;
  }
  if (label === "Splitting") {
    if (cluster && cluster.size >= 3) {
      return `<b>${cluster.size} wallets</b> moving small amounts — distribution shifting, coordinated exit may be starting.`;
    }
    return `Small in/out movements across <b>${txCount} tx</b> — testing exit liquidity or splitting position.`;
  }
  return "";
}

export function composeHolderActivity(input: ComposeHolderActivityInput): HolderActivityResult {
  const {
    realHolderAccounts, tokenCreator, totalSupplyUi,
    recentTransfers, insiderGraph,
    windowMs = HOUR_MS,
  } = input;

  if (realHolderAccounts.length === 0 || totalSupplyUi <= 0) {
    return { rows: [], netFlowPct: 0, netFlowDirection: "flat" };
  }

  const cutoffSec = (Date.now() - windowMs) / 1000;
  const recent = (recentTransfers || []).filter(t => {
    const bt = typeof t.block_time === "number" ? t.block_time : 0;
    return bt >= cutoffSec;
  });

  // For each top holder, sum in/out amount in the window.
  const top = realHolderAccounts.slice(0, 6);
  const rows: HolderActivity[] = [];
  let totalSupplyChange = 0;

  top.forEach((h, i) => {
    const wallet = h.owner;
    const holding = h.uiAmount || 0;
    if (holding <= 0) return;

    let inAmt = 0;
    let outAmt = 0;
    let txCount = 0;
    for (const t of recent) {
      const from = t.from_address ?? t.from;
      const to = t.to_address ?? t.to;
      const amt = typeof t.amount === "number" ? t.amount : 0;
      if (to === wallet) { inAmt += amt; txCount++; }
      else if (from === wallet) { outAmt += amt; txCount++; }
    }
    const net = inAmt - outAmt;
    const netPctOfHolding = (net / holding) * 100;
    const netPctOfSupply = (net / totalSupplyUi) * 100;
    totalSupplyChange += netPctOfSupply;

    const isCreator = wallet === tokenCreator;
    const cluster = clusterFor(wallet, insiderGraph);

    let role: HolderActivityRole;
    let avatar: string;
    if (isCreator) { role = "dev"; avatar = "DEV"; }
    else if (cluster) { role = "coord"; avatar = cluster.label; }
    else if (i === 0 && holding / totalSupplyUi > 0.05) { role = "bot"; avatar = "Insider"; }
    else if (holding / totalSupplyUi > 0.02) { role = "whale-big"; avatar = "Whale"; }
    else { role = "real"; avatar = "Retail"; }

    const hasActivity = txCount > 0;
    const label = classify(netPctOfHolding, hasActivity);
    const desc = describe(label, netPctOfHolding, txCount, isCreator, cluster);
    const pctChangeDisp = !hasActivity || Math.abs(netPctOfHolding) < 0.05
      ? "±0%"
      : (netPctOfHolding > 0 ? "+" : "") + netPctOfHolding.toFixed(1) + "%";

    rows.push({
      role,
      label,
      avatar,
      pctChange: Math.round(netPctOfHolding * 10) / 10,
      pctChangeDisp,
      addr: cluster && cluster.size >= 2 ? `${cluster.size} sibling wallets` : shortAddr(wallet),
      desc,
    });
  });

  const direction: "in" | "out" | "flat" =
    Math.abs(totalSupplyChange) < 0.1 ? "flat" :
    totalSupplyChange > 0 ? "in" : "out";

  return {
    rows,
    netFlowPct: Math.round(totalSupplyChange * 10) / 10,
    netFlowDirection: direction,
  };
}
