# Antares — Regression corpus

Antares is a Solana memecoin scanner. The verdict it returns (SAFE /
CAUTION / DANGER / RUG) affects trading decisions, so the repository keeps a
corpus of real Solana tokens and checks stored scan results against it.

**This is a regression harness. It is not a measure of the engine's accuracy,
and this page does not claim one.**

## Numbers (2026-10-07)

```
Entries in the corpus         : 1,493  (18 picked by hand, 1,475 found automatically)
With a captured response      :   504  (the other 989 are marked skipFixture: not captured yet)
Stored verdict inside its set :   504 / 504  (130 exactly as labelled, 374 tolerated)
```

Verdict stored in the fixture, by corpus label:

```
                    RUG  DANGER  CAUTION  SAFE
labelled RUG         62       0        0     0
labelled DANGER     164       7        0     0
labelled CAUTION    134      44       51     0
labelled SAFE         9       6       17    10
```

How to read this:

- **504 / 504 is close to true by construction.** The tolerated verdicts are
  fixed by label: CAUTION tolerates DANGER and RUG, DANGER tolerates RUG (and
  often CAUTION), RUG tolerates DANGER, and SAFE tolerates CAUTION, DANGER and
  RUG. A blue-chip labelled SAFE and stored as RUG is "acceptable". Of the 42
  entries labelled SAFE, 10 are stored as SAFE, 17 as CAUTION, 6 as DANGER and 9
  as RUG.
- **The fixtures are not today's engine.** Each is a response captured at some
  date, by the engine and with the data sources of that day. Many were captured
  while Helius (holders) returned nothing and GoPlus could not be parsed, which
  probably explains why 164 of the 171 entries labelled DANGER are stored as
  RUG. They need recapturing (`npm run corpus:refresh`, about 100 minutes, one
  fresh production scan per entry) before the matrix says anything about the
  current engine.
- **Most labels are not an investigation.** The automatically found entries are
  labelled from DexScreener signals only (market cap, liquidity, age, 24h
  price change): "SAFE only when overwhelming, RUG only on textbook dumps,
  CAUTION by default" (`scripts/corpus-discover.ts`).
- **Mints are not independently verified.** A check against DexScreener on
  2026-10-07 found 454 of the 1,495 distinct mints with no trading pair (mostly
  dead pump.fun tokens, but also assets that do not trade on a DEX) and three
  hand-picked entries (GOAT, PNUT, USELESS) pointing at the wrong token. The
  three are fixed.

## What's in the corpus

- **18 hand-vetted seed entries** — well-known Solana memecoins covering
  every verdict band (BONK, WIF, MEW, HAWK, HORNY, …) with tight score
  bands. These are the spine — they protect the engine from regression
  on the canonical names.
- **About 1,475 auto-discovered entries** — pulled from 6 sources, deduped,
  enriched, labelled with conservative external-signal rules:
  - DexScreener `/token-boosts/top` (paid promo, often shitcoins)
  - DexScreener `/token-boosts/latest` (fresh launches)
  - DexScreener `/token-profiles/latest` (recent profiles)
  - CoinGecko 6 meme categories paginated (solana-meme-coins ×4 pages,
    meme-token, dog-/cat-/frog-/ai-themed) — each entry's Solana mint
    resolved via `/coins/<id>.platforms.solana` to avoid symbol
    collisions with scam tokens stealing legit tickers.
  - GeckoTerminal `/networks/solana/pools` (top 100 pages by liquidity).
  - Jupiter `lite-api.jup.ag/tokens/v2/tag?query=verified` — verified
    Solana token list (~4,800 tokens) filtered by mcap >= $100k,
    excluding stablecoins/wrapped majors. Adds the mid-cap Solana
    layer that DexScreener / GeckoTerminal under-cover.

Every entry carries the mint address its source gave it. It is not verified
independently (see the numbers above).

## How a single test runs

For each corpus entry:

1. The capture script (`scripts/corpus-capture.ts`) hits the deployed
   `/api/scan?ca=<mint>&fresh=1` endpoint — that's the **same engine
   path users hit**. No mocks, no shortcuts.
2. The full response (verdict, score, flags, layer trusts, …) is
   saved as a JSON fixture under `__tests__/backtest/fixtures/`.
3. The accuracy test (`__tests__/backtest/accuracy.test.ts`) compares
   each fixture against the corpus expectations and emits a confusion
   matrix.

## What CI enforces, and what it cannot

- Every non-skipped entry has a captured fixture.
- Every stored verdict is inside the entry's tolerated set (see "How to read
  this" above for how loose that is).
- The score is checked against the entry's band when it has one (secondary).

CI does **not** enforce "no blue-chip is flagged DANGER or RUG" or "no rug is
ever SAFE": the first cannot fail while SAFE-labelled entries tolerate DANGER
and RUG, and neither says anything about a token that is not in the corpus.
The accuracy test reads stored files; it does not run the engine.

## Drift detection (weekly)

Captured fixtures are deterministic for CI but freeze a point-in-time
view. Real on-chain state moves: a SAFE memecoin gets rugged, a
DANGER token matures into CAUTION. Without re-checks the corpus
silently goes stale.

`.github/workflows/corpus-drift.yml` runs `corpus-drift-check.ts`
every Monday at 03:00 UTC on a rotating sample of 100 fixtures (the
window moves with the ISO week, so the whole corpus is covered in about
five runs). Each re-scan is a fresh run of the full pipeline on
production (Helius, RugCheck, GoPlus, Solscan, the AI summary), which
is why it is not done nightly on the whole corpus. It compares the
live engine with the fixtures and:

- Reports verdict changes (any RUG↔SAFE swap is critical).
- Reports score drift > 150 pts inside the same verdict (warning).
- Measures drift over the entries that were actually compared; failed
  captures are listed, never counted as stable.
- Opens one tracking issue when drift exceeds 5%, and refreshes that
  same issue on later runs, flagging which fixtures need recapture or
  a label update.
- Fails the job when the check itself is unreliable (more than 20% of
  the captures failed, nothing to compare, a crash), so a run that
  measured nothing can never show green.

Manual trigger: GitHub → Actions → Corpus drift check → Run workflow
(the sample size is an input; 0 re-scans the whole corpus, about two
hours).

## Adding a token

```bash
# 1. Add the entry to __tests__/backtest/corpus.ts (or auto-discover)
npm run corpus:discover

# 2. Capture the live fixture
npm run corpus:capture <SYMBOL>

# 3. Verify it lands in the expected band
npm run test:corpus
```

## What the engine is

A heuristic screen, not an oracle. A SAFE verdict means no detection layer
found a critical signal at scan time; it is not a guarantee, and false
negatives happen. The audit of 2026-10-07 found a rug (HAWK) scoring SAFE 893
while its holder data was unavailable (fixed), and found that two of the data
sources (RugCheck, GoPlus) were read through fields they do not send. This page
used to claim a 100% acceptable rate, "zero rugs flagged SAFE" and "tested live
on 650 real Solana tokens": none of that was supported by what the corpus
measures, and it has been removed.
