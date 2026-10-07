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
  | "concentration"        // HARD — top 10 hold ≥75% of supply → DANGER/RUG (7.7.4+)
  | "concentration_light"  // SOFT-BLOCK — top 10 hold 60-74% → max CAUTION, never SAFE (7.7.4+)
  // Legacy name kept for cached scans pre-7.7.4. Behaves like concentration_light.
  | "concentration_warning"
  | "lp_unverified"  // SOFT - LP not burned but token is mature and clean
  | "pump_imbalance"; // SOFT - buy/sell imbalance (coordinated pump signal), unlockable for established tokens

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
  dexId?: string;
  baseToken?: {
    address?: string;
    symbol?: string;
    name?: string;
  };
  quoteToken?: {
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
// The public report summary, GET /v1/tokens/{mint}/report/summary, about 300
// bytes. A real answer (BONK):
//   {"tokenProgram":"Tokenkeg...","tokenType":"","risks":[{"name":"Mutable metadata",
//    "value":"","description":"Token metadata can be changed by the owner",
//    "score":100,"level":"warn"}],"score":101,"score_normalised":7,"lpLockedPct":15.27}
// It has no holder list, no authority fields and no LP burn booleans; those are
// only in the full report (up to 2.5 MB), which the engine no longer downloads.
export interface RugCheckRisk {
  name?: string;
  /** A figure as text ("36.77%", "$2410.49"), empty when the risk has none. */
  value?: string;
  description?: string;
  score?: number;
  /** "danger" or "warn" so far. */
  level?: string;
}

export interface RugCheckSummary {
  tokenProgram?: string;
  tokenType?: string;
  risks?: RugCheckRisk[];
  score?: number;
  score_normalised?: number;
  /** Share of the LP tokens locked or burned, 0 to 100. */
  lpLockedPct?: number;
  error?: string;
  message?: string;
}

// ─── GOPLUS ────────────────────────────────────────────────────────────────────────────────────
// What GoPlus really sends for a Solana token (see api/_lib/goplus.ts). The
// fields of its EVM answer (is_honeypot, mint_authority, sell_tax...) are not in
// it. The Token-2022 fields are typed loosely on purpose: a field of an
// unexpected shape must not make the whole answer unreadable.
export interface GoPlusTokenResult {
  /** { status: "1" } when the mint authority is still held. */
  mintable?: unknown;
  freezable?: unknown;
  /** Token-2022 permanent delegate: its holder can move or burn any balance. */
  balance_mutable_authority?: unknown;
  /** "2" when new token accounts are frozen by default. */
  default_account_state?: string | number;
  /** "1" for a soulbound token: it cannot be transferred, so not sold. */
  non_transferable?: string | number;
  transfer_fee?: unknown;
  transfer_fee_upgradable?: unknown;
  transfer_hook?: unknown;
  transfer_hook_upgradable?: unknown;
  dex?: Array<{ burn_percent?: number | null; dex_name?: string; lp_amount?: string | null; tvl?: string | number; type?: string }>;
  // GoPlus exposes the actual on-chain holder count — they index this
  // themselves and it matches what DexScreener / Solscan show.
  holder_count?: string | number;
  // The Solana answer lists the top holders (2 to 10) with their balance, and
  // the total supply as a UI amount.
  holders?: GoPlusHolder[];
  total_supply?: string | number;
}

/** One entry of GoPlus's top-holders list. `percent` is a fraction ("0.4398"). */
export interface GoPlusHolder {
  account?: string;
  token_account?: string;
  balance?: string | number;
  percent?: string | number;
  tag?: string;
  is_locked?: number;
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
  lpBurned: boolean | null;
  goPlusClean: boolean;
  tokenAgeHours: number | null;
  sourcesAvailableCount: number;
  // Optional. When present, the safe gate consults the
  // known-treasuries allowlist as a data-quality fallback for Path 3.
  // Tokens like JTO (whose holder count can collapse to 20 when
  // upstream sources are simultaneously degraded) get the blue-chip
  // exemption based on mint identity instead of inferred metrics.
  mint?: string | null;
}

export interface EstablishedBonusInput {
  score: number;
  tokenAgeHours: number | null;
  holders: number | null;
  lpBurned: boolean | null;
  goPlusClean: boolean;
}

export interface VerdictInput {
  score: number;
  forceRug: boolean;
  safeBlocked: boolean;
  safeBlockedReasons?: string[];
  sourcesUsedCount: number;
  /**
   * Number of token-side warning + critical flags visible to the user
   * (i.e. emitted by any layer with severity ∈ {warning, critical}).
   * Used by determineVerdict to grant a SAFE verdict at a relaxed score
   * floor (750+) when there are literally zero token-side issues — fixes
   * the "no issues found but verdict is CAUTION" UX contradiction caused
   * by infrastructure-side score drag (Helius unavailable, etc).
   * Optional for back-compat — undefined falls back to legacy 900+ rule.
   */
  warningFlagsCount?: number;
  /** Number of critical-severity token-side flags (pipeline-status flags excluded). */
  criticalFlagsCount?: number;
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
  // null: the source did not answer, so the clients show a dash, never a check mark.
  honeypot?: boolean | null;
  mintAuthority?: boolean | null;
  freezeAuthority?: boolean | null;
  requestId: string;
  lpBurned?: boolean | null;
  candles?: Array<{ close: number }>;
  aiSummary?: string | null;
  /**
   * Where the summary came from: "gemini", "fallback" (the template, because a Gemini
   * call failed, was skipped or ran out of time) or "local" (the template, because no
   * key is set). null when there is no summary.
   */
  aiSummarySource?: "gemini" | "fallback" | "local" | null;
      lpLocked?: boolean | null;
  lpLockedPct?: number | null;
  lpLockDurationDays?: number | null;
  // Holder concentration — computed from Helius getTokenLargestAccounts
  // (top 20 holders) divided by total supply. Exposed so the frontend can
  // render the concentration bar without regex-extracting from flag labels.
  topHolderPct?: number | null;
  top10HolderPct?: number | null;
  // Where the holder list behind those two figures came from: Helius, or GoPlus
  // when Helius returned nothing. Null when neither had a list.
  holdersSource?: "helius" | "goplus" | null;
  // V5 Critical Actors preview — composed from creatorReputation + filtered
  // top holders + (optional) insider-graph cluster detection. Each card
  // describes one structural risk vector (Dev / Insider / Cluster).
  criticalActors?: CriticalActor[];
  // V5 Verdict Timeline — last N scan snapshots persisted in Redis ZSET
  // `vh:{ca}`. Oldest first; the most recent is the current scan.
  verdictHistory?: VerdictHistoryEntry[];
  // V5 Holder Activity — derived from recentTransfers (last 60min window
  // per top holder). Composed at scan-time, not persisted.
  holderActivity?: HolderActivityPayload;
  // V5 Outcome Stats — Time-to-Rug ring + Outcome Histogram payload.
  // Heuristic profile-match v1; corpus-based KNN matcher is the
  // backend follow-up (J3-J5 backtest harness).
  outcomeStats?: OutcomeStatsPayload | null;
}

export interface OutcomeSimilarTokenEntry {
  symbol: string;
  ruggedAfterHours: number;
  loss: number;
}

export interface OutcomeStatsPayload {
  timeToRugMedianDisp: string;
  timeToRugMedianHours: number;
  timeToRugSampleSize: number;
  pctRugged24h: number;
  pctSlowDeath: number;
  pctAlive30d: number;
  distribution: number[];
  youBucketIndex: number;
  mostSimilar: OutcomeSimilarTokenEntry[];
}

export interface HolderActivityRow {
  role: "dev" | "bot" | "coord" | "real" | "whale-big";
  label: "Holding" | "Selling" | "Buying" | "Splitting" | "Static" | "Reducing";
  avatar: string;
  pctChange: number;
  pctChangeDisp: string;
  addr: string;
  desc: string;
}

export interface HolderActivityPayload {
  rows: HolderActivityRow[];
  netFlowPct: number;
  netFlowDirection: "in" | "out" | "flat";
}

export interface VerdictHistoryEntry {
  ts: number;
  verdict: Verdict;
  score: number;
  event: string;
}

// ─── V5 CRITICAL ACTORS ────────────────────────────────────────────────
export type CriticalActorType = "dev" | "insider" | "cluster";
export interface CriticalActor {
  type: CriticalActorType;
  tag: string;
  pct: number;
  addr: string;
  repLbl: string;
  repWidth: number;
  repWarn: boolean;
  desc: string;
}
