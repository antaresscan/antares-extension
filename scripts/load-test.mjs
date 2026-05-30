// scripts/load-test.mjs — Launch-readiness load test for /api/scan
//
// Simulates a thundering herd of DISTINCT users (unique install-ID per
// request) hitting the production scan endpoint, ramping concurrency in
// stages. Reports latency percentiles, throughput, and error breakdown
// at each stage with a circuit breaker so the test can't self-DoS prod.
//
// Design notes
// ────────────
// • Heavy ramp uses POPULAR tokens (OFFICIAL_MINTS) so requests are served
//   from the Redis cache after warm-up — this tests the Vercel concurrency
//   + Redis read path (the real launch bottleneck) WITHOUT burning paid
//   Helius/Solscan/RugCheck quota on cold scans.
// • Each request carries a unique X-Antares-Install header → simulates
//   distinct users AND avoids the per-(ip,install) rate limiter masking
//   the true serving capacity. This is the worst-case launch scenario.
// • A separate phase reuses ONE install-ID to confirm the rate limiter
//   correctly fires (abuse protection).
//
// Usage:
//   node scripts/load-test.mjs                       # full ramp
//   BASE=https://...vercel.app node scripts/load-test.mjs
//   STAGES=50,100,200 DURATION=10 node scripts/load-test.mjs

const BASE = process.env.BASE || "https://antares-extension.vercel.app";
const ENDPOINT = `${BASE}/api/scan`;
const DURATION = Number(process.env.DURATION || 12);          // seconds per stage
const STAGES = (process.env.STAGES || "50,100,200,400,800")
  .split(",").map((n) => parseInt(n.trim(), 10)).filter(Boolean);
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 20000);
const ABORT_ERROR_RATE = Number(process.env.ABORT_ERROR_RATE || 0.15); // stop ramp if >15% 5xx/timeout

// Popular, real, cacheable tokens (from api/_lib/constants.ts OFFICIAL_MINTS).
const TOKENS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",  // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",  // WIF
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",   // JUP
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",   // MEW
  "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",   // POPCAT
  "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY",  // MOODENG
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",  // RAY
];

