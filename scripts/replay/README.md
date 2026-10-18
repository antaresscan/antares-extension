# Anti-regression replay

The real `/api/scan` engine, run offline on the **recorded upstream responses** of real tokens. It is part of `npm test`, so
it runs in the `build` check of every pull request; the whole corpus runs in the `replay` job of the CI.

## What it is, and why it replaced the old backtest

The old backtest (`accuracy.test.ts`, removed) re-read verdicts that were stored in fixtures: it never ran the engine, so it could
neither fail nor prove anything. The replay does the opposite (it proves STABILITY, not correctness: see "What it does not prove"):

- every outgoing HTTP request of a scan (DexScreener, RugCheck, GoPlus, Helius, GeckoTerminal) is answered from a recording
  of a **real** scan (`__tests__/replay/corpus/<mint>.json.br`);
- the clock is set to the instant of the capture, so token age, pump windows and candle recency are the same;
- nothing else is faked: schemas, fetchers, layers, scoring and verdict all run for real.

Two exceptions to "every request is answered from a recording", because neither is a fact of the capture instant:

- the **all-time high** of a token (Solscan `token/price`, ONE price a day, asked by `api/_lib/ath.ts` for the few tokens that can use it) is answered from `__tests__/replay/ath.json` (the highest prices
  of the recorded tokens, a fixture built by `npx tsx scripts/replay/ath-table.ts`, which reads a public price service once; it is only the REPLAY's table, the engine does not call that service) as a DAILY series whose highest day is `DAILY_HIGH_SHARE` (0.92, PYTH measured on Solscan: 1.10 against 1.20) of that number; a token that is not in the table gets
  "no price". `replayScan(rec, { dailyShare })` changes the share, `{ athDown: true }` makes Solscan answer 503.
- the **organic score** of a token (Jupiter's free token search, asked by `api/_lib/jupiter.ts` for the tokens whose relief depends on it) is answered from `__tests__/replay/jupiter.json`, measured on the whole
  corpus on 2026-10-16; a token that is not in it gets an empty list. `{ organicDown: true }` makes Jupiter answer 503.

What the recordings hold of Solscan (the 401 of the days the key was refused) is not what the engine meets today with a key that works, so every Solscan request of a replay is answered by the harness (a 404, "nothing
for this token", for the routes that are not the price history). A recording that holds one of the two other requests itself wins. `ath-solscan.test.ts` tests what follows from it (a serious token is clean whatever the daily
high, a market that is not alive is never relieved, no relief without Solscan or without Jupiter; the whole corpus with `REPLAY_FULL=1`).

To replace the fixture by Solscan's own numbers, run `node scripts/solscan/price-history.mjs scripts/solscan/ath-mints.json scripts/solscan/out/price-history.json` (the key is typed hidden, nothing is saved but prices).

`credibility.test.ts` holds the owner's own judgement on real tokens (serious ones the engine must never call DANGER or RUG, tokens that already rugged it must never call SAFE or CAUTION), with the
reason and the date of each. It reads the golden files, so it needs no network.

## Two kinds of tokens

| | hand-vetted (`manifest.ts`) | bulk (`bulk.json`) |
|---|---|---|
| how many | ~30 | ~1,000 listed; only the recorded ones run, the others are pending |
| label | a verdict set a human accepts, with a reason built on facts the engine does not decide | a **weak** label from the old auto-labelled discovery corpus (DexScreener signals only) |
| checked per token | answers + all requests recorded + same result as `golden.json` + **verdict accepted, or `knownIssue`** | answers + all requests recorded + same result as its line in `golden-bulk/<n>.jsonl` |
| aggregate | | two counts that must not get worse (`bulk-baseline.json`) |

A weak label is "how the token looked from the outside" (market cap, liquidity, age, 24 h change); it is never asserted token by
token. The bulk exists so that a change to the engine shows **every token it moves**, not just the thirty we looked at, and so
that the two worst errors cannot creep back unnoticed:

- `falseSafeOnDumped`: a token that looked dumped (weak label DANGER or RUG) that the engine calls **SAFE**, a rug waved through;
- `falseAlarmOnSafe`: a token that looked overwhelmingly safe (weak label SAFE) that the engine calls **DANGER or RUG**, a false
  alarm on a big name.

A **SAFE weak label needs an address that Jupiter's verified list knows**: a look-alike scam (a "BTC", an "ETH", a "JUP", a "Bonk" with a fake market cap) reads like a big name on DexScreener's numbers alone, and its DANGER is the right call. The 20 such tokens of the corpus are labelled DANGER, not SAFE (they had inflated `falseAlarmOnSafe` from 23 to 43).

The labels are noisy, so the counts are not zero. What is checked is their direction: a count that rises fails, and a count that
falls fails too until `bulk-baseline.json` is lowered in the same pull request (an improvement is locked in the day it lands).

## Tiers

| command | what runs | where |
|---|---|---|
| `npm test` / `npm run replay` | the hand-vetted tokens + a sample of the bulk (about a tenth, chosen by a hash of the mint) | `build` check |
| `npm run replay:full` | every token | `replay` job of the CI (only when the engine, the corpus or the dependencies changed) |
| `npm run replay:update` | every token, rewrites the golden files, then prints the baseline counts | by hand |
| `npm run replay:verify` | every recording is replayed and compared to what the real scan answered when it was recorded | by hand, right after a capture |

The bulk is cut in 8 shards (`replay-bulk-<n>.test.ts`) that vitest runs in parallel workers.

A bulk token with no recording yet is **pending**, not an error: the bulk is captured over several nights (see "Refreshing the corpus"),
and each batch is a pull request that adds recordings and golden lines. `replay.test.ts` only fails on a recording that belongs to no
token, or on a hand-vetted token without one. When a count of `bulk-baseline.json` moves, read the tokens the failure lists before
reading it as a regression: a count also moves when new tokens are recorded.

## What it does not prove

The replay proves **stability**: the same recorded inputs give the same verdict after a change. It does not prove that the
verdicts are **right**. The verdicts attached to the recorded tokens are human judgements built on facts about the token, not
outcomes. Whether a token flagged RUG did rug, or one flagged SAFE kept its value, needs what became of it days later. That is
being measured (see "Ground truth by outcome"), and no accuracy figure is published until it is.

## Ground truth by outcome

Every recording is a dated snapshot of a real token, so the same token can be looked at again later and the engine's verdict set
against what happened (`scripts/replay/outcomes.ts`, `__tests__/replay/outcomes/`):

```
npx tsx scripts/replay/outcomes.ts baseline              # T0 state of every recorded token, read from the recordings (no network)
npx tsx scripts/replay/outcomes.ts measure --label 7d    # where each token stands NOW (DexScreener public API, no key)
npx tsx scripts/replay/outcomes.ts report                # engine verdict x outcome, overall and by age at T0
```

An outcome is objective and computed from DexScreener only: **gone** (had a pool, none now), **rugged** (the deepest pool lost 90 %
of its liquidity or of its price), **crashed** (price down 50 to 90 %), **survived**. Tokens with under $1,000 of liquidity at T0 are
excluded: they were already dead when recorded. The question it answers is the one the weak labels cannot: of the tokens the engine
called SAFE, how many were rugged afterwards, and of the ones it called DANGER or RUG, how many survived.

The tokens recorded so far were captured on 2026-10-10 (365) and between 01:23 and 03:28 on 2026-10-11 (214 more, local time), so the
first measure is due around 2026-10-18 (`--label 7d`) and the second around 2026-11-10 (`--label 30d`). `measure` compares each
token with its own T0, so a day of difference between the two batches is simply part of the figure. Tokens recorded later have
their own T0 (`baseline` is run again after a capture).

## Reading a failure

| Failure | Meaning | What to do |
|---|---|---|
| `answers, and every upstream request it makes was recorded` | the engine asks something the recording does not hold | refresh the corpus (below) if the new call is intended |
| `gives the same verdict, score, flags and facts as the golden file` (vetted) / `no token moved from its golden line` (bulk) | a replayed scan changed; the bulk message lists each token with the verdict, score and flags that moved | intended: `npm run replay:update`, review the diff. Not intended: you broke something |
| `returns a verdict a human accepts, or is a known issue` | the engine says something nobody accepts for this token | fix the engine, or, if the label is wrong, fix `manifest.ts` with a reason |
| `... is fixed. Remove its knownIssue` | a known issue no longer is one | delete the `knownIssue` field of that token |
| `falseSafeOnDumped` / `falseAlarmOnSafe` | the bulk counts moved | worse: fix the engine. Better: lower `bulk-baseline.json` |

`REPLAY_DEBUG=1 npm run replay` prints each unrecorded request as it happens.

## What the replay does not cover

The **insider graph** (Helius `getSignaturesForAddress` and enhanced transactions) is not recorded: the scan builds it *after*
the verdict is final and it only feeds the Critical Actors cards and the holder activity rows of the response (`api/scan.ts`),
and it weighs more than all the other calls of a recording together (about 60 % of the bytes). The replay answers "no activity"
to those calls. A bug in how the graph is built or displayed is therefore not caught here (the e2e and the unit tests of
`insider-graph.ts` are the guard). Gemini (the AI summary) and Redis (cache, rate limits) are not replayed either.

## Refreshing the corpus (needs the real API keys, held by the Vercel project)

The recorder is a throwaway function that runs the real scan handler in a **preview deployment** and returns every outgoing
exchange. It never goes to production and never writes to production's database.

**One request to the preview at a time, never two.** The recorder replaces `globalThis.fetch` for the whole (warm, shared) instance
while a scan runs (`record-function.ts.txt`): a second request at the same moment, a second capture, a probe or a manual `curl`,
puts ITS exchanges in the first recording, and when it ends it puts the real `fetch` back while the first scan is still running, so
the rest of that scan is not recorded. `npm run replay:capture` asks one token after the other; run one capture, and nothing else
against the preview while it runs.

1. Copy `scripts/replay/record-function.ts.txt` to `api/replay-record.ts`; give it `maxDuration: 60` in `vercel.json`
   (`functions`). From a worktree, also add a `.vercelignore` (`node_modules`, `coverage`, `build`, `.plasmo`, `.claude`, `.git`) so that
   only the sources are uploaded. Do not commit any of these changes.
2. `vercel deploy --yes -e UPSTASH_REDIS_REST_URL= -e UPSTASH_REDIS_REST_TOKEN= -e SENTRY_DSN=` (Redis and Sentry blanked:
   the preview shares production's Redis otherwise).
3. From the repository root: `PREVIEW_URL=<the preview URL> npm run replay:capture -- [options] [SYMBOL|MINT ...]`
   - no argument: the hand-vetted tokens; `--bulk`: the bulk too; `--bulk --sample`: only the sample that runs in `npm test`;
   - a token that already has a file is skipped, so a long capture can be stopped and started again; `--force` records again;
   - a scan is tried up to 3 times while an upstream throttled or failed (the corpus must hold what a healthy scan sees); a bulk
     token that is still unhealthy is **not written** and is listed at the end, run again later;
   - `--pace N` waits N ms between two tokens (default 8,000: GeckoTerminal allows about 30 calls a minute).
   - `--list FILE` records only the mints of FILE (one per line, in that order, all of them in `bulk.json`): a batch chosen by quota rather than the whole bulk.
   - `--until DATE` stops between two tokens once DATE has passed (e.g. `--until 2026-10-11T07:00:00+02:00`), so a capture meant for the
     night ends before the day's traffic instead of being killed in the middle of a scan. It is checked only between two tokens: a
     laptop that goes to sleep FREEZES the capture (the first night recorded 214 tokens in about 2 hours, then slept until 14:30), so
     keep the machine awake for the length of the capture. About 100 tokens an hour is the real rhythm.
   On Windows with a long checkout path, point `ESBUILD_BINARY_PATH` at a copy of `esbuild.exe` in a short path.
4. `npm run replay:verify` (every replay must equal the real scan it was recorded from), then `npm run replay:update` and review
   the golden diff, delete the preview (`vercel rm`), restore `vercel.json`.

Secrets never reach the repository: credentials in URLs are redacted, headers are not recorded, and the GoPlus token exchange
and the Gemini calls are not recorded at all. Holder pages of a large token are reduced to what the engine reads (how many
distinct wallets hold a non-zero balance): a wallet becomes a short id and an amount becomes `1`. **That is the only place addresses
are replaced.** The other answers keep the public on-chain addresses they contain: RugCheck's top holders and creator, GoPlus's top
10 holders (their `token_account` is cut to its first account, which the engine never reads), and the token and pool addresses of
DexScreener. They are public blockchain data, not personal data, but they ARE in the repository. A recording is about 25 KB (brotli).

## Adding a token

Hand-vetted: add it to `__tests__/replay/manifest.ts` with the verdicts a human accepts and one line of reasons, capture it, then
`npm run replay:update`. Prefer labels built on facts the engine does not decide (age, liquidity removed, holders, history).
Bulk: add `[mint, symbol, weak label]` to `bulk.json` (a mint is in one list only), capture it, then `npm run replay:update`.

`bulk.json` was derived from the old backtest's `corpus-discovered.ts` (removed, kept in git history; 1,491 auto-labelled mints): the 980 mints that still had a
DexScreener pair on 2026-10-10, minus the hand-vetted ones. A mint whose market is gone has nothing a scan can read.
