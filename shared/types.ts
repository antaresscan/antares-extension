export interface ScanResponseFlag {
  label: string;
  severity: string;
  impact: number;
}

// Daily quota state surfaced via X-Antares-Quota-* response headers.
// Attached client-side to ScanResponseData so the overlay can render
// "47/50 today" without a second round-trip.
export interface QuotaStatus {
  // "yearly" is the new paid tier (replaces "lifetime" for new buyers as
  // of 2026-05). "lifetime" stays in the union for grandfathered
  // customers who paid before the rename.
  tier: "free" | "pro" | "yearly" | "lifetime";
  /** Scans consumed today (UTC). */
  used: number;
  /** Daily ceiling. -1 for unlimited (all tiers post-2026-05). */
  limit: number;
  /** Scans still available. -1 for unlimited. */
  remaining: number;
  /** Epoch-ms of next 00:00 UTC. 0 for unlimited tiers. */
  resetAt: number;
}


export interface Transfer {
  from_address?: string;
  to_address?: string;
  from?: string;
}
export interface ScanResponseData {
  score: number;
  risk: string;
  flags: ScanResponseFlag[];
  pair?: {
    baseToken?: { symbol?: string; name?: string; address?: string };
    liquidity?: { usd?: number };
    url?: string;
  } | null;
  resolvedMint?: string;
  confidence?: number;
  sources_used?: string[];
  holders?: number | null;
  marketCap?: number | null;
  priceUsd?: number | null;
  priceChange1h?: number | null;
  liquidity?: number | null;
  tokenSymbol?: string | null;
  tokenName?: string | null;
  mintAuthority?: boolean | null;
  freezeAuthority?: boolean | null;
  lpBurned?: boolean | null;
  lpLocked?: boolean | null;
      lpLockedPct?: number | null;
    lpLockDurationDays?: number | null;
  honeypot?: boolean | null;
  safeBlocked?: boolean;
  candles?: Array<{ close: number }>;
    // Additional fields returned by API
  volume24h?: number | null;
  volume1h?: number | null;
  priceChange5m?: number | null;
  priceChange24h?: number | null;
  pairCreatedAt?: number | null;
  safeBlockedReasons?: string[];
  tokenLogo?: string | null;
  tokenCreator?: string | null;
  tokenDecimals?: number | null;
  tokenSupply?: number | null;
  solscanTokenAgeHours?: number | null;
  solscanVolume24h?: number | null;
  solscanTrades24h?: number | null;
  solscanTraders24h?: number | null;
  layers?: Record<string, { trust: number; available: boolean }>;
  scoring_version?: string;
  fetchedAt?: number;
    recentTransfers?: Transfer[];
    aiSummary?: string | null;
    topHolderPct?: number | null;
    top10HolderPct?: number | null;
    /**
     * Client-side metadata: extracted from X-Antares-Quota-* response
     * headers in scanner.ts. Optional — older API responses without
     * quota headers and locally-cached results pre-quota launch will
     * be undefined, in which case the overlay simply hides the badge.
     */
    _quota?: QuotaStatus;
  }

export interface HistoryEntry {
  ca: string;
  symbol: string;
  risk: string;
  score: number;
  ts: number;
}

  // Insider Graph types
export interface InsiderGraphNode {
  address: string;
  ownership: number;
  label?: string;
  isInsider: boolean;
  cluster?: string;
}

export interface InsiderGraphEdge {
  from: string;
  to: string;
  amount: number;
  timestamp?: number;
}

export interface InsiderGraphData {
  nodes: InsiderGraphNode[];
  edges: InsiderGraphEdge[];
  insiderPercent: number;
  clusterCount: number;
  riskLevel: "low" | "medium" | "high" | "critical";
}
