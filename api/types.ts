// ─── ANTARES — STRICT TYPE DEFINITIONS ───────────────────────────────────────
// All external API shapes are typed here. Zero `any` in api/scan.ts.

// ─── DEXSCREENER ─────────────────────────────────────────────────────────────
export interface DexScreenerLiquidity {
  usd:    number | null;
  base?:  number | null;
  quote?: number | null;
}

export interface DexScreenerTxns {
  buys:  number;
  sells: number;
}

export interface DexScreenerTxnsWindows {
  m5?:  DexScreenerTxns;
  h1?:  DexScreenerTxns;
  h6?:  DexScreenerTxns;
  h24?: DexScreenerTxns;
}

export interface DexScreenerPriceChange {
  m5?:  number;
  h1?:  number;
  h6?:  number;
  h24?: number;
}

export interface DexScreenerToken {
  address: string;
  name:    string;
  symbol:  string;
}

export interface DexScreenerSocial {
  type?: string;
  url?:  string;
}

export interface DexScreenerInfo {
  imageUrl?:  string | null;
  socials?:   DexScreenerSocial[];
  websites?:  { url: string }[];
}

export interface DexScreenerPair {
  chainId:        string;
  dexId:          string;
  pairAddress:    string;
  baseToken:      DexScreenerToken;
  quoteToken:     DexScreenerToken;
  priceUsd?:      string | null;
  priceNative?:   string | null;
  liquidity?:     DexScreenerLiquidity;
  volume?:        { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?:   DexScreenerPriceChange;
  txns?:          DexScreenerTxnsWindows;
  marketCap?:     number | null;
  fdv?:           number | null;
  pairCreatedAt?: number | null;
  info?:          DexScreenerInfo;
}

export interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
  pair?:  DexScreenerPair  | null;
}

// ─── RUGCHECK ─────────────────────────────────────────────────────────────────
export interface RugCheckTopHolders {
  top1Percentage?:       number;
  top1HolderPercentage?: number;
  top10Percentage?:      number;
}

export interface RugCheckRisk {
  name:   string;
  score:  number;
  level?: string;
}

export interface RugCheckSummary {
  lpBurned?:               boolean;
  lpLocked?:               boolean;
  lpLockDurationDays?:     number;
  lpLockDuration?:         number;
  lockDurationDays?:       number;
  metaMutable?:            boolean;
  mintAuthorityEnabled?:   boolean;
  freezeAuthorityEnabled?: boolean;
  topHolders?:             RugCheckTopHolders;
  risks?:                  RugCheckRisk[];
  error?:                  string;
  message?:                string;
}

export interface RugCheckReport extends RugCheckSummary {
  totalHolders?: number;
}

// ─── GOPLUS ───────────────────────────────────────────────────────────────────
export interface GoPlusResult {
  is_honeypot?:              string | number | boolean;
  cannot_sell_all?:          string | number | boolean;
  mint_authority?:           string | number | boolean | null;
  freeze_authority?:         string | number | boolean | null;
  is_blacklisted?:           string | number | boolean;
  transfer_pausable?:        string | number | boolean;
  hidden_owner?:             string | number | boolean;
  is_proxy?:                 string | number | boolean;
  sell_tax?:                 string | number;
  buy_tax?:                  string | number;
  owner_percent?:            string | number;
  creator_percent?:          string | number;
  is_mintable?:              string | number | boolean;
  slippage_modifiable?:      string | number | boolean;
  is_anti_whale_modifiable?: string | number | boolean;
  trading_cooldown?:         string | number | boolean;
  is_whitelisted?:           string | number | boolean;
}

export interface GoPlusResponse {
  result?: Record<string, GoPlusResult>;
}

// ─── HELIUS ───────────────────────────────────────────────────────────────────
export interface HeliusAccount {
  address:  string;
  uiAmount: number;
}

export interface HeliusSupplyValue {
  uiAmount:       number;
  amount:         string;
  decimals:       number;
  uiAmountString: string;
}

export interface HeliusSupply {
  result?: { value?: HeliusSupplyValue };
}

export interface HeliusLargestAccounts {
  result?: { value?: HeliusAccount[] };
}

// ─── SOLSCAN ──────────────────────────────────────────────────────────────────
export interface SolscanMeta {
  data?: {
    icon?:         string | null;
    creator?:      string | null;
    decimals?:     number | null;
    supply?:       string | null;
    created_time?: number | null;
  };
}

export interface SolscanMarketPool {
  liquidity?: number | string | null;
  volume?:    number | string | null;
  trade?:     number | string | null;
  trader?:    number | string | null;
}

export interface SolscanMarket {
  data?: SolscanMarketPool[];
}

export interface SolscanTransferItem {
  from_address?: string;
  to_address?:   string;
  from?:         string;
  to?:           string;
}

export interface SolscanTransfer {
  data?: SolscanTransferItem[];
}

// ─── GECKOTERMINAL ────────────────────────────────────────────────────────────
export interface OHLCVCandle {
  o:  number;
  h:  number;
  l:  number;
  c:  number;
  v:  number;
  ts: number;
}

// ─── INTERNAL SCORING ─────────────────────────────────────────────────────────
export type Severity = "critical" | "warning" | "info" | "bonus";

export interface ScanFlag {
  label:    string;
  severity: Severity;
  impact:   number;
}

export type SafeBlockedReason =
  | "age" | "holders" | "mint" | "freeze" | "honeypot"
  | "copycat" | "rug_pattern" | "wash_trading" | "pump"
  | "bundle" | "sniper" | "chart";

export interface LayerResult {
  source:      string;
  trust:       number;
  available:   boolean;
  flags:       ScanFlag[];
  forceRug:    boolean;
  safeBlocked: boolean;
}

export type LayerWeights = Record<
  "dexscreener" | "rugcheck" | "goplus" | "helius" | "solscan" | "chart",
  number
>;

export interface ScanResponse {
  score:                number;
  risk:                 "SAFE" | "CAUTION" | "DANGER" | "RUG";
  flags:                ScanFlag[];
  pair:                 DexScreenerPair | null;
  resolvedMint:         string;
  confidence:           number;
  sources_used:         string[];
  holders:              number | null;
  marketCap:            number | null;
  priceUsd:             number | null;
  liquidity:            number | null;
  volume24h:            number | null;
  volume1h:             number | null;
  priceChange5m:        number | null;
  priceChange1h:        number | null;
  priceChange24h:       number | null;
  tokenSymbol:          string | null;
  tokenName:            string | null;
  pairCreatedAt:        number | null;
  safeBlocked:          boolean;
  safeBlockedReasons:   SafeBlockedReason[];
  tokenLogo:            string | null;
  tokenCreator:         string | null;
  tokenDecimals:        number | null;
  tokenSupply:          string | null;
  recentTransfers:      SolscanTransferItem[];
  solscanTokenAgeHours: number | null;
  solscanVolume24h:     number | null;
  solscanTrades24h:     number | null;
  solscanTraders24h:    number | null;
  layers:               Record<string, { trust: number; available: boolean }>;
  scoring_version:      string;
  fetchedAt:            number;
}
