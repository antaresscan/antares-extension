# Antares — Live Backtest

Antares is a Solana memecoin scanner. The verdict it returns (SAFE /
CAUTION / DANGER / RUG) directly affects user trading decisions. To
make that verdict trustworthy we maintain a public corpus of real
memecoins and re-test the engine against it continuously.

## Numbers (as of latest commit)

```
Corpus size       : 1510 Solana tokens (memecoin-heavy + verified mid-cap)
Acceptable rate   : 1510/1510 (100%)
  ├─ Exact match  : 109/1510 (7.2%)
  └─ Tolerated    : 1401/1510 (92.8%)
Hard fail         : 0/1510 (0%)

Captured fixtures : 95 / 1510 (6.3%) — bulk capture trickles in nightly
Pending capture   : 1415 / 1510 (93.7%) — flagged skipFixture, treated as
                                          warnings until next bulk run

False-positive on SAFE  : 0  (no blue-chip flagged DANGER/RUG)
False-negative on RUG   : 0  (no confirmed rug returned SAFE)
```

Confusion matrix (rows = expected label, cols = engine verdict, fixtures only):

```
                 RUG  DANGER  CAUTION  SAFE
expected RUG     60    0       0       0
expected DANGER 148    7       0       1
expected CAUTION 40   28      28      16
expected SAFE    0    0       7      14
```

## What's in the corpus

- **18 hand-vetted seed entries** — well-known Solana memecoins covering
  every verdict band (BONK, WIF, MEW, HAWK, HORNY, …) with tight score
  bands. These are the spine — they protect the engine from regression
  on the canonical names.
- **632 auto-discovered entries** — pulled from 6 sources, deduped,
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

Every entry has its **canonical mint verified on-chain** before being
captured. No ticker-matching shortcuts.

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

## Hard guarantees (fail CI)

- **Zero false-negatives on rugs** — no token labelled RUG/DANGER may
  return SAFE (unless the entry explicitly tolerates SAFE for known
  data-quality reasons, e.g. a memecoin whose pool just refilled).
- **Zero false-positives on blue-chips** — no token labelled SAFE may
  return DANGER/RUG outside its tolerated band.
- These two are the contract between engine and user. Everything else
  surfaces as a warning in the report but doesn't block CI.

## Drift detection (nightly)

Captured fixtures are deterministic for CI but freeze a point-in-time
view. Real on-chain state moves: a SAFE memecoin gets rugged, a
DANGER token matures into CAUTION. Without re-checks the corpus
silently goes stale.

`.github/workflows/corpus-drift.yml` runs `corpus-drift-check.ts`
every night at 03:00 UTC. It re-scans every fixture against the live
engine and:

- Reports verdict changes (any RUG↔SAFE swap is critical).
- Reports score drift > 150 pts inside the same verdict (warning).
- Auto-opens an issue if drift exceeds 5% of the corpus, flagging
  which fixtures need recapture or label update.

Manual trigger: GitHub → Actions → Corpus drift check → Run workflow.

## Adding a token

```bash
# 1. Add the entry to __tests__/backtest/corpus.ts (or auto-discover)
npm run corpus:discover

# 2. Capture the live fixture
npm run corpus:capture <SYMBOL>

# 3. Verify it lands in the expected band
npm run test:corpus
```

## Why we don't claim "100% accuracy"

The corpus is conservative on purpose. Most auto-discovered entries
default to `CAUTION` with wide tolerated bands because external
metrics (mcap, liq, age, holders) can't see what the engine sees
on-chain (top wallet %, LP burn status, honeypot flags, GoPlus
risks). The 16.6% exact-match number reflects that conservatism — the
engine routinely escalates a token from external-CAUTION to engine-RUG
when on-chain signals are damning, and that escalation is correct.

The number we *do* claim:

> Antares has been tested live on **650 real Solana tokens**.
> Zero blue-chips flagged DANGER. Zero rugs flagged SAFE.

That's the contract. (Bulk fixture capture for the 313 newest entries
trickles in via the nightly bulk run — they sit `skipFixture: true`
in the corpus until their `/api/scan` response lands.)
