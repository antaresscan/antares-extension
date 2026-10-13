// scripts/issuer-assets/build.mjs
//
// Builds api/_lib/issuer-assets.data.ts: the mints of two kinds of token whose structure is an issuer's, by design.
//
//   stable      stablecoins (USDC, USDT, PYUSD, EURC, USDG...): the issuer holds the mint and freeze authorities and most of the supply.
//   tokenized   tokenized stocks and other real-world assets (xStocks, Ondo Global Markets, PreStocks, tokenized gold...): same structure,
//               plus pause / permanent delegate / default-frozen extensions.
//   lst         liquid staking tokens (JitoSOL, mSOL, JupSOL...): the stake pool holds the mint authority and most of the supply.
//   wrapped     wrapped major assets (wrapped BTC and ETH: Portal's WBTC and ETH, OKX's xBTC, Lombard's LBTC, Coinbase's cbBTC...): the bridge or the
//               custodian holds the mint (and often freeze) authority and most of the supply.
//   yield       yield-bearing dollar tokens (USDY, syrupUSDC, eUSX, ONyc, PST, PRIME...): same issuer structure as a stablecoin, but the
//               price RISES above $1 with the yield it accrues, so a distance to $1 above is no depeg.
//   vault       Jupiter's own share tokens: JLP (the Jupiter Perps liquidity pool) and the Jupiter Lend receipts (jlUSDC, jlUSDT, jlWSOL, jlEURC...).
//               The protocol mints a share on deposit and burns it on withdrawal: it holds the mint authority and the supply, and holders redeem
//               with the protocol, not in a DEX pool (jlUSDC is worth $497M and its pools hold $47).
//
// Source: Jupiter's curated "verified" token list (https://lite-api.jup.ag/tokens/v2/tag?query=verified), read by its tags. The list is
// third-party, vetted by Jupiter; it is READ HERE, ONCE, and the result is committed: the scan never calls Jupiter. A mint is only ever
// recognised by ADDRESS (never by name or symbol: a look-alike scam has the right name and the wrong address).
//
//   node scripts/issuer-assets/build.mjs [--from verified.json]     (without --from the list is downloaded, 5 MB)
//
// What is left out on purpose, whatever the other tags: anything tagged meme / launchpad (a meme coin named GOLD or STOCK carries the words,
// not the structure), deprecated / duplicate / internal. (The tag "moonshot-verified" is NOT a reason: USDC, USDT and PYUSD carry it.) A token is
// in one kind only (stable wins).
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const OUT = path.resolve("api/_lib/issuer-assets.data.ts");

const STABLE_TAGS = ["stable"];
const TOKENIZED_TAGS = ["rwa", "stocks", "xstocks", "ondo", "prestocks", "equities", "commodities", "pre-ipo"];
const LST_TAGS = ["lst"];
// Wrapped majors: Jupiter's own `major` tag (a short, curated list: SOL itself, ETH, WBTC, xBTC, LBTC, zenBTC...), plus the ones it does not tag
// `major` and that were checked by hand against their issuer (the address must be in the verified list, or the build stops):
const WRAPPED_TAGS = ["major"];
const WRAPPED_EXTRA = [
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", // cbBTC, Coinbase Wrapped BTC
  "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU", // tBTC, Threshold Bitcoin
];
// Wrapped SOL itself carries the lst tag in some lists: it is the asset the LSTs are priced in, not one of them.
// Vault shares: Jupiter's `jup-lend-earn` tag (the Jupiter Lend receipts), plus JLP. A Lend receipt is also tagged `yb`: the vault wins.
const VAULT_TAGS = ["jup-lend-earn"];
const VAULT_EXTRA = [
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", // JLP, Jupiter Perps liquidity pool share (tags defi / strict, no issuer tag)
];
// Yield-bearing dollar tokens: Jupiter's `yb` (yield-bearing) tag, what is left once the vault shares are taken out.
const YIELD_TAGS = ["yb"];
const NEVER = new Set(["So11111111111111111111111111111111111111112"]);
const EXCLUDED_TAGS = ["meme", "launchpad", "deprecated", "duplicate", "internal"];

