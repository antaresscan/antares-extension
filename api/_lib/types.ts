// ─── ANTARES TYPE DEFINITIONS ─────────────────────────────────────────────────────────────
// Centralised types for all API layers, scoring engine, and scan results.

// ─── SEVERITY & FLAGS ─────────────────────────────────────────────────────────────────
export type Severity = "critical" | "warning" | "info" | "bonus";

export interface ScanFlag {
  label: string;
  severity: Severity;
  impact: number;
}

// IMPORTANT: 'lp' and 'deceptive_name' are HARD reasons — they can never
// be soft-unlocked by applySafeGateOverride. A token with LP not burned
// can ALWAYS pull liquidity and rug. A deceptive name is always intentional fraud.
export type SafeBlockedReason =
  | "age"             // soft — can unlock after 48h+ with other conditions
  | "holders"         // soft — can unlock with enough holders
  | "lp"              // HARD — LP not burned/locked, dev can rug at any time
  | "mint"            // HARD
  | "freeze"          // HARD
  | "honeypot"        // HARD
  | "copycat"         // HARD
  | "deceptive_name" // HARD — impersonating real institution
  | "rug_pattern"     // HARD
  | "wash_trading"    // HARD
  | "pump"            // HARD
  | "bundle"          // HARD
  | "sniper"          // HARD
    | "chart"            // HARD
  | "low_holders"     // HARD — tokens with <50 holders
  | "lp_unverified"; // SOFT - LP not burned but token is mature and clean

// ─── LAYER RESULT ────────────────────────────────────────────────────────────────────
export interface LayerResult {
  source: string;
  trust: number;
  available: boolean;
  flags: ScanFlag[];
  forceRug: boolean;
  safeBlocked: boolean;
}

export type Verdict = "SAFE" | "CAUTION" | "DANGER" | "RUG";

// ─── DEXSCREENER ─────────────────────────────────────────────────────────────────────────
export interface DexScreenerSocial {
  type?: string;
  url?: string;
}

export interface DexScreenerPair {
  pairAddress?: string;
  baseToken?: {
    address?: string;
    symbol?: string;
    name?: string;
  };
  liquidity?: { usd?: number };
  volume?: { h24?: number; h1?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
  };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  info?: {
    socials?: DexScreenerSocial[];
    websites?: Array<{ url?: string }>;
    imageUrl?: string;
  };
}

export interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
  pair?: DexScreenerPair;
}

// ─── RUGCHECK ───────────────────────────────────────────────────────────────────────────────
export interface RugCheckRisk {
  name?: string;
  score?: number;
  description?: string;
}

export interface RugCheckTopHolders {
  top1Percentage?: number;
  top1HolderPercentage?: number;
  top10Percentage?: number;
}

export interface RugCheckSummary {
  lpBurned?: boolean;
  lpLocked?: boolean;
  lpLockDurationDays?: number;
  lpLockDuration?: number;
  lockDurationDays?: number;
  metaMutable?: boolean;
  topHolders?: RugCheckTopHolders;
  mintAuthorityEnabled?: boolean;
  freezeAuthorityEnabled?: boolean;
  risks?: RugCheckRisk[];
  error?: string;
  message?: string;
}

export interface RugCheckReport {
  risks?: RugCheckRisk[];
  topHolders?: RugCheckTopHolders;
  totalHolders?: number;
}

// ─── GOPLUS ────────────────────────────────────────────────────────────────────────────────────
export interface GoPlusTokenResult {
  is_honeypot?: string | number | boolean;
  cannot_sell_all?: string | number | boolean;
  mint_authority?: string;
  freeze_authority?: string;
  is_blacklisted?: string | number | boolean;
  transfer_pausable?: string | number | boolean;
  hidden_owner?: string | number | boolean;
  is_proxy?: string | number | boolean;
  sell_tax?: string | number;
  buy_tax?: string | number;
  owner_percent?: string | number;
  creator_percent?: string | number;
  is_mintable?: string | number | boolean;
  slippage_modifiable?: string | number | boolean;
  is_anti_whale_modifiable?: string | number | boolean;
  trading_cooldown?: string | number | boolean;
  is_whitelisted?: string | number | boolean;
}

export interface GoPlusResponse {
  result?: Record<string, GoPlusTokenResult>;
}

