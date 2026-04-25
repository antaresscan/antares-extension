# Backtest harness

The backtest harness measures how well the Antares scoring engine
classifies tokens whose true outcome we already know. It produces three
headline metrics that go on the public bench page:

- **Detection rate** — of all confirmed bad tokens, what fraction did
  the engine flag (TP / (TP + FN), HIGH-confidence cohort only).
- **False positive rate** — of all confirmed safe tokens, what fraction
  did the engine wrongly flag.
- **False negative rate** — of all confirmed bad tokens, what fraction
  the engine missed.

These numbers are not estimates — they're computed from auditable
ground-truth labels, and the methodology is open in this directory so
any third party can reproduce them.

## Files in this directory

| File | What it does |
|---|---|
| `types.ts` | Pure type contract: `TokenSnapshot`, `CorpusEntry`, `GroundTruthLabel`, `BacktestSummary`. Touch this to evolve the schema. |
| `auto-label.ts` | Pure functions that derive a ground-truth verdict from two snapshots + optional external oracles. No I/O. |
| `fetch-snapshot.ts` | Builds a `TokenSnapshot` for one mint by hitting DexScreener + Helius + GoPlus + RugCheck. Pure data-in / data-out — `fetch` is injected so it's mockable. |
| `ingest.ts` | CLI entrypoint. Reads `corpus/mints.txt`, calls `fetchSnapshot` sequentially (rate-limited), writes one JSON per mint to `corpus/snapshots/{bucket}/{mint}.json`. |
| (later) `score.ts` | Replays the scoring engine on each entry's `initial` snapshot and records the verdict. |
| (later) `run.ts` | Orchestrates ingest → score → summarise and writes the bench JSON. |

## Running the ingestion (J2)

The CLI captures a snapshot of every mint listed in `corpus/mints.txt`. Run
it once to seed `initial` (right after a token launches), then again later
to seed `current` (used to derive ground truth).

```bash
# Initial snapshot (fresh tokens you want to backtest)
HELIUS_KEY=xxx npx tsx scripts/backtest/ingest.ts initial

# Current snapshot (run 7-90 days later on the same mints)
HELIUS_KEY=xxx npx tsx scripts/backtest/ingest.ts current
```

Snapshots land in `corpus/snapshots/initial/<mint>.json` and
`corpus/snapshots/current/<mint>.json`. J3 will pair them up into
`CorpusEntry` rows automatically.

`HELIUS_KEY` is optional — without it, `top1HolderPct` and `holderCount`
are recorded as `null`. The auto-label rules treat missing data as
"abstain", so a partial corpus stays correctly classified (it just has
fewer HIGH-confidence rows).

## Ground-truth methodology

A token is labelled by counting how many independent oracles vote for
each candidate verdict (RUG / DANGER / SAFE):

| Oracle | What it observes | Voting for |
|---|---|---|
| Liquidity collapse rule | DexScreener-style `liquidityUsd` dropped > 95% on a token that started with ≥ $5k | RUG |
| Mint-authority rule | `mintAuthorityActive === true` on a token > 7 days old | DANGER |
| Honeypot rule | `honeypot === true` confirmed post-scan | DANGER |
| Stable safe-token rule | 90+ days alive, > $10k liquidity, > 500 holders, all authorities renounced, no honeypot | SAFE |
| RugCheck classification | Their published verdict, if known | matches their verdict |
| Solscan scam flag | Their tag, if set | RUG |

Confidence assignment:

- **HIGH** — 2+ oracles agree, OR a single overwhelming oracle (the
  liquidity-collapse rule on a previously-liquid token, or a confirmed
  honeypot). Both are nearly impossible to fake.
- **MEDIUM** — exactly 1 oracle votes, and it's not one of the
  overwhelming ones. Excluded from headline metrics.
- **LOW** — no oracle reaches threshold. Verdict is `UNKNOWN`. Always
  excluded from headline metrics.

Only **HIGH-confidence** rows feed `detectionRate` / `falsePositiveRate`
/ `falseNegativeRate` so the published numbers stay defensible. Counts
across all confidence levels are exposed under `outcomeCounts`.

## Adding a corpus entry by hand

While the automated ingestion pipeline is being built, you can seed
the corpus with hand-curated entries. The shape is in `types.ts`:

```ts
const entry: CorpusEntry = {
  initial: {
    ca: "So11111111111111111111111111111111111111112",
    capturedAt: 1714000000,         // unix seconds at scan time
    liquidityUsd: 50000,
    holderCount: 1200,
    top1HolderPct: 8,
    tokenAgeHours: 24,              // T+24h after launch
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    honeypot: false,
    lpBurned: true,
    lpLocked: false,
    volume24hUsd: 12000,
    rugcheckClassification: null,
    solscanScamFlag: null,
  },
  current: {
    // Same shape, snapshot taken later (typically 7-90 days after).
    ...
  },
  engineVerdict: {
    verdict: "SAFE",                 // What the engine said for `initial`
    score: 850,
    scoringVersion: "7.1.0",
  },
}
```

Pass an array of these to `summariseCorpus()` from `auto-label.ts` to
get the headline metrics. Every step is a pure function — no API keys
or network needed at this stage.

## Roadmap

- ✅ **J1** — type contract, labelling rules, 34 tests.
- ✅ **J2** — `fetch-snapshot.ts` + `ingest.ts` CLI (this PR).
- **J3** — Time-travel scoring runner (`score.ts`): replay the engine
  on each entry's `initial` snapshot and record the verdict.
- **J4** — Lead-time + counterfactual-savings calculations.
- **J5** — Public `/api/bench-stats` endpoint, bench page, and a CI
  gate that fails a PR if detection rate drops > 2pp.
