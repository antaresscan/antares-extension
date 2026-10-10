// __tests__/replay/bulk.ts
//
// The BULK part of the replay corpus: hundreds of real tokens (bulk.json) next to the hand-vetted ones (manifest.ts).
//
// What a bulk token carries is a WEAK label, not a verdict a human vetted. bulk.json comes from the auto-labelled discovery
// corpus of the old backtest, removed (labels built on DexScreener signals only: market cap, liquidity, age, 24 h change), so it says
// "this token looked like X from the outside". It is therefore never asserted token by token. What the bulk is for is:
//   1. the golden file of every token (an unintended change of any verdict, score or flag fails and is listed by token);
//   2. two aggregate counts that must not get worse (bulk-baseline.json): tokens that looked dumped and are called SAFE
//      (a rug waved through), and tokens that looked overwhelmingly safe and are called DANGER/RUG (a false alarm).
import type { Verdict } from "./manifest";

export interface BulkToken { mint: string; symbol: string; weak: Verdict }

/** The corpus is cut in this many shards, one test file each, so that the files run in parallel workers. */
export const SHARDS = 8;

export function parseBulk(json: string): BulkToken[] {
  return (JSON.parse(json) as Array<[string, string, Verdict]>).map(([mint, symbol, weak]) => ({ mint, symbol, weak }));
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
};

/** Which shard (test file) replays this token. Hash-based, so adding a token never moves another one. */
export const shardOf = (mint: string): number => fnv1a(mint) % SHARDS;

/** About one token in ten runs in every `npm test`; the whole bulk runs when REPLAY_FULL=1 (the dedicated CI job). */
export const inSample = (mint: string): boolean => Math.floor(fnv1a(mint) / SHARDS) % 10 === 0;
