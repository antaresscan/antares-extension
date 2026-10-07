// api/_lib/geckoterminal.ts — GeckoTerminal as the stand-in for DexScreener's market data.
//
// DexScreener's public API is the engine's only source of market data, and the only
// thing that turns the address dexscreener.com puts in its URLs (a PAIR address, not a
// token) into the token behind it. On 2026-10-07 it answered {"pairs": null} for every
// token, USDC and SOL included, and every scan of a dexscreener.com page then scored
// the pool's own address as if it were a token: "Very few holders (<15)", DANGER.
// GeckoTerminal kept answering, with the same pools at the same addresses (a pool has
// one address on every site), and the scan already calls it for candles.
//
// Used only when DexScreener gave nothing. The shapes below were checked on real
// answers (SNDWITCH, USDC; __tests__/fixtures/geckoterminal.json).
//
//   GET /networks/solana/pools/{pool}?include=base_token,quote_token
//       the pool, with both tokens' name and symbol; 404 when the address is not a pool
//   GET /networks/solana/tokens/{mint}/pools?include=base_token,quote_token
//       up to 20 pools of the token (as base or as quote); 404 when it is not a token

import { fetchJson } from "./helpers";
import type { DexScreenerPair } from "./types";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2/networks/solana";
const GECKO_HEADERS = { Accept: "application/json;version=20230302" };
const INCLUDE = "include=base_token,quote_token";
const ID_PREFIX = "solana_";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
/** "solana_<mint>" -> "<mint>" */
const mintOf = (id: unknown): string | undefined => {
  const s = str(id);
  return s && s.startsWith(ID_PREFIX) ? s.slice(ID_PREFIX.length) : undefined;
};

interface TokenInfo { address?: string; name?: string; symbol?: string; imageUrl?: string }

function tokenIndex(included: unknown): Map<string, TokenInfo> {
  const index = new Map<string, TokenInfo>();
  if (!Array.isArray(included)) return index;
  for (const item of included) {
    if (!isRecord(item) || item.type !== "token" || !isRecord(item.attributes)) continue;
    const id = mintOf(item.id);
    if (!id) continue;
    const a = item.attributes;
    index.set(id, { address: str(a.address) ?? id, name: str(a.name), symbol: str(a.symbol), imageUrl: str(a.image_url) });
  }
  return index;
}

/**
 * One GeckoTerminal pool as the DexScreener pair the rest of the engine reads. The
 * token of the pair is the pool's BASE token, as on DexScreener. A pool where the
 * token is only the quote (USDC against hundreds of other tokens) is not a market for
 * it: its liquidity and price changes describe the other token.
 */
export function geckoPoolToPair(pool: unknown, tokens: Map<string, TokenInfo>): DexScreenerPair | null {
  if (!isRecord(pool) || !isRecord(pool.attributes) || !isRecord(pool.relationships)) return null;
  const a = pool.attributes;
  const rel = pool.relationships;
  const baseMint = isRecord(rel.base_token) && isRecord(rel.base_token.data) ? mintOf(rel.base_token.data.id) : undefined;
  const quoteMint = isRecord(rel.quote_token) && isRecord(rel.quote_token.data) ? mintOf(rel.quote_token.data.id) : undefined;
  const pairAddress = str(a.address);
  if (!baseMint || !pairAddress) return null;

  const base = tokens.get(baseMint);
  const quote = quoteMint ? tokens.get(quoteMint) : undefined;
  const change = isRecord(a.price_change_percentage) ? a.price_change_percentage : {};
  const volume = isRecord(a.volume_usd) ? a.volume_usd : {};
  const txns = isRecord(a.transactions) && isRecord(a.transactions.m5) ? a.transactions.m5 : {};
  const createdAt = typeof a.pool_created_at === "string" ? Date.parse(a.pool_created_at) : NaN;
  const dex = isRecord(rel.dex) && isRecord(rel.dex.data) ? str(rel.dex.data.id) : undefined;
  // "SNDWITCH / SOL" when the included tokens are missing
  const symbolFromName = typeof a.name === "string" ? a.name.split(" / ")[0].trim() || undefined : undefined;

  return {
    pairAddress,
    dexId: dex,
    baseToken: { address: baseMint, symbol: base?.symbol ?? symbolFromName, name: base?.name },
    quoteToken: quoteMint ? { address: quoteMint, symbol: quote?.symbol, name: quote?.name } : undefined,
    liquidity: { usd: num(a.reserve_in_usd) },
    volume: { h24: num(volume.h24), h1: num(volume.h1) },
    priceChange: { m5: num(change.m5), h1: num(change.h1), h6: num(change.h6), h24: num(change.h24) },
    txns: { m5: { buys: num(txns.buys), sells: num(txns.sells) } },
    priceUsd: str(a.base_token_price_usd),
    marketCap: num(a.market_cap_usd),
    fdv: num(a.fdv_usd),
    pairCreatedAt: Number.isFinite(createdAt) ? createdAt : undefined,
    // No socials or website: GeckoTerminal does not carry DexScreener's profile.
    info: base?.imageUrl ? { imageUrl: base.imageUrl } : undefined,
  };
}

/** Pools of a token that are a market for it (it is their base), the most liquid first. */
function pairsOfToken(doc: unknown, mint: string): DexScreenerPair[] {
  if (!isRecord(doc) || !Array.isArray(doc.data)) return [];
  const tokens = tokenIndex(doc.included);
  const pairs: DexScreenerPair[] = [];
  for (const pool of doc.data) {
    const pair = geckoPoolToPair(pool, tokens);
    if (pair?.baseToken?.address === mint) pairs.push(pair);
  }
  return pairs.sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0));
}

export interface GeckoMarket {
  /** The market the scan reads: the pool asked for, else the token's most liquid pool. */
  pair: DexScreenerPair;
  /** Every pool of the token found, the one above included (the scan uses their addresses to tell liquidity vaults from holders). */
  pairs: DexScreenerPair[];
  /** The token behind the address. */
  baseMint: string;
}

/**
 * The market of `address`, a pool address (what dexscreener.com shows) or a token mint.
 * null when GeckoTerminal does not know it, is rate-limited, or answers with something else.
 */
export async function geckoLookup(address: string, timeoutMs = 5000): Promise<GeckoMarket | null> {
  const get = (path: string) => fetchJson<unknown>(`${GECKO_BASE}/${path}?${INCLUDE}`, { headers: GECKO_HEADERS }, timeoutMs, 0);

  // A pool address and a mint cannot both answer, so ask both at once.
  const [poolDoc, tokenDoc] = await Promise.all([get(`pools/${address}`), get(`tokens/${address}/pools`)]);

  if (isRecord(poolDoc) && isRecord(poolDoc.data)) {
    const pair = geckoPoolToPair(poolDoc.data, tokenIndex(poolDoc.included));
    const baseMint = pair?.baseToken?.address;
    if (pair && baseMint) {
      // The token's other pools, best effort: they are what the holder analysis needs
      // to recognise liquidity vaults. The pool asked for stays first.
      const others = pairsOfToken(await get(`tokens/${baseMint}/pools`), baseMint).filter((p) => p.pairAddress !== pair.pairAddress);
      return { pair, pairs: [pair, ...others], baseMint };
    }
    return null;
  }

  const pairs = pairsOfToken(tokenDoc, address);
  return pairs.length > 0 ? { pair: pairs[0], pairs, baseMint: address } : null;
}
