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
  }

export interface HistoryEntry {
  ca: string;
  symbol: string;
  risk: string;
  score: number;
  ts: number;
}
