export interface ScanResponseFlag {
  label: string;
  severity: string;
  impact: number;
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
  recentTransfers?: unknown[];
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
