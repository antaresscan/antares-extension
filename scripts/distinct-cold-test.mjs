// scripts/distinct-cold-test.mjs — N DISTINCT tokens scanned at the same moment
//
// The case the other two load tests do not cover. load-test.mjs hits a warm
// cache; stampede-test.mjs hits ONE token (every request after the first is a
// shared result). Here every request is a cache miss for a different real token:
// each one is a full scan (~20 upstream calls plus Gemini). This is what
// "1000 people scanning different new tokens at once" looks like, at small
// scale. It tells you whether the upstream APIs, their rate limits and the
// function's time budget hold up, and whether the scan degrades gracefully.
//
// SAFETY
//   - BASE is REQUIRED: there is no default target.
//   - The production host is refused unless ALLOW_PROD=1.
//   - N is capped at 100. Each request spends real quota (Helius, RugCheck,
//     GoPlus, GeckoTerminal, Gemini); keep N modest.
//
// Usage:
//   BASE=https://<preview>.vercel.app N=20 node scripts/distinct-cold-test.mjs
//   Vercel Deployment Protection on? add BYPASS=<automation bypass secret>.
//   ONE_IP is implicit: all requests come from this machine, so with N above
//   COLD_SCANS_PER_MINUTE (60) you will see the cold-scan limiter answer 429 —
//   which is the point of that limiter, not a failure.
//
// Exit code: 0 healthy, 1 more than MAX_HARD_ERROR_RATE of hard errors
// (5xx / timeout / network), 2 bad usage.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PROD_HOST = "antares-extension.vercel.app";
const BASE = process.env.BASE;
if (!BASE) {
  console.error("BASE is required, e.g. BASE=https://<preview>.vercel.app (no default target by design).");
  process.exit(2);
}
let host;
try { host = new URL(BASE).hostname; } catch { console.error(`BASE is not a URL: ${BASE}`); process.exit(2); }
if (host === PROD_HOST && process.env.ALLOW_PROD !== "1") {
  console.error(`Refusing to run against production (${PROD_HOST}). Use a preview URL, or set ALLOW_PROD=1 if you really mean it.`);
  process.exit(2);
}

const N = Math.min(100, Math.max(1, Number(process.env.N || 20)));
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 30000);
const MAX_HARD_ERROR_RATE = Number(process.env.MAX_HARD_ERROR_RATE || 0.2);
const BYPASS = process.env.BYPASS || "";
const ENDPOINT = `${BASE.replace(/\/$/, "")}/api/scan`;

// Real tokens, from the scoring corpus. Base58, 32-44 chars.
const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "__tests__", "backtest");
const MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const pool = new Set();
for (const f of ["corpus.ts", "corpus-discovered.ts"]) {
  try { for (const m of readFileSync(join(corpusDir, f), "utf8").matchAll(MINT_RE)) pool.add(m[0]); } catch { /* file missing: use what we have */ }
}
const shuffled = [...pool].sort(() => Math.random() - 0.5);
if (shuffled.length < N) { console.error(`Only ${shuffled.length} distinct tokens available for N=${N}.`); process.exit(2); }
const tokens = shuffled.slice(0, N);

let c = 0;
const iid = () => `distinct-${Date.now().toString(36)}-${(c++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});

async function scan(ca) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const start = performance.now();
  try {
    const headers = { "X-Antares-Install": iid(), Accept: "application/json" };
    if (BYPASS) headers["x-vercel-protection-bypass"] = BYPASS;
    const res = await fetch(`${ENDPOINT}?ca=${encodeURIComponent(ca)}`, { headers, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    return {
      ms: performance.now() - start, status: res.status,
      risk: body?.risk ?? null,
      sources: Array.isArray(body?.sources_used) ? body.sources_used.length : null,
      retryAfter: res.headers.get("retry-after"),
    };
  } catch (e) {
    return { ms: performance.now() - start, status: 0, err: e?.name === "AbortError" ? "timeout" : "neterr" };
  } finally {
    clearTimeout(t);
  }
}

console.log(`\n═══ DISTINCT COLD-SCAN TEST ═══`);
console.log(`Target : ${ENDPOINT}`);
console.log(`Firing : ${N} simultaneous scans of ${N} DIFFERENT real tokens (all cache misses)\n`);

const t0 = performance.now();
const results = await Promise.all(tokens.map((ca) => scan(ca)));
const wall = performance.now() - t0;

const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const hard = results.filter((r) => r.status === 0 || r.status >= 500).length;
const rate = hard / results.length;
console.log(`Wall time      : ${Math.round(wall)} ms`);
console.log(`HTTP status    : ${JSON.stringify(count(results, (r) => r.err ?? String(r.status)))}`);
console.log(`Latency        : p50=${Math.round(pct(lat, 50))}ms p95=${Math.round(pct(lat, 95))}ms max=${Math.round(lat[lat.length - 1] ?? 0)}ms`);
console.log(`Verdicts       : ${JSON.stringify(count(results.filter((r) => r.status === 200), (r) => r.risk ?? "-"))}`);
console.log(`Sources used   : ${JSON.stringify(count(results.filter((r) => r.status === 200), (r) => String(r.sources)))}  (fewer = an upstream is throttling us)`);
console.log(`429 (limiter)  : ${results.filter((r) => r.status === 429).length}   503/504: ${results.filter((r) => r.status === 503 || r.status === 504).length}`);
console.log(`Hard errors    : ${hard}/${results.length} (${(rate * 100).toFixed(1)}%)  ${rate <= MAX_HARD_ERROR_RATE ? "✓ OK" : "✗ ABOVE THRESHOLD"}\n`);
process.exit(rate > MAX_HARD_ERROR_RATE ? 1 : 0);
