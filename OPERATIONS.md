# Operations

How the CI end-to-end job picks what it tests, how to load-test the scan safely, and which signals to watch (and alert on) in production.

## 0. The e2e job (CI)

### When it runs

The e2e only tells you something when a run can change an HTTP response, so it **decides by itself, per run**. `.github/scripts/e2e-needed.mjs` looks at the files the run changes (it asks the GitHub API, no checkout history needed):

| What changed | e2e |
|---|---|
| `api/`, `shared/`, `js/`, root `*.html`, `vercel.json`, `tsconfig.json` | runs |
| `e2e/`, `playwright.config.ts`, `.github/scripts/`, `.github/workflows/ci.yml` | runs (a change to the e2e must be tested) |
| `package.json` / `package-lock.json`: a **production** dependency, the Node engine or a build script | runs |
| `package.json` / `package-lock.json`: `@playwright/test` (the e2e runner) | runs |
| `package.json` / `package-lock.json`: devDependencies only (`typescript-eslint`, `tsx`, `@types/*`...) | skipped |
| extension code (`contents/`, `background.ts`, `popup.tsx`, `options.tsx`), tests, scripts, docs, other workflows | skipped |
| a push to a branch that already has an open pull request | skipped (the `pull_request` run of the same commit does it) |
| anything it cannot determine (API error, more than 300 files, unreadable lockfile) | **runs** |

A skipped run still ends green, in a few seconds, and its summary says why. To change the rules, edit `DEPLOYED` / `E2E_INFRA` in the script; `__tests__/e2e-needed.test.ts` pins them. The `build` job (unit tests, lint, types, bundle smoke) is unaffected and always runs.

### What it tests

The `e2e` job tests **the Vercel deployment built from the commit under test**, not production:

| Run | What it waits for and tests |
|---|---|
| Pull request / push to a branch | the `Preview` deployment of that commit |
| Push to `master` (a merge) | the `Production` deployment of that commit |

`.github/scripts/resolve-deployment.sh` waits (up to 15 minutes) for Vercel to report that deployment through the GitHub Deployments API and prints its unique URL. Consequences:

- A PR is judged on **its own code**, and the run a merge triggers waits for the deploy instead of racing it.
- If Vercel's build of the commit failed, the job fails with that reason (there is nothing to test).
- If no deployment shows up in time, the job falls back to production and says so in a warning: that run describes production, not the commit.
- The tests send a fixed, allowed `Origin` (`E2E_ORIGIN`), because a deployment host is not an allowed origin.

What gates a PR is the **contract**: fields, types, ranges, status codes, headers, CORS. What the engine *says* about a real token (its verdict) depends on live market data and on which upstream answered in time, which a PR cannot control. Those checks are **probes**: a surprising answer appears as a `::warning::` annotation in the run (look for `Live verdict probe`), it does not fail the PR. Add new live-market checks the same way.

## 1. Load tests

Three scripts, three different questions. All take the target from `BASE`.

| Script | Question it answers | Cost |
|---|---|---|
| `scripts/load-test.mjs` | How many requests per second does the **cached** path serve? Does the rate limiter fire on one abusive install? | Low (cache hits) |
| `scripts/stampede-test.mjs` | A token starts trending: N requests for the **same** uncached token. Is exactly one scan run and shared? | Low (one scan) |
| `scripts/distinct-cold-test.mjs` | N people scan N **different** new tokens at once. Do the upstream APIs, their rate limits and the time budget hold? | **High**: every request is a full scan (~20 upstream calls plus Gemini) |

```bash
# Against a preview deployment, never production by accident:
BASE=https://<preview>.vercel.app STAGES=5,10,20 DURATION=8 node scripts/load-test.mjs
BASE=https://<preview>.vercel.app N=20 node scripts/stampede-test.mjs
BASE=https://<preview>.vercel.app N=20 node scripts/distinct-cold-test.mjs
```

- `load-test.mjs` and `stampede-test.mjs` **default to production** when `BASE` is unset. Always set it.
- `distinct-cold-test.mjs` has no default target, refuses the production host unless `ALLOW_PROD=1`, and caps `N` at 100.
- Preview deployments behind Vercel Deployment Protection answer 401: pass the automation bypass secret as `BYPASS=...` (`distinct-cold-test.mjs`).
- Everything runs from one machine, so it is one IP. Above 60 distinct uncached tokens a minute the cold-scan limiter answers `429`; that is the limiter working, not a failure.
- A preview only tells you something if its environment variables (Helius, Upstash, Gemini, ...) are set for the Preview environment. If most responses report few `sources_used`, check that first.

## 2. Signals

`/api/scan` writes structured metrics to the runtime logs (they are not filtered by log level). Fields that matter:

| Metric | Fields | Meaning |
|---|---|---|
| `scan.outcome` | `latencyMs`, `sourcesUsed`, `partial`, `degraded`, `verdict` | One per scan actually run. `degraded: true` = the scan ran out of time or had no source at all; its result is cached for 30 s only. |
| `scan.cache_hit` | `latencyMs` | Served from the cache. |
| `scan.coalesced` | `latencyMs` | Served by the result of another scan of the same token. |
| `scan.cold_limited` | `retryAfterSec` | A network went over 60 cold scans a minute and was refused (429). No IP is logged. |

HTTP statuses of `/api/scan`: `429` rate limit or cold-scan limit, `503` "Scan in progress, retry" (a waiter that ran out of time), `504` the global time budget was exceeded.

Gemini trouble shows up as warnings: `Gemini call timed out`, `Gemini rate-limited`, `Gemini time budget exhausted`. The summary then falls back to the local text; the scan itself is not affected.

## 3. Suggested alerts

Thresholds are starting points; tune them after a week of real traffic.

| Alert | Condition | Why |
|---|---|---|
| Scan failing | 5xx on `/api/scan` above 2 % for 5 min | Users get errors instead of verdicts. |
| Scan slow | p95 of `scan.outcome.latencyMs` above 12 s for 15 min | An upstream is slow; the budget is 24 s. |
| Running degraded | `degraded: true` on more than 10 % of `scan.outcome` for 15 min | An upstream is down or throttling us. |
| Fewer sources | mean `sourcesUsed` 1 or more below its 24 h average | One layer stopped answering (key expired, quota, outage). |
| Someone hammering | more than 20 `scan.cold_limited` an hour | A script is rotating install ids to dodge the per-install limits. |
| Gemini unhealthy | more than 20 `Gemini call timed out` an hour | Summaries are falling back; check the quota. |

Where to set them depends on the plan and lives in the provider accounts, not in this repository:

- **Vercel**: Observability alerts (error rate, duration) and log filters on the metric names above, if the plan includes them. Otherwise read the logs by hand:
  `vercel logs --environment production --since 30m --no-branch --json` and count the metric names.
- **Upstash**: usage and budget alerts on the Redis database (commands per day).
- **Helius / Gemini / GeckoTerminal**: their dashboards have credit and quota alerts. A silent expiry of the Helius key once hid a month-long outage; the `upstream rejected our credentials` log line (401/403 from an upstream, at most once a minute per host) is the early warning.