let _ridCounter = 0;
function freshInstallId() {
  // Valid per INSTALL_ID_RE: [a-zA-Z0-9_-]{8,128}
  return `loadtest-${Date.now().toString(36)}-${(_ridCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pct(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function oneRequest(ca, installId) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(`${ENDPOINT}?ca=${encodeURIComponent(ca)}`, {
      method: "GET",
      headers: { "X-Antares-Install": installId, "Accept": "application/json" },
      signal: ctrl.signal,
    });
    const ms = performance.now() - start;
    // Drain body so the connection can be reused / closed cleanly.
    const cacheHdr = res.headers.get("x-vercel-cache") || res.headers.get("cf-cache-status") || "";
    await res.text();
    return { ms, status: res.status, cache: cacheHdr };
  } catch (e) {
    const ms = performance.now() - start;
    const kind = e?.name === "AbortError" ? "timeout" : "neterr";
    return { ms, status: 0, err: kind };
  } finally {
    clearTimeout(t);
  }
}

async function runStage(concurrency, durationSec, { uniqueInstall = true, fixedInstall = null } = {}) {
  const latencies = [];
  const statusCounts = {};
  let total = 0, ok = 0, rate429 = 0, server5xx = 0, timeouts = 0, neterr = 0;
  const deadline = performance.now() + durationSec * 1000;
  let tokenIdx = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const ca = TOKENS[tokenIdx++ % TOKENS.length];
      const installId = uniqueInstall ? freshInstallId() : (fixedInstall || "loadtest-fixed-user-001");
      const r = await oneRequest(ca, installId);
      total++;
      latencies.push(r.ms);
      const key = r.err || String(r.status);
      statusCounts[key] = (statusCounts[key] || 0) + 1;
      if (r.status === 200) ok++;
      else if (r.status === 429) rate429++;
      else if (r.status >= 500) server5xx++;
      else if (r.err === "timeout") timeouts++;
      else if (r.err === "neterr") neterr++;
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  latencies.sort((a, b) => a - b);
  const elapsed = durationSec;
  const rps = total / elapsed;
  const hardErrors = server5xx + timeouts + neterr; // 429 is expected/benign protection
  const errRate = total > 0 ? hardErrors / total : 0;

  return {
    concurrency, total, rps,
    ok, rate429, server5xx, timeouts, neterr,
    errRate,
    p50: pct(latencies, 50), p90: pct(latencies, 90),
    p95: pct(latencies, 95), p99: pct(latencies, 99),
    max: latencies[latencies.length - 1] || 0,
    statusCounts,
  };
}

function fmt(n) { return Math.round(n).toLocaleString(); }
function printStage(s) {
  console.log(
    `  conc=${String(s.concurrency).padStart(4)} | ` +
    `req=${fmt(s.total).padStart(6)} | ${fmt(s.rps).padStart(5)} rps | ` +
    `ok=${fmt(s.ok).padStart(6)} 429=${fmt(s.rate429).padStart(4)} 5xx=${fmt(s.server5xx)} to=${fmt(s.timeouts)} net=${fmt(s.neterr)} | ` +
    `p50=${fmt(s.p50)}ms p95=${fmt(s.p95)}ms p99=${fmt(s.p99)}ms max=${fmt(s.max)}ms | ` +
    `hardErr=${(s.errRate * 100).toFixed(1)}%`
  );
}

async function main() {
  console.log(`\n═══ ANTARES LOAD TEST ═══`);
  console.log(`Target   : ${ENDPOINT}`);
  console.log(`Stages   : ${STAGES.join(", ")} concurrent workers`);
  console.log(`Duration : ${DURATION}s per stage`);
  console.log(`Tokens   : ${TOKENS.length} popular/cacheable mints`);
  console.log(`Model    : unique install-ID per request (distinct-user simulation)\n`);

  // ── Phase A: warm-up — populate the Redis cache for each token ──
  console.log(`── Phase A: cache warm-up (1 request per token, sequential) ──`);
  for (const ca of TOKENS) {
    const r = await oneRequest(ca, freshInstallId());
    console.log(`  ${ca.slice(0, 6)}…  status=${r.status}  ${fmt(r.ms)}ms`);
  }

  // ── Phase B: concurrency ramp on warm cache ──
  console.log(`\n── Phase B: concurrency ramp (warm cache, distinct users) ──`);
  const results = [];
  for (const c of STAGES) {
    const s = await runStage(c, DURATION, { uniqueInstall: true });
    printStage(s);
    results.push(s);
    if (s.errRate > ABORT_ERROR_RATE) {
      console.log(`\n  ⚠ CIRCUIT BREAKER: hard-error rate ${(s.errRate * 100).toFixed(1)}% > ${(ABORT_ERROR_RATE * 100)}% — stopping ramp.`);
      break;
    }
  }

  // ── Phase C: rate-limiter validation (single user hammered) ──
  console.log(`\n── Phase C: rate-limiter validation (1 install-ID, 100 req burst) ──`);
  const rl = await runStage(20, 6, { uniqueInstall: false, fixedInstall: "loadtest-abuse-001" });
  console.log(`  single-user burst → 200s=${rl.ok}  429s=${rl.rate429}  (expect 429s to appear: 60/60s + 20/10s limit)`);
  console.log(`  rate limiter ${rl.rate429 > 0 ? "✓ FIRED (abuse protection works)" : "✗ DID NOT FIRE — investigate"}`);

  // ── Summary ──
  console.log(`\n═══ SUMMARY ═══`);
  const peak = results[results.length - 1];
  const maxRps = Math.max(...results.map((r) => r.rps));
  console.log(`  Peak sustained throughput : ${fmt(maxRps)} req/s`);
  console.log(`  Highest concurrency tested: ${peak.concurrency} workers`);
  console.log(`  p95 @ peak                : ${fmt(peak.p95)}ms`);
  console.log(`  Hard-error rate @ peak    : ${(peak.errRate * 100).toFixed(1)}%`);
  const verdict =
    peak.errRate <= 0.02 && peak.p95 < 2000 ? "✓ HEALTHY — launch-ready at this load"
    : peak.errRate <= 0.05 ? "⚠ ACCEPTABLE — some degradation under peak"
    : "✗ DEGRADED — investigate before launch";
  console.log(`  Verdict                   : ${verdict}\n`);
}

main().catch((e) => { console.error("load-test fatal:", e); process.exit(1); });
