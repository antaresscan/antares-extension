// api/_lib/insider-graph.ts — Insider Network Graph builder
// Analyzes top holder wallets to detect coordinated clusters
import { fetchJson } from "./helpers";
import { HELIUS_BASE, HELIUS_REST_BASE } from "./constants";
import type { Redis } from "@upstash/redis";

// ─── CONSTANTS (imported from constants.ts where possible) ─────────────────
const MAX_HOLDERS = 20;           // top N holders to analyze
const MAX_SIGNATURES = 30;        // signatures per wallet to fetch
const GRAPH_CACHE_TTL = 300;      // 5 minutes cache
const GRAPH_CACHE_PREFIX = "graph:";

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
    const res = await fetchJson(HELIUS_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [wallet, { limit: MAX_SIGNATURES }],
      }),
    }, 5000);
    const sigs = (res as { result?: HeliusSignature[] })?.result ?? [];
    return sigs.map(s => s.signature);
  } catch {
    return [];
  }
}

async function parseTransactions(
  signatures: string[], apiKey: string
): Promise<HeliusParsedTx[]> {
  if (!signatures.length) return [];
  try {
    const res = await fetchJson(`${HELIUS_REST_BASE}/v0/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
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
      const cached = await redis.get<InsiderGraphResult>(`${GRAPH_CACHE_PREFIX}${mint}`);
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

  // Fetch transaction signatures for each top holder (parallel, limited)
  const walletAddresses = topHolders.map(h => h.address);
  const sigResults = await Promise.all(
    walletAddresses.map(w => getWalletSignatures(w, apiKey))
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
      await redis.set(`${GRAPH_CACHE_PREFIX}${mint}`, result, { ex: GRAPH_CACHE_TTL });
    } catch { /* non-critical */ }
  }

  return result;
}
