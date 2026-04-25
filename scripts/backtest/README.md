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
| (later) `ingest.ts` | Hits DexScreener / Helius / RugCheck to build `CorpusEntry` rows from a list of mints. Run manually or on a cron. |
| (later) `score.ts` | Replays the scoring engine on each entry's `initial` snapshot and records the verdict. |
| (later) `run.ts` | Orchestrates ingest → score → summarise and writes the bench JSON. |

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

## What this PR does NOT include

- Live ingestion scripts (`ingest.ts`) — coming in J2.
- Time-travel scoring runner (`score.ts`) — coming in J3.
- Lead-time / counterfactual-savings calculations — coming in J4.
- Public `/api/bench-stats` endpoint and bench page — coming in J5.
- CI gate that fails a PR if detection rate drops > 2pp — coming with J5.

J1 (this PR) only ships the type contract, the labelling rules, and
their tests. It is the foundation everything else builds on.