// ─── HELIUS ────────────────────────────────────────────────────────────────────────────────────
export interface HeliusHolder {
  address: string;
  owner: string;
  uiAmount: number;
}

export interface HeliusLargestAccountsResponse {
  result?: {
    value?: HeliusHolder[];
  };
}

export interface HeliusSupplyResponse {
  result?: {
    value?: {
      uiAmount?: number;
    };
  };
}

export interface HeliusTokenAccountsResponse {
  result?: {
    total?: number;
  };
  total?: number;
}

// ─── SOLSCAN ───────────────────────────────────────────────────────────────────────────────────
export interface SolscanTransfer {
  from_address?: string;
  from?: string;
  to_address?: string;
  to?: string;
  amount?: number;
  block_time?: number;
}

export interface SolscanMeta {
  data?: {
    created_time?: number;
    icon?: string;
    creator?: string;
    decimals?: number;
    supply?: number;
  };
}

export interface SolscanMarketPool {
  liquidity?: number;
  volume?: number;
  trade?: number;
  trader?: number;
}

export interface SolscanMarketsResponse {
  data?: SolscanMarketPool[];
}

export interface SolscanTransfersResponse {
  data?: SolscanTransfer[];
}

// ─── GECKO TERMINAL ──────────────────────────────────────────────────────────────────────
export interface OHLCVCandle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface GeckoTerminalOHLCVResponse {
  data?: {
    attributes?: {
      ohlcv_list?: Array<Array<number>>;
    };
  };
}

// ─── PIPELINE INPUT/OUTPUT TYPES ─────────────────────────────────────────────────────────────────
export interface PostLayerFlagsInput {
  buys5m: number;
  sells5m: number;
  liqUsd: number;
  ageMin: number;
  recentTransfers: SolscanTransfer[];
  creatorReputation: { priorTokens: number; flagged: boolean; reason: string | null } | null;
  volLiqRatio: number;
}

export interface PostLayerFlagsResult {
  flags: ScanFlag[];
  forceRug: boolean;
  safeBlocked: boolean;
}

export interface SafeGateInput {
  safeBlocked: boolean;
  safeBlockedReasons: SafeBlockedReason[];
  forceRug: boolean;
  holders: number | null;
  lpBurned: boolean;
  goPlusClean: boolean;
  tokenAgeHours: number | null;
  sourcesAvailableCount: number;
}

export interface EstablishedBonusInput {
  score: number;
  tokenAgeHours: number | null;
  holders: number | null;
  lpBurned: boolean;
  goPlusClean: boolean;
}

export interface VerdictInput {
  score: number;
  forceRug: boolean;
  safeBlocked: boolean;
  safeBlockedReasons?: string[];
  sourcesUsedCount: number;
}

// ─── SCAN RESULT ────────────────────────────────────────────────────────────────────────────────
export interface LayerSnapshot {
  trust: number;
  available: boolean;
}

export interface ScanResult {
  score: number;
  risk: Verdict;
  flags: ScanFlag[];
  pair: DexScreenerPair | null;
  resolvedMint: string;
  confidence: number;
  sources_used: string[];
  holders: number | null;
  marketCap: number | null;
  priceUsd: number | null;
  liquidity: number | null;
  volume24h: number | null;
  volume1h: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  tokenSymbol: string | null;
  tokenName: string | null;
  pairCreatedAt: number | null;
  safeBlocked: boolean;
  safeBlockedReasons: SafeBlockedReason[];
  tokenLogo: string | null;
  tokenCreator: string | null;
  tokenDecimals: number | null;
  tokenSupply: number | null;
  recentTransfers: SolscanTransfer[];
  solscanTokenAgeHours: number | null;
  solscanVolume24h: number | null;
  solscanTrades24h: number | null;
  solscanTraders24h: number | null;
  layers: Record<string, LayerSnapshot>;
  scoring_version: string;
  fetchedAt: number;
  honeypot?: boolean;
  mintAuthority?: boolean;
  freezeAuthority?: boolean;
  requestId: string;
      lpBurned?: boolean | null;
  candles?: Array<{ close: number }>;
  aiSummary?: string | null;
    lpLocked?: boolean | null;
  lpLockedPct?: number | null;
  lpLockDurationDays?: number | null;
}
