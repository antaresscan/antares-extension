// __tests__/replay/manifest.ts
//
// The replay corpus: real tokens whose UPSTREAM responses (DexScreener, RugCheck, GoPlus, Helius, GeckoTerminal) were
// recorded from a real scan, so that the real /api/scan engine can be run on them again and again, offline, on exactly
// the same data. See scripts/replay/README.md for how to refresh a recording.
//
//   expected   the verdicts a human accepts for this token, judged on the data at capture time. NOT what the engine says:
//              a token the engine gets wrong is a `knownIssue` (see below), not a re-labelled token.
//   why        one line of justification, on facts that do not depend on the engine (age, liquidity, holders, history).
//   knownIssue the engine gets it wrong today. The replay reports it without failing, and FAILS the day it is fixed (so the
//              marker is removed with the fix). `id` is the audit item (M5, M6, M7, M8...).
//
// HORNY (a seed entry) is left out: its market is gone, there is nothing left to scan.
//
// Labels come from three places: the hand-vetted seed corpus of the old backtest (removed; same token and same verdicts),
// established tokens whose false DANGER verdicts the audit documented, and tokens whose liquidity was removed (an objective
// criterion: DexScreener liquidity under 500 $ on a pair older than 6 hours).

export type Verdict = "SAFE" | "CAUTION" | "DANGER" | "RUG";

export interface ReplayToken {
  symbol: string;
  mint: string;
  expected: Verdict[];
  why: string;
  knownIssue?: { id: string; note: string };
  /** Liquidity removed or abandoned: most sources have nothing to say, only DexScreener is required at capture time. */
  dead?: boolean;
}

