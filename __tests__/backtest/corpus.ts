// __tests__/backtest/corpus.ts
//
// The Antares scoring corpus. Memecoin-focused — Antares is a
// Solana memecoin scanner, so the corpus reflects what users
// actually scan: pump.fun launches, established memecoins, known
// rugs. DAO / DEX tokens (JTO, RAY, USDC, etc.) are out of scope
// for the primary corpus; they get isolated coverage where their
// edge-case behaviour matters but they don't drive the scoring.
//
// Each entry:
//   ca:               Solana mint address
//   symbol:           ticker (informational, used in test output)
//   expectedVerdict:  what the scoring engine MUST return
//   expectedScore:    optional [min, max] inclusive band the score
//                     should land in. Used to catch silent drift even
//                     when the verdict band is correct.
//   tolerated:        optional alternative verdicts that won't fail
//                     the test but will print a warning. Used for
//                     borderline tokens that legitimately float
//                     between two bands depending on market state.
//   why:              one-line justification for the label.
//   source:           how the label was established. "live" = scanned
//                     live and the verdict was vetted; "external" =
//                     ground truth from off-chain knowledge.
//   skipFixture:      mark when /api/scan currently 504s on this
//                     token's large dataset — captured separately.
//
// Adding a token:
//   1. Add the entry below with the expected verdict + a why
//   2. npm run corpus:capture <SYMBOL> (writes the fixture)
//   3. npm run test:corpus (verifies)

import type { Verdict } from "../../api/_lib/types"
import { DISCOVERED } from "./corpus-discovered"

export interface CorpusEntry {
  ca: string
  symbol: string
  expectedVerdict: Verdict
  expectedScore?: [number, number]
  tolerated?: Verdict[]
  why: string
  source: "live" | "external"
  skipFixture?: boolean
}

// Hand-vetted memecoin entries with tight score bands. These are the
// spine of the corpus — every change to scoring should preserve or
// improve their match rate. They were picked manually to cover each
// verdict band with known-good representatives.
export const SEED_CORPUS: CorpusEntry[] = [
  // ─── BLUE-CHIP MEMECOINS — top mcap, multi-month history ──────────
  // Established Solana memecoins traders consider "safer" within the
  // memecoin asset class. The engine should not flag them DANGER.
  {
    ca: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "BONK",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [780, 1000],
    why: "BONK. Largest Solana memecoin by holder count. Multi-year history.",
    source: "live",
  },
  {
    ca: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    symbol: "WIF",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [800, 1000],
    why: "dogwifhat. Top-3 Solana memecoin by mcap, 18 months trading history.",
    source: "live",
  },
  {
    ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    symbol: "PENGU",
    expectedVerdict: "SAFE",
    expectedScore: [800, 1000],
    why: "Pudgy Penguins. Backed by established NFT brand, multi-million mcap.",
    source: "live",
  },
  {
    ca: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    symbol: "POPCAT",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [750, 1000],
    why: "Popcat. Top-tier Solana memecoin, multi-month history, deep liquidity.",
    source: "live",
  },
  {
    ca: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
    symbol: "MEW",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [750, 1000],
    why: "Cat in a dogs world. Established memecoin, $9M+ liquidity.",
    source: "live",
    skipFixture: true, // pending recapture after forceRug fix deploy (PR #...)
  },
  {
    ca: "7tGwuFAyV3xQjYGdGDwXzxegx419WgE4WwtEbJq9x1Es",
    symbol: "GOAT",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [750, 1000],
    why: "Goatseus Maximus. AI-narrative memecoin, deep liquidity, established trading.",
    source: "live",
    skipFixture: true, // pending recapture after forceRug fix deploy
  },
  {
    ca: "Dn3DFUNDKEyMJGrEsuzTiYrfEwtPo86iH5qTKzbbtiag",
    symbol: "PNUT",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [750, 1000],
    why: "Peanut the Squirrel. Viral-launch memecoin, large liquidity pool.",
    source: "live",
    skipFixture: true, // pending recapture after forceRug fix deploy
  },

  // ─── ESTABLISHED MID-CAP MEMECOINS — typically CAUTION ────────────
  // Mature trading history but missing one or more SAFE prerequisites
  // (LP not formally locked, mild concentration, etc.). Should land
  // in CAUTION — not DANGER (false positive) and not SAFE (the risk
  // is real even if not extreme).
  {
    ca: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    symbol: "FARTCOIN",
    expectedVerdict: "CAUTION",
    expectedScore: [700, 850],
    why: "Established memecoin, 1B+ mcap, BUT single wallet holds ~11% — concentration is concentration regardless of how blue-chip the rest looks. CAUTION is the right band.",
    source: "live",
  },
  {
    ca: "Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump",
    symbol: "NEET",
    expectedVerdict: "CAUTION",
    expectedScore: [700, 900],
    why: "10k+ holders, $1.3M liq, 30d+ established, LP not burned. Mature lp_unverified path.",
    source: "live",
  },
  {
    ca: "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2",
    symbol: "TROLL",
    expectedVerdict: "CAUTION",
    expectedScore: [700, 900],
    why: "Established memecoin, $1.5M liq. RugCheck/GoPlus often unavailable. Mature LP-unverified soft path.",
    source: "live",
  },
  {
    ca: "A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump",
    symbol: "FWOG",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [800, 1000],
    why: "Established 30d+, LP burned, well distributed. Genuine SAFE memecoin profile.",
    source: "live",
  },
  {
    ca: "GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump",
    symbol: "ACT",
    expectedVerdict: "CAUTION",
    tolerated: ["SAFE", "DANGER"],
    expectedScore: [400, 950],
    why: "Act I AI Prophecy. AI-narrative memecoin, established mcap. Borderline.",
    source: "live",
    skipFixture: true, // pending recapture after forceRug fix deploy
  },
  {
    ca: "63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9",
    symbol: "GIGA",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [800, 1000],
    why: "Gigachad. 84k holders, $16M+ mcap, LP burned, 800d+ age, top1 12% (well-distributed for mcap level).",
    source: "live",
  },

  // ─── DANGER — concentration / structural risk ─────────────────────
  // Memecoins where the engine should surface DANGER, not CAUTION
  // (would miss the risk) and not RUG (the rest of the profile is
  // clean enough that "absolute kill" isn't warranted).
  {
    ca: "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump",
    symbol: "PIPPIN",
    expectedVerdict: "DANGER",
    expectedScore: [350, 700],
    why: "Single wallet 27%, top10 67%. Stacked concentration triggers hard concentration block.",
    source: "live",
  },
  {
    ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    symbol: "TRUMP",
    expectedVerdict: "CAUTION",
    tolerated: ["SAFE", "DANGER"],
    expectedScore: [400, 950],
    why: "Stabilised post-pump (~$574M mcap, $42M liq, 465d age). Was originally labelled RUG when coordinated dump bottomed out near zero — token has since recovered as a real established memecoin.",
    source: "live",
  },

  // ─── CONFIRMED RUGS — must surface DANGER or RUG ──────────────────
  // The hardest-cost failure mode: rugs slipping past as SAFE/CAUTION
  // would damage user trust the most. We accept either DANGER or RUG.
  {
    ca: "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump",
    symbol: "HAWK",
    expectedVerdict: "RUG",
    expectedScore: [0, 350],
    why: "Hawk Tuah. One of the most well-documented rugs in Solana memecoin history — single wallet 44%, post-launch coordinated dump, ~70k liquidity. The verdict MUST be RUG, not DANGER.",
    source: "live",
  },
  {
    ca: "69HZnSz3XDHyTeBrrsn5NFbjpiryhHbYJZUGDx3QXH69",
    symbol: "HORNY",
    expectedVerdict: "DANGER",
    tolerated: ["RUG"],
    expectedScore: [0, 600],
    why: "20 holders, $48K liquidity, no LP confirmation. Fresh-launch rug profile.",
    source: "live",
  },

  // ─── USELESS — confirmed rug-then-mature ──────────────────────────
  // Originally labelled RUG; the project actually matured to a real
  // memecoin (51k holders, LP burned). Engine correctly upgrades it.
  // Kept in the corpus as a "label-evolution test case" — proves the
  // corpus encodes reality, not priors.
  {
    ca: "HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4",
    symbol: "USELESS",
    expectedVerdict: "SAFE",
    tolerated: ["CAUTION"],
    expectedScore: [800, 1000],
    why: "Matured into legit memecoin: 51k holders, LP burned, 30d+, clean contract.",
    source: "live",
  },
]

