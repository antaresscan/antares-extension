# Anti-regression replay

The real `/api/scan` engine, run offline on the **recorded upstream responses** of real tokens. It is part of `npm test`, so
it runs in the `build` check of every pull request.

## What it is, and why it replaced the old backtest

The old backtest (`accuracy.test.ts`, removed) re-read verdicts that were stored in fixtures: it never ran the engine, so it could
neither fail nor prove anything. The replay does the opposite (it proves STABILITY, not correctness: see "What it does not prove"):

- every outgoing HTTP request of a scan (DexScreener, RugCheck, GoPlus, Helius, GeckoTerminal) is answered from a recording
  of a **real** scan (`__tests__/replay/corpus/<SYMBOL>.json.gz`);
- the clock is set to the instant of the capture, so token age, pump windows and candle recency are the same;
- nothing else is faked: schemas, fetchers, layers, scoring and verdict all run for real.

Each token is checked three ways (`__tests__/replay/replay.test.ts`):

1. **The scan answers and every request it makes was recorded.** A pull request that adds an upstream call fails here until the
   corpus is refreshed. Refreshing needs the real API keys, so it is a deliberate act.
2. **The result equals `__tests__/replay/golden.json`** (verdict, score, flags, sources, layers, mint/freeze/sell, LP, holders).
   A change is not forbidden, it is made **visible**: run `npm run replay:update` and review `git diff
   __tests__/replay/golden.json` in the pull request; every token that moved is listed with the flag that explains it.
3. **The verdict is one a human accepts** for that token (`manifest.ts`, with a one-line reason built on facts that do not
   depend on the engine). A token the engine gets wrong is a `knownIssue` (audit item id): reported, not failing, and
   **failing the day it is fixed**, so the marker goes away with the fix.

## What it does not prove

The replay proves **stability**: the same recorded inputs give the same verdict after a change. It does not prove that the
verdicts are **right**. The verdicts attached to the recorded tokens are human judgements built on facts about the token, not
outcomes. Whether a token flagged RUG did rug, or one flagged SAFE kept its value, needs what became of it days later. That is
not measured yet, and no accuracy figure is published until it is.

## Reading a failure

| Failure | Meaning | What to do |
|---|---|---|
| `every upstream request it makes was recorded` | the engine asks something the recording does not hold | refresh the corpus (below) if the new call is intended |
| `gives the same verdict, score, flags and facts as the golden file` | the replayed scan of this token changed | intended: `npm run replay:update`, review the diff. Not intended: you broke something |
| `returns a verdict a human accepts, or is a known issue` | the engine says something nobody accepts for this token | fix the engine, or, if the label is wrong, fix `manifest.ts` with a reason |
| `... is fixed. Remove its knownIssue` | a known issue no longer is one | delete the `knownIssue` field of that token |

`REPLAY_DEBUG=1 npm run replay` prints each unrecorded request as it happens.

## Refreshing the corpus (needs the real API keys, held by the Vercel project)

The recorder is a throwaway function that runs the real scan handler in a **preview deployment** and returns every outgoing
exchange. It never goes to production and never writes to production's database.

1. Copy `scripts/replay/record-function.ts.txt` to `api/replay-record.ts`; give it `maxDuration: 60` in `vercel.json`
   (`functions`). Do not commit either change.
2. `vercel deploy --yes -e UPSTASH_REDIS_REST_URL= -e UPSTASH_REDIS_REST_TOKEN= -e SENTRY_DSN=` (Redis and Sentry blanked).
3. From the repository root: `PREVIEW_URL=<the preview URL> npm run replay:capture [SYMBOL ...]`. A capture is retried while a
   source that should have answered did not (rate limits). On Windows with a long checkout path, point `ESBUILD_BINARY_PATH`
   at a copy of `esbuild.exe` in a short path.
4. `npm run replay:update`, review the diff of `golden.json`, delete the preview (`vercel rm`), restore `vercel.json`.

Secrets never reach the repository: credentials in URLs are redacted, headers are not recorded, and the GoPlus token exchange
and the Gemini calls are not recorded at all. Holder pages of a large token are reduced to what the engine reads (how many
distinct wallets hold a non-zero balance): a wallet becomes a short id and an amount becomes `1`, so no wallet address is
committed either.

## Adding a token

Add it to `__tests__/replay/manifest.ts` with the verdicts a human accepts and one line of reasons, capture it, then
`npm run replay:update`. Prefer labels built on facts the engine does not decide (age, liquidity removed, holders, history).