async function load() {
  if (fromIdx >= 0) return JSON.parse(fs.readFileSync(args[fromIdx + 1], "utf8"));
  const r = await fetch("https://lite-api.jup.ag/tokens/v2/tag?query=verified", { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Jupiter answered ${r.status}`);
  return r.json();
}

const list = await load();
if (!Array.isArray(list) || list.length < 1000) throw new Error(`unexpected list (${Array.isArray(list) ? list.length : typeof list} entries)`);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const has = (t, names) => (t.tags ?? []).some((x) => names.includes(x));

const stable = [], tokenized = [], lst = [], wrapped = [], yieldTokens = [], vault = [];
for (const t of list) {
  if (!BASE58.test(t.id ?? "") || NEVER.has(t.id) || !has(t, ["verified"]) || has(t, EXCLUDED_TAGS)) continue;
  if (has(t, STABLE_TAGS)) stable.push(t.id);
  else if (has(t, TOKENIZED_TAGS)) tokenized.push(t.id);
  else if (has(t, LST_TAGS)) lst.push(t.id);
  else if (has(t, WRAPPED_TAGS) || WRAPPED_EXTRA.includes(t.id)) wrapped.push(t.id);
  else if (has(t, VAULT_TAGS) || VAULT_EXTRA.includes(t.id)) vault.push(t.id);
  else if (has(t, YIELD_TAGS)) yieldTokens.push(t.id);
}
for (const m of WRAPPED_EXTRA) if (!wrapped.includes(m)) throw new Error(`${m} (checked by hand) is no longer a verified token of the list, or is now in another kind`);
for (const m of VAULT_EXTRA) if (!vault.includes(m)) throw new Error(`${m} (checked by hand) is no longer a verified token of the list, or is now in another kind`);
const uniq = (a) => [...new Set(a)].sort();
const S = uniq(stable), K = uniq(tokenized), L = uniq(lst), W = uniq(wrapped), Y = uniq(yieldTokens), V = uniq(vault);
if (S.length < 10 || K.length < 100 || L.length < 50 || W.length < 5 || Y.length < 5 || V.length < 5) throw new Error(`suspiciously small result: ${S.length} stable, ${K.length} tokenized, ${L.length} lst, ${W.length} wrapped, ${Y.length} yield, ${V.length} vault`);

const chunk = (a) => a.map((m) => `  "${m}",`).join("\n");
fs.writeFileSync(OUT, `// api/_lib/issuer-assets.data.ts — GENERATED by scripts/issuer-assets/build.mjs, do not edit by hand.
//
// Source: Jupiter's verified token list, read by tags on ${new Date().toISOString().slice(0, 10)} (${list.length} verified tokens).
// ${S.length} stablecoins, ${K.length} tokenized real-world assets (stocks, ETFs, gold...), ${L.length} liquid staking tokens, ${W.length} wrapped major assets,
// ${Y.length} yield-bearing dollar tokens and ${V.length} Jupiter vault shares, by mint ADDRESS.
// To refresh: node scripts/issuer-assets/build.mjs, then review the diff of this file.

/** Stablecoins: the issuer holds the mint and freeze authorities and most of the supply by design. */
export const STABLE_MINTS: readonly string[] = [
${chunk(S)}
];

/** Tokenized stocks and other real-world assets: the same, plus pause / permanent delegate / default-frozen extensions. */
export const TOKENIZED_MINTS: readonly string[] = [
${chunk(K)}
];

/** Liquid staking tokens (JitoSOL, mSOL, JupSOL...): the stake pool holds the mint authority and most of the supply by design. */
export const LST_MINTS: readonly string[] = [
${chunk(L)}
];

/** Wrapped major assets (wrapped BTC and ETH): the bridge or the custodian holds the mint authority and most of the supply by design. */
export const WRAPPED_MINTS: readonly string[] = [
${chunk(W)}
];

/** Yield-bearing dollar tokens (USDY, syrupUSDC, ONyc...): the issuer holds the mint authority and the supply; the price rises above $1 with the yield. */
export const YIELD_MINTS: readonly string[] = [
${chunk(Y)}
];

/** Jupiter's share tokens (JLP, the Jupiter Lend receipts jlUSDC / jlWSOL...): the protocol mints a share on deposit and burns it on withdrawal, so it holds the mint authority and the supply; holders redeem with the protocol, not in a pool. */
export const VAULT_MINTS: readonly string[] = [
${chunk(V)}
];
`);
console.log(`wrote ${OUT}: ${S.length} stable, ${K.length} tokenized, ${L.length} lst, ${W.length} wrapped, ${Y.length} yield, ${V.length} vault (from ${list.length} verified tokens)`);