export const REPLAY_TOKENS: ReplayToken[] = [
  // ── Established memecoins (hand-vetted seed corpus) ─────────────────────
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", expected: ["SAFE", "CAUTION"], why: "Largest Solana memecoin by holder count, multi-year history, both authorities renounced." },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", expected: ["SAFE", "CAUTION"], why: "dogwifhat: top-3 Solana memecoin by market cap, 18+ months of trading, LP burned." },
  { symbol: "PENGU", mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", expected: ["SAFE"], why: "Pudgy Penguins: backed by an established NFT brand, multi-million market cap." },
  { symbol: "POPCAT", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", expected: ["SAFE", "CAUTION"], why: "Top-tier Solana memecoin, multi-month history, deep liquidity." },
  { symbol: "MEW", mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", expected: ["SAFE", "CAUTION"], why: "Cat in a dogs world: established memecoin, millions in liquidity.", knownIssue: { id: "concentration", note: "One wallet holds 36.8 % and the top 10 hold 65.2 %; the engine reads that as critical high concentration and returns DANGER 525 on a 928-day-old token with $9.7M of liquidity and a burned LP." } },
  // GOAT and PNUT: the addresses in the old backtest's seed corpus were WRONG (no market on DexScreener); these are the real mints.
  { symbol: "GOAT", mint: "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump", expected: ["SAFE", "CAUTION"], why: "Goatseus Maximus: AI-narrative memecoin, $1.6M of liquidity, about 2 years of trading." },
  { symbol: "PNUT", mint: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump", expected: ["SAFE", "CAUTION"], why: "Peanut the Squirrel: viral-launch memecoin, $3.4M of liquidity, about 2 years of trading.", knownIssue: { id: "concentration", note: "The top 10 hold 68.1 %; critical high concentration, DANGER 525, on a token about 2 years old with $3.4M of liquidity and a burned LP." } },
  { symbol: "FARTCOIN", mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", expected: ["CAUTION"], why: "Established memecoin, 1B+ market cap, but one wallet holds about 11 %: concentration is concentration.", knownIssue: { id: "concentration-top1", note: "One wallet holds 10.4 % (top 10: 35 %): the hand-vetted label caps an established token at CAUTION for that; the engine returns SAFE 1000." } },
  { symbol: "NEET", mint: "Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump", expected: ["CAUTION", "SAFE"], why: "29k holders, $1.9M liquidity, 532 days old, top wallet 5.8 % and top 10 19 %; the LP is not burned (unverified): CAUTION or SAFE are both defensible." },
  { symbol: "TROLL", mint: "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2", expected: ["CAUTION", "SAFE"], why: "70k holders, $3.0M liquidity, 538 days old, top wallet 5.3 % and top 10 30 %; the LP is not burned. It used to be CAUTION because RugCheck and GoPlus were often silent: all five sources answer now." },
  { symbol: "FWOG", mint: "A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump", expected: ["SAFE", "CAUTION"], why: "Established 30 d+, LP burned, well distributed: a genuine SAFE memecoin profile." },
  { symbol: "ACT", mint: "GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump", expected: ["CAUTION", "SAFE", "DANGER"], why: "Act I AI Prophecy: AI-narrative memecoin, established market cap. Borderline: any of the three is defensible." },
  { symbol: "GIGA", mint: "63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9", expected: ["SAFE", "CAUTION"], why: "Gigachad: 84k holders, $16M+ market cap, LP burned, 800 d+ old, top wallet about 12 %." },
  { symbol: "PIPPIN", mint: "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump", expected: ["DANGER"], why: "One wallet about 27 %, top 10 about 67 %: stacked concentration.", knownIssue: { id: "concentration-top1", note: "One wallet holds 26.6 % and the top 10 hold 61 %: hand-vetted DANGER (stacked concentration); the engine returns CAUTION 900 with only an 'elevated' warning." } },
  { symbol: "TRUMP", mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", expected: ["CAUTION", "SAFE", "DANGER"], why: "Stabilised after its launch pump, hundreds of millions in market cap, 465 d old. Borderline." },
  { symbol: "HAWK", mint: "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump", expected: ["RUG", "DANGER"], why: "Hawk Tuah: one of the best-documented rugs of Solana memecoins (one wallet 44 %, coordinated dump)." },
  { symbol: "USELESS", mint: "HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4", expected: ["SAFE", "CAUTION"], why: "Matured into a legitimate memecoin: 51k holders, LP burned, 30 d+, clean contract." },

  // ── Established non-meme tokens (the audit documented false DANGER verdicts on them) ──
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", expected: ["SAFE", "CAUTION"], why: "Jupiter: the Solana DEX aggregator token, 800k+ holders, multi-year history.", knownIssue: { id: "concentration", note: "One wallet holds 24.8 % and the top 10 hold 66.2 % (team, DAO and vesting wallets); critical high concentration, DANGER 763 on a 983-day-old token with 830k holders and $1.2B of market cap." } },
  { symbol: "RENDER", mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", expected: ["CAUTION", "DANGER"], why: "Established, but mint AND freeze authority are active and GoPlus does not list it as trusted: critical by the 2026-10-10 decision." },
  { symbol: "HNT", mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", expected: ["SAFE", "CAUTION"], why: "Helium: established network token, 500k+ holders; its mint authority is the protocol's and GoPlus lists it as trusted." },
  { symbol: "WBTC", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", expected: ["SAFE", "CAUTION"], why: "Wormhole-wrapped Bitcoin: 120k+ holders, years of history.", knownIssue: { id: "concentration", note: "The top 10 hold 69.5 % (bridge custody): a critical flag, DANGER 525, on a token with 127k holders. (The 'No website / Twitter / Telegram' critical it also carried is gone: M7.)" } },
  { symbol: "WSOL", mint: "So11111111111111111111111111111111111111112", expected: ["SAFE", "CAUTION"], why: "Wrapped SOL: the native asset's token, millions of holders." },
  { symbol: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", expected: ["SAFE", "CAUTION"], why: "Jito governance token: established DAO token, many holders (its top-20 list used to collapse the holder count to 20)." },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", expected: ["SAFE", "CAUTION"], why: "Raydium: the AMM's token, years of history, hundreds of thousands of holders.", knownIssue: { id: "concentration", note: "The top 10 hold 77 % (protocol treasury wallets); critical high concentration, DANGER 525 on a years-old AMM token with 266k holders." } },
  { symbol: "PYUSD", mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", expected: ["CAUTION", "DANGER"], why: "Regulated stablecoin, but Token-2022 with issuer-controlled permanent delegate, transfer fee and hook: never a SAFE profile for a memecoin scanner, never a RUG." },

  // ── Tokens whose liquidity was removed or abandoned (objective: liquidity under 500 $ on a pair older than 6 h) ──
  { symbol: "BREAK", mint: "ThJsrUYige56LCtKbsZSUxx1HFyX1gMjfZTV8xppump", dead: true, expected: ["RUG", "DANGER"], why: "Pump.fun token, liquidity gone, 53 holders left of 173 token accounts ever created." },
  { symbol: "PAPER", mint: "GesEHJvkMwsaNKKVPowAhDD7P8XooDKtpswTQQ3Fpump", dead: true, expected: ["RUG", "DANGER"], why: "Pump.fun Token-2022 token, liquidity gone, 37 holders left of 427 accounts ever created." },
  { symbol: "HqNtPF3w", mint: "HqNtPF3wAKz5DyFPeaJL7FBgqnv1Wmk3AUuHKWLqjupx", dead: true, expected: ["RUG", "DANGER"], why: "Pump.fun token, liquidity at $0, about 70 holders left of 266 accounts ever created." },
  { symbol: "PEPE-dead", mint: "7cXnBxmP61vAKZLTukHJbnyYRmbFTaWiYHX1sMAupump", dead: true, expected: ["RUG", "DANGER"], why: "Migrated pump.fun token, $11 of liquidity left on a 136 h old pair, fully diluted value $144." },
  { symbol: "SNKRZ", mint: "GjgKTqtzDei5E3uZyA2CN29KQgugF564K1hoc1jHpump", dead: true, expected: ["RUG", "DANGER"], why: "Pump.fun token abandoned for 13,000 hours: no liquidity." },
  { symbol: "CLIFF", mint: "8r91bsFzz2DKCZyaAqx3Ko5NS8PTwHV4FNeEWEB8pump", dead: true, expected: ["RUG", "DANGER"], why: "Pump.fun token abandoned for 1,200 hours: no liquidity." },
];
