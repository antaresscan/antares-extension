// api/_lib/insider-graph.ts — Insider Network Graph builder
// Analyzes top holder wallets to detect coordinated clusters
import { fetchJson } from "./helpers";
import { heliusRpc } from "./helius";
import { runWithConcurrency } from "./concurrency";
import { deploymentNamespace } from "./deployment";
import {
  HELIUS_REST_BASE,
  INSIDER_MAX_HOLDERS, INSIDER_MAX_SIGNATURES,
  INSIDER_GRAPH_CACHE_TTL, INSIDER_GRAPH_CACHE_PREFIX,
  // INSIDER_SIG_CACHE_TTL / INSIDER_SIG_CACHE_PREFIX intentionally not
  // imported — the per-wallet signature cache was removed in the
  // Upstash-quota audit (see `getCachedWalletSignatures` below for the
  // rationale). The constants are kept in `constants.ts` for now so any
  // external references don't break.
} from "./constants";
import type { Redis } from "@upstash/redis";

// Max simultaneous Helius RPC calls when fanning out per-holder signature
// fetches. Helius free tier permits ~10 req/s sustained; bursting 20 in
// the same tick from a cold-graph scan was tripping 429s. Five-in-flight
// keeps us comfortably below the ceiling while still finishing the
// 20-holder sweep in ~4 batches.
const HELIUS_SIG_CONCURRENCY = 5;

// Constants imported from constants.ts
const MAX_HOLDERS = INSIDER_MAX_HOLDERS;
const MAX_SIGNATURES = INSIDER_MAX_SIGNATURES;
const GRAPH_CACHE_TTL = INSIDER_GRAPH_CACHE_TTL;
const GRAPH_CACHE_PREFIX = INSIDER_GRAPH_CACHE_PREFIX;

// ─── TYPES ─────────────────────────────────────────────────────────────
export interface GraphNode {
  id: string;          // wallet address (truncated for display)
  address: string;     // full wallet address
  holdings: number;    // token balance (UI amount)
  pctSupply: number;   // percentage of total supply
  isLP: boolean;       // is this a known LP/program address
  label?: string;      // optional label ("Creator", "LP", etc.)
}

export interface GraphEdge {
  source: string;      // wallet address
  target: string;      // wallet address
  weight: number;      // transfer volume between the two
  txCount: number;     // number of transactions
}

export interface InsiderCluster {
  wallets: string[];
  totalPct: number;    // combined supply percentage
  label: string;       // "Cluster A", "Insider Group 1", etc.
}

export interface InsiderGraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: InsiderCluster[];
  stats: {
    totalHolders: number;
    analyzedWallets: number;
    clusterCount: number;
    insiderPct: number;  // total % held by clustered wallets
  };
  cachedAt: number;
}

// ─── CACHE ─────────────────────────────────────────────────────────────
let redis: Redis | null = null;
export function initGraphCache(r: Redis): void {
  redis = r;
}

// ─── UNION-FIND for cluster detection ──────────────────────────────────
class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) { this.parent.set(x, x); this.rank.set(x, 0); }
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else { this.parent.set(rb, ra); this.rank.set(ra, rankA + 1); }
  }

  getClusters(): Map<string, string[]> {
    const clusters = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(key);
    }
    return clusters;
  }
}

// ─── HELIUS HELPERS ────────────────────────────────────────────────────
interface HeliusSignature {
  signature: string;
  slot?: number;
}

interface HeliusParsedTx {
  signature: string;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
    mint?: string;
  }>;
}

async function getWalletSignatures(
  wallet: string, apiKey: string
): Promise<string[]> {
  try {
    // Sent through heliusRpc: it negotiates how the key is sent (header or
    // ?api-key=) and logs when Helius refuses it. The `usable` check retries
    // once in the other form if a 200 comes back without a result array.
    const res = await heliusRpc<{ result?: HeliusSignature[] }>(apiKey, {
      jsonrpc: "2.0", id: 1,
      method: "getSignaturesForAddress",
      params: [wallet, { limit: MAX_SIGNATURES }],
    }, 5000, 1, { usable: (r) => Array.isArray(r.result) });
    const sigs = res?.result ?? [];
    return Array.isArray(sigs) ? sigs.map(s => s.signature) : [];
  } catch {
    return [];
  }
}

// Per-wallet signature cache REMOVED on 2026-05-11 after Upstash audit.
//
// The original design cached Helius `getSignaturesForAddress` results
// per wallet for 5 min so consecutive scans of the SAME token re-using
// the same top holders would skip Helius. The flaw: every scan did N
// GETs (one per top holder) + up to N SETs on miss. At MAX_HOLDERS = 20
// that's ~20–40 Redis commands per scan. Multiplied across 30 active
// users on free tier (500 K cmd/month cap), the sig cache alone
// consumed ~80 % of the monthly budget.
//
// The graph-level cache at `${deploymentNamespace()}${GRAPH_CACHE_PREFIX}${mint}` (5 min TTL)
// already absorbs the dominant repeat case (same token re-scanned within
// 5 min — every cache HIT skips ALL sig fetches). The per-wallet
// cross-token overlap optimisation the sig cache used to provide is
// empirically tiny: top holders rarely overlap across DIFFERENT mints
// within a 5-minute window. We pay slightly more Helius calls on cold-
// graph scans in exchange for cutting ~12 Redis commands per scan, and
// Helius has more headroom than Upstash at the current scale.
async function getCachedWalletSignatures(
  wallet: string, apiKey: string,
): Promise<string[]> {
  return getWalletSignatures(wallet, apiKey);
}