// ─── MERGED CORPUS ───────────────────────────────────────────────────
// The full corpus is SEED_CORPUS (hand-vetted spine) + DISCOVERED
// (auto-labelled wave from scripts/corpus-discover.ts), deduped by
// mint address. When the same token appears in both lists the
// hand-vetted SEED_CORPUS entry WINS — its expectedVerdict +
// tolerated were chosen with the engine's on-chain signal in mind,
// while DISCOVERED uses only external metrics that can't see
// concentration / LP burn / honeypot. Without this dedup, GIGA
// (SEED says SAFE, DISCOVERED auto-labels CAUTION) would be tested
// twice with conflicting labels and one would always fail.
//
// To grow the corpus: run `npm run corpus:discover` to refresh the
// DISCOVERED list, then `npm run corpus:capture` to fetch fixtures
// for any new entries. The accuracy backtest surfaces divergences.
const _seedMints = new Set(SEED_CORPUS.map(e => e.ca))
export const CORPUS: CorpusEntry[] = [
  ...SEED_CORPUS,
  ...DISCOVERED.filter(e => !_seedMints.has(e.ca)),
]

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * Returns true if the actual verdict is acceptable for the corpus
 * entry. The expectedVerdict always passes; tolerated alternatives
 * pass with a warning.
 */
export function isVerdictAcceptable(
  entry: CorpusEntry,
  actual: Verdict,
): { ok: boolean; warning: boolean } {
  if (actual === entry.expectedVerdict) return { ok: true, warning: false }
  if (entry.tolerated?.includes(actual)) return { ok: true, warning: true }
  return { ok: false, warning: false }
}

/**
 * Returns true if the actual score falls within the expected band.
 * Entries without an expectedScore range always pass this check.
 */
export function isScoreInRange(entry: CorpusEntry, actual: number): boolean {
  if (!entry.expectedScore) return true
  const [min, max] = entry.expectedScore
  return actual >= min && actual <= max
}

export function corpusByVerdict(verdict: Verdict): CorpusEntry[] {
  return CORPUS.filter(e => e.expectedVerdict === verdict)
}
