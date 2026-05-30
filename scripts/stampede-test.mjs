// scripts/stampede-test.mjs — Cache-stampede / cold-scan thundering-herd test
//
// Fires N simultaneous COLD scans (fresh=1, cache bypassed) at the SAME
// token to measure what happens on launch day when a token starts trending
// and many users scan it before any cache exists. Measures whether the
// upstream batch degrades gracefully or cascades into errors.
//
// Quota cost: N cold scans = N upstream batches. Keep N modest.

const BASE = process.env.BASE || "https://antares-extension.vercel.app";
const ENDPOINT = `${BASE}/api/scan`;
const N = Number(process.env.N || 20);
const CA = process.env.CA || "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 30000);
// FRESH=1 → append &fresh=1 (bypasses cache AND single-flight coalescing —
// the "before" baseline). Default OFF → exercises the single-flight path:
// on a cold CA, only 1 cold scan should fire and everyone reads its result.
const FRESH = process.env.FRESH === "1";

let c = 0;
const iid = () => `stampede-${Date.now().toString(36)}-${(c++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function coldScan() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(`${ENDPOINT}?ca=${encodeURIComponent(CA)}${FRESH ? "&fresh=1" : ""}`, {
      headers: { "X-Antares-Install": iid(), Accept: "application/json" },
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    const ms = performance.now() - start;
    // sources_used tells us how many upstream layers actually resolved —
    // a degraded scan (upstream rate-limited) returns fewer sources.
    const sources = Array.isArray(body?.sources_used) ? body.sources_used.length : null;
    return { ms, status: res.status, risk: body?.risk ?? null, sources };
  } catch (e) {
    const ms = performance.now() - start;
    return { ms, status: 0, err: e?.name === "AbortError" ? "timeout" : "neterr" };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  console.log(`\n═══ CACHE-STAMPEDE TEST ═══`);
  console.log(`Target : ${ENDPOINT}`);
  console.log(`Token  : ${CA.slice(0, 8)}…  ${FRESH ? "(fresh=1 — coalescing BYPASSED, baseline)" : "(no fresh — single-flight ACTIVE)"}`);
  console.log(`Firing : ${N} simultaneous requests for the SAME token\n`);

  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: N }, () => coldScan()));
  const wall = performance.now() - t0;

  const ok = results.filter((r) => r.status === 200);
  const errs = results.filter((r) => r.status !== 200);
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const sourcesDist = {};
  for (const r of ok) {
    const k = r.sources == null ? "?" : String(r.sources);
    sourcesDist[k] = (sourcesDist[k] || 0) + 1;
  }
  const risks = {};
  for (const r of ok) { const k = r.risk || "?"; risks[k] = (risks[k] || 0) + 1; }

  console.log(`  wall-clock for all ${N}      : ${Math.round(wall)}ms`);
  console.log(`  success (200)              : ${ok.length}/${N}`);
  console.log(`  errors                     : ${errs.length}  ${errs.map((e) => e.err || e.status).join(",")}`);
  console.log(`  latency min/median/max     : ${Math.round(lat[0])} / ${Math.round(lat[Math.floor(lat.length / 2)])} / ${Math.round(lat[lat.length - 1])} ms`);
  console.log(`  sources_used distribution  : ${JSON.stringify(sourcesDist)}  (6 = all upstreams resolved; fewer = degraded)`);
  console.log(`  verdicts                   : ${JSON.stringify(risks)}  (should be identical for the same token)`);

  const degraded = ok.filter((r) => r.sources != null && r.sources < 5).length;
  console.log(`\n  ${errs.length === 0 ? "✓" : "✗"} no hard failures   |   ${degraded === 0 ? "✓ no upstream degradation" : `⚠ ${degraded} scans degraded (<5 sources) — upstreams rate-limited under stampede`}`);
  const consistent = Object.keys(risks).length <= 1;
  console.log(`  ${consistent ? "✓" : "⚠"} verdict consistency: ${consistent ? "all identical" : "INCONSISTENT — same token returned different verdicts under load"}\n`);
}

main().catch((e) => { console.error("stampede fatal:", e); process.exit(1); });