async function parseTransactions(
  signatures: string[], apiKey: string
): Promise<HeliusParsedTx[]> {
  if (!signatures.length) return [];
  try {
    // Helius Enhanced Transactions: `?api-key=` query param auth ONLY
    // — the Bearer header worked for the RPC mainnet endpoint until mid-2026 but
    // returns 401 here. Was silently swallowed by fetchJson (null
    // result), making `parsedTxs` always empty → graph edges + clusters
    // were always [] in production. Diagnosed via the activity-feed
    // diagnostic fields that revealed parsedTxsCount=0 across tokens.
    const res = await fetchJson(`${HELIUS_REST_BASE}/v0/transactions?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: signatures.slice(0, 20) }),
    }, 8000);
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  }
}

// ─── MAIN GRAPH BUILDER ───────────────────────────────────────────────
export async function buildInsiderGraph(
  mint: string,
  holders: Array<{ address: string; uiAmount: number }>,
  totalSupply: number,
  apiKey: string,
  lpAddresses: Set<string>,
): Promise<InsiderGraphResult> {
  // Check cache first
  if (redis) {
    try {
      const cached = await redis.get<InsiderGraphResult>(`${deploymentNamespace()}${GRAPH_CACHE_PREFIX}${mint}`);
      if (cached) return cached;
    } catch { /* continue */ }
  }

  const topHolders = holders
    .filter(h => !lpAddresses.has(h.address))
    .slice(0, MAX_HOLDERS);

  // Build nodes
  const nodes: GraphNode[] = topHolders.map(h => ({
    id: `${h.address.slice(0, 4)}...${h.address.slice(-4)}`,
    address: h.address,
    holdings: h.uiAmount,
    pctSupply: totalSupply > 0 ? (h.uiAmount / totalSupply) * 100 : 0,
    isLP: lpAddresses.has(h.address),
  }));

  // Fetch transaction signatures for each top holder. Bounded to
  // HELIUS_SIG_CONCURRENCY (5) simultaneous requests — at MAX_HOLDERS = 20
  // an unbounded Promise.all reliably tripped Helius free-tier's 10 req/s
  // ceiling on cold-graph paths. 5-in-flight stays comfortably under the
  // budget while keeping the latency penalty small (4 batches of 5
  // ≈ 4 × per-call duration instead of 1 burst).
  const walletAddresses = topHolders.map(h => h.address);
  const sigResults = await runWithConcurrency(
    walletAddresses,
    HELIUS_SIG_CONCURRENCY,
    (w) => getCachedWalletSignatures(w, apiKey),
  );

  // Parse transactions to find transfers between holders
  const allSigs = [...new Set(sigResults.flat())].slice(0, 50);
  const parsedTxs = await parseTransactions(allSigs, apiKey);

  // Build edges from token transfers between top holders
  const holderSet = new Set(walletAddresses);
  const edgeMap = new Map<string, GraphEdge>();
  const uf = new UnionFind();

  for (const tx of parsedTxs) {
    for (const transfer of tx.tokenTransfers ?? []) {
      if (transfer.mint !== mint) continue;
      const from = transfer.fromUserAccount;
      const to = transfer.toUserAccount;
      if (!from || !to || !holderSet.has(from) || !holderSet.has(to)) continue;
      if (from === to) continue;

      const key = [from, to].sort().join(":");
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += transfer.tokenAmount ?? 0;
        existing.txCount += 1;
      } else {
        edgeMap.set(key, {
          source: from, target: to,
          weight: transfer.tokenAmount ?? 0,
          txCount: 1,
        });
      }
      // Union wallets that transact with each other
      uf.union(from, to);
    }
  }

  const edges = [...edgeMap.values()];

  // Build clusters (only groups of 2+)
  const rawClusters = uf.getClusters();
  let clusterIndex = 0;
  const clusters: InsiderCluster[] = [];
  const nodeMap = new Map(nodes.map(n => [n.address, n]));

  for (const [, members] of rawClusters) {
    if (members.length < 2) continue;
    const totalPct = members.reduce((sum, addr) => {
      const node = nodeMap.get(addr);
      return sum + (node?.pctSupply ?? 0);
    }, 0);
    clusterIndex++;
    clusters.push({
      wallets: members,
      totalPct: Math.round(totalPct * 100) / 100,
      label: `Insider Group ${clusterIndex}`,
    });
    // Label nodes in clusters
    for (const addr of members) {
      const node = nodeMap.get(addr);
      if (node) node.label = `Cluster ${clusterIndex}`;
    }
  }

  const insiderPct = clusters.reduce((sum, c) => sum + c.totalPct, 0);

  const result: InsiderGraphResult = {
    nodes,
    edges,
    clusters: clusters.sort((a, b) => b.totalPct - a.totalPct),
    stats: {
      totalHolders: holders.length,
      analyzedWallets: topHolders.length,
      clusterCount: clusters.length,
      insiderPct: Math.round(insiderPct * 100) / 100,
    },
    cachedAt: Date.now(),
  };

  // Cache result
  if (redis) {
    try {
      await redis.set(`${deploymentNamespace()}${GRAPH_CACHE_PREFIX}${mint}`, result, { ex: GRAPH_CACHE_TTL });
    } catch { /* non-critical */ }
  }

  return result;
}
