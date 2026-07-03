// ─── ANTARES TYPE DEFINITIONS ─────────────────────────────────────────────────────────────
// Centralised types for all API layers, scoring engine, and scan results.

// ─── SEVERITY & FLAGS ─────────────────────────────────────────────────────────────────
export type Severity = "critical" | "warning" | "info" | "bonus";

// Flag class separates two fundamentally different kinds of signal:
//  • "structural" — definitive rug vectors (honeypot, LP pullable, mint/freeze
//    authority, deceptive name, blacklist/pausable). High precision: a single
//    one justifies condemning the token.
//  • "behavioral" — statistical / price / volume signals (wash, pumps, sniper,
//    weak socials). Noisy and probabilistic: one alone must NOT force the harsh
//    verdicts — it feeds the score and needs corroboration (≥2) for DANGER.
// Default is "structural" so any flag not explicitly reclassified keeps its
// legacy hard-floor behaviour.
export type FlagClass = "structural" | "behavioral";

export interface ScanFlag {
  label: string;
  severity: Severity;
  impact: number;
  flagClass?: FlagClass;
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
  // `base` = actual reserve of the queried token (baseToken) sitting in the
  // pool, in token units. DexScreener computes this from real on-chain
  // reserves, so it's accurate for concentrated-liquidity pools (CLMM/DLMM)
  // where the naive 50/50-by-USD assumption breaks down. Prefer it over the
  // derived estimate in computeLpPctOfSupply whenever present.
  liquidity?: { usd?: number; base?: number; quote?: number };
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
  lpBurned?: boolean | null;
  lpLocked?: boolean | null;
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
    dex?: Array<{ burn_percent?: number; dex_name?: string; lp_amount?: string | null; tvl?: string | number; type?: string }>;
    // GoPlus exposes the actual on-chain holder count — they index this
    // themselves and it matches what DexScreener / Solscan show. Free
    // endpoint, already in the response we fetch for honeypot detection.
    holder_count?: string | number;
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
  /**
   * Critical flags that are STRUCTURAL rug vectors (honeypot, LP pullable,
   * mint/freeze authority, deceptive name, …). Any ≥1 forces at-least-DANGER.
   * Back-compat: when undefined, determineVerdict falls back to criticalFlagsCount
   * (i.e. treats every critical flag as structural — the legacy behaviour).
   */
  structuralCriticalCount?: number;
  /**
   * Critical flags that are BEHAVIORAL / statistical (wash, pump, sniper, weak
   * socials). One alone must not condemn; ≥2 (corroboration) forces DANGER. A
   * single behavioral critical falls through to the score-driven bands.
   */
  behavioralCriticalCount?: number;
  /**
   * True when the security-critical structural fields (mint authority, freeze
   * authority, honeypot, LP burn/lock status) were actually resolved by an
   * upstream source. SAFE requires this — missing data caps the verdict at
   * CAUTION so "no data → no flags → SAFE" can never happen. Back-compat:
   * undefined is treated as complete (does not block SAFE).
   */
  structuralDataComplete?: boolean;
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
  // Holder concentration — computed from Helius getTokenLargestAccounts
  // (top 20 holders) divided by total supply. Exposed so the frontend can
  // render the concentration bar without regex-extracting from flag labels.
  topHolderPct?: number | null;
  top10HolderPct?: number | null;
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
