# What a scan consumes, what each call is for, and where to cut

The goal is a balance: spend on what changes the verdict, and nothing on what is only decoration or answered twice. This page is
the inventory. The live numbers come from `/api/health?usage=N` (see "Measuring" below); the figures here were measured on the
365 real scans of the replay corpus (recorded 2026-10-10) or read in the code, and say which.

## Requests per cold scan (measured on 365 real scans)

| API | Requests | Unit and limit | Feeds the verdict? |
|---|---|---|---|
| DexScreener | 1 | free, about 300 a minute | yes: price, liquidity, age, links |
| RugCheck | 2 (summary + full report, up to 2.8 MB) | free | yes: risk list, creator, bundle, LP locked |
| GoPlus | about 1.6 (the token exchange is once per warm instance) | CU, free plan 150 a minute / 30 000 a day | yes: LP burn per pool, Token-2022 flags, holders |
| Helius | **13.1 on average**: `getTokenAccounts` 9.1, `getMultipleAccounts` 2, `getAccountInfo` 1, `getTokenLargestAccounts` 1 | credits: RPC 1, DAS 10, Enhanced Transactions 100 | yes: authorities, supply, holders, concentration |
| GeckoTerminal | 2 (98 % of scans) | free, **30 a minute per address** | yes: chart layer |
| Solscan Pro | 3, **all refused (401)** with the current plan | plan-dependent | no data comes back |
| Gemini | 1 (not recorded) | free quota in requests a day | no: the AI summary is only displayed (the overlay button is **locked for the free tier**, `token.html` shows it to everyone) |
| **Insider graph** (Helius, not recorded) | 20 `getSignaturesForAddress` + 1 Enhanced Transactions | **about 120 credits** | **no: display only** |

The corpus is biased towards large tokens (9 holder pages on average: most hit the 10-page cap). A new memecoin with a few hundred
holders needs 1 page.

## Helius credits per cold scan

| | small token (1 holder page) | large token (10 pages) |
|---|---|---|
| holders (DAS, 10 credits a page) | 10 | about 91 |
| authorities, supply, accounts, owners | about 4 | about 4 |
| insider graph (display only) | **about 120** | **about 120** |
| **total** | **about 134** | **about 215** |

On the Developer plan (10 million credits a month, about 10 DAS requests a second) that is 46 000 to 74 000 cold scans a month. The
graph is 55 to 90 % of what a scan spends at Helius, for something no verdict reads.

## Where to cut, in order of value

| # | Lever | Saves | Risk to verdicts | State |
|---|---|---|---|---|
| 1 | **Insider graph on demand** (only when the Insider Watch tab of `token.html` asks for it) | about 120 credits per cold scan | none: the graph feeds only the Critical Actors cluster cards and the holder activity rows | next pull request |
| 2 | **Cap the DAS holder pages** at 5 (the verdict reads holder thresholds at 200, 1 000, 5 000, 10 000, 50 000, 100 000; above 5 000 the GoPlus / RugCheck count already takes over) | up to 50 credits on large tokens | low, and measurable on the replay before merging | proposed |
| 3 | **Remember a refused Solscan key** for hours, shared through Redis, instead of 3 refused calls per warm instance every 10 minutes | noise and latency, not credits | none | proposed |
| 4 | **AI summary on demand**: generated when a Pro overlay or `token.html` asks for it, not for every cold scan (today free users never see it in the overlay, yet Gemini runs for them) | one Gemini request and up to 9 s of latency per cold scan | none on the verdict; the summary appears with a short delay | needs a decision |
| 5 | **Longer cache for established SAFE / CAUTION** (10 min today; bad verdicts already 10 to 30 min) | divides cold scans of popular tokens by about 3 | a SAFE can be stale for longer: only for tokens older than 30 days | needs a decision |
| 6 | **A daily cap for the free tier** (the free tier is unlimited by choice since 2026-05-11; the counter was removed to save Redis commands, not for a product reason) | bounds the worst case per install | none | needs a decision |
| 7 | **Fewer Redis commands per request** (3 rate-limit evaluations run even on a cache hit) | Upstash commands | security trade-off | measure first |
| 8 | **GeckoTerminal paid key** if more than 5 % of requests are refused | removes the 30-a-minute ceiling | none | measure first |

Already done: dead Solscan public endpoint and `heliusGetHoldersCount` removed (#790, #798), GeckoTerminal fallback chain stops at the first
refusal (#818), result without chart cached 30 s only (#818).

## A hidden cost to know about

Creator reputation (`heliusGetCreatorReputation`) is one Enhanced Transactions request, **100 credits**. It never runs today, because
the creator address comes from Solscan's token metadata, which is refused (401). **The day Solscan Pro is made to work, every cold scan
gains 100 Helius credits.** Fix the plan and this call together.

## Measuring

Every request sent to an upstream is counted by provider and by UTC day (`api/_lib/usage.ts`): requests, answered, refused (429/503),
key refused (401/403), failed, not sent (circuit breaker open) and estimated units. Nothing identifying is stored: no address, no key,
no token. Writing costs one Redis command per cold scan.

```bash
CRON_SECRET=<the value set in Vercel> npx tsx scripts/usage-report.ts 7 --plan-credits 10000000
```

What a "unit" means for each API is printed under the table. Helius follows its published credit table; GoPlus is **assumed** at 1 CU a
request (check the real cost in your GoPlus dashboard); the others count 1 per request. The figures are an estimate to size a plan with,
not an invoice: compare them with the Helius and GoPlus dashboards after the first week.
