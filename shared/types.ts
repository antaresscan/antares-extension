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
  /** What a RUG verdict means: "confirmed" (an event happened to the token) or "risk" (its structure only). Absent on an older cached scan. */
  rugKind?: string | null;
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
  /** The answer was born from data that was not there. */
  degraded?: boolean;
  /** Seconds the answer may be reused without asking again (server-decided). */
  freshForSec?: number;
  /** Seconds the answer may still be shown, marked as old, if the scanner cannot be reached (server-decided). */
  staleLeftSec?: number;
  /** A data source that almost always answers did not, for a SAFE or CAUTION: the overlay says so and counts down to the next try (server-decided, Free included). */
  sourceGap?: boolean;
  /** The kind of issuer's asset (stable, tokenized, lst...), null for any other token: its Mint / Freeze / LP Lock cells are a dash, not crosses. */
  issuerKind?: string | null;
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

/**
 * Sent by the content script to the service worker each time the overlay
 * shows a verdict, so the worker can set the toolbar badge, raise a
 * risk-escalation notification and record the scan in the local history.
 * Plain data only: the worker never re-fetches the scan (the content script
 * already did, with the session headers).
 */
export interface ScanResultMessage {
  type: "SCAN_RESULT";
  ca: string;
  risk: string;
  score: number;
  symbol: string;
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
