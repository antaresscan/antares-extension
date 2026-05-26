import type { DexScreenerPair } from "./types";

// Pairs quoted against a stable asset (USD-pegged stablecoins or major
// store-of-value coins) reflect real USD price movement in their
// priceChange.h24 field. Pairs quoted against a volatile memecoin
// (PUMP, BONK, WIF, …) instead report the ratio swing between the two
// tokens, which looks like an absurd pump/dump in USD terms even when
// the scanned token only moved a few percent.
//
// 2026-05-26 Fartcoin incident: DexScreener returned 30 pairs for
// FARTCOIN; a FARTCOIN/PUMP pool on Orca had the highest USD liquidity
// of all of them ($42M) and priceChange.h24 = +466,736%. The previous
// "highest liquidity wins" selection picked it, the layer-1 rule
// `pc24 > 5000` triggered, and Fartcoin (a $175M-mcap blue-chip) got
// flagged RUG PULL while the user was looking at the FARTCOIN/USDC
// chart showing -5%.
//
// This whitelist must stay narrow. Any quote token added here is a
// claim that its USD price is stable enough that priceChange.h24 in
// pairs quoted against it tracks the base token's real USD movement.
// Adding a volatile asset re-opens the incident.
const STABLE_QUOTE_SYMBOLS = new Set([
  "USDC", "USDT", "USDS", "USD1", "FDUSD", "PYUSD", "DAI",
  "SOL", "WSOL", "BTC", "WBTC", "ETH", "WETH",
]);

/**
 * Pick the representative pair from a token's full pair list.
 *
 * Filters to stable-quoted pairs first (so the picked pair's
 * priceChange reflects real USD movement), then takes the highest USD
 * liquidity among those. Falls back to the full pair list only when
 * the token has no stable-quoted pool at all — rare, mostly seen on
 * fresh pump.fun bonds before graduation.
 */
export function selectBestPair(
  pairs: DexScreenerPair[] | null | undefined,
): DexScreenerPair | null {
  if (!pairs || pairs.length === 0) return null;
  if (pairs.length === 1) return pairs[0] ?? null;

  const stablePairs = pairs.filter((p) => {
    const sym = (p?.quoteToken?.symbol ?? "").toUpperCase();
    return STABLE_QUOTE_SYMBOLS.has(sym);
  });
  const candidates = stablePairs.length > 0 ? stablePairs : pairs;
  const first = candidates[0];
  if (!first) return null;

  return candidates.reduce<DexScreenerPair>(
    (best, p) => ((p?.liquidity?.usd ?? 0) > (best?.liquidity?.usd ?? 0) ? p : best),
    first,
  );
}
