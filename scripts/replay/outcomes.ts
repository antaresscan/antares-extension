// scripts/replay/outcomes.ts
//
// GROUND TRUTH BY OUTCOME. The replay says whether the engine is STABLE; it cannot say whether it is RIGHT, because the labels of
// the corpus are weak (they describe how a token looked from the outside, not what became of it). What settles it is what happened
// next: every recorded token is a dated snapshot, so we measure it again later and ask, of the tokens the engine called SAFE, how
// many were rugged afterwards, and of the ones it called DANGER / RUG, how many survived.
//
//   npx tsx scripts/replay/outcomes.ts baseline              T0 market state of every recorded token (from the recordings, no network)
//   npx tsx scripts/replay/outcomes.ts measure [--label 7d]  asks DexScreener (public API, no key) where each token stands NOW
//   npx tsx scripts/replay/outcomes.ts report  [--measure FILE] [--live]
//                                                            engine verdict x outcome, overall and by age at T0
//
// Outcome, objective and computed from DexScreener only (pools where the token is the base token):
//   gone      had a pool at T0, none now
//   rugged    liquidity of the deepest pool fell by 90 % or more, or its price fell by 90 % or more
//   crashed   price fell by 50 % to 90 %, liquidity not removed
//   survived  anything else
//   (excluded) tokens with under $1,000 of liquidity at T0: already dead when recorded, nothing to predict
//
// Verdict used: the golden file's (the CURRENT engine applied to the T0 data, which is what a change to the engine is about);
// `--live` uses the verdict the real scan gave when it was recorded.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

const ROOT = path.resolve("__tests__/replay");
const CORPUS = path.join(ROOT, "corpus");
const OUT = path.join(ROOT, "outcomes");
const MIN_LIQ_AT_T0 = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pool { liq: number; price: number; created: number | null }
interface State { pools: number; deepest: Pool | null }
interface BaselineRow { mint: string; symbol: string; capturedAt: number; live: string; liveScore: number; state: State }
interface MeasureFile { at: number; label: string; items: Record<string, State> }

interface DexPair { baseToken?: { address?: string }; liquidity?: { usd?: number }; priceUsd?: string; pairCreatedAt?: number }

/** The deepest pool of the token among the pairs where it is the BASE token (the other pairs belong to other tokens). */
export function stateOf(pairs: DexPair[], mint: string): State {
  const own = pairs.filter((p) => p.baseToken?.address === mint);
  if (own.length === 0) return { pools: 0, deepest: null };
  const best = own.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
  return { pools: own.length, deepest: { liq: best.liquidity?.usd ?? 0, price: Number(best.priceUsd ?? 0), created: best.pairCreatedAt ?? null } };
}

export type Outcome = "gone" | "rugged" | "crashed" | "survived" | "excluded";

export function classify(t0: State, now: State): Outcome {
  if (!t0.deepest || t0.deepest.liq < MIN_LIQ_AT_T0) return "excluded";
  if (!now.deepest) return "gone";
  const liqRatio = now.deepest.liq / t0.deepest.liq;
  const priceRatio = t0.deepest.price > 0 ? now.deepest.price / t0.deepest.price : 1;
  if (liqRatio <= 0.1 || priceRatio <= 0.1) return "rugged";
  if (priceRatio <= 0.5) return "crashed";
  return "survived";
}

function readRecording(file: string): { mint: string; symbol: string; capturedAt: number; live: { risk: string; score: number }; exchanges: Array<{ k: string; t: string }> } {
  return JSON.parse(brotliDecompressSync(readFileSync(path.join(CORPUS, file))).toString("utf8"));
}

function baseline(): void {
  const rows: BaselineRow[] = [];
  for (const f of readdirSync(CORPUS).filter((x) => x.endsWith(".json.br")).sort()) {
    const rec = readRecording(f);
    const ex = rec.exchanges.find((e) => /^GET https:\/\/api\.dexscreener\.com\/latest\/dex\/tokens\//.test(e.k));
    let state: State = { pools: 0, deepest: null };
    try { state = stateOf(((JSON.parse(ex?.t ?? "{}") as { pairs?: DexPair[] }).pairs) ?? [], rec.mint); } catch { /* no usable DexScreener answer: no pool */ }
    rows.push({ mint: rec.mint, symbol: rec.symbol, capturedAt: rec.capturedAt, live: rec.live.risk, liveScore: rec.live.score, state });
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "baseline.json"), `${JSON.stringify(rows)}\n`);
  const live = rows.filter((r) => r.state.deepest && r.state.deepest.liq >= MIN_LIQ_AT_T0).length;
  console.log(`baseline: ${rows.length} recorded tokens, ${live} with at least $${MIN_LIQ_AT_T0} of liquidity at T0 (the others are excluded from any outcome)`);
}

async function measure(label: string): Promise<void> {
  const base = JSON.parse(readFileSync(path.join(OUT, "baseline.json"), "utf8")) as BaselineRow[];
  const items: Record<string, State> = {};
  // One call per token, on the SAME endpoint the recordings hold (/latest/dex/tokens/<mint>, up to 30 pools). The batch endpoint
  // (/tokens/v1/solana/a,b,...) returns only the main pool of each token: the "deepest pool" then differs from T0's and a token
  // looks rugged (liquidity -97 %) while its price has not moved. A failed call is recorded as unmeasured, never as "no pool".
  for (const [i, row] of base.entries()) {
    let measured = false;
    for (let attempt = 1; attempt <= 3 && !measured; attempt++) {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${row.mint}`, { signal: AbortSignal.timeout(20_000) });
        if (r.ok) {
          const j = (await r.json()) as { pairs?: DexPair[] | null };
          items[row.mint] = stateOf(Array.isArray(j.pairs) ? j.pairs : [], row.mint);
          measured = true;
        }
      } catch { /* retry */ }
      if (!measured) await sleep(2_000 * attempt);
    }
    if (!measured) console.log(`   ${row.symbol}: could not be measured (left out of the report)`);
    if ((i + 1) % 100 === 0) console.log(`   ${i + 1}/${base.length}`);
    await sleep(250); // DexScreener allows about 300 calls a minute
  }
  const at = Date.now();
  const file: MeasureFile = { at, label, items };
  const name = `measure-${label}-${new Date(at).toISOString().slice(0, 10)}.json`;
  writeFileSync(path.join(OUT, name), `${JSON.stringify(file)}\n`);
  console.log(`measured ${Object.keys(items).length} tokens -> outcomes/${name}`);
}

function goldenVerdicts(): Map<string, string> {
  const out = new Map<string, string>();
  const cur = path.join(ROOT, "golden.json");
  const curated = existsSync(cur) ? (JSON.parse(readFileSync(cur, "utf8")) as Record<string, { risk: string }>) : {};
  const manifest = readFileSync(path.join(ROOT, "manifest.ts"), "utf8");
  for (const m of manifest.matchAll(/symbol:\s*"([^"]+)",\s*mint:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)) if (curated[m[1]]) out.set(m[2], curated[m[1]].risk);
  const dir = path.join(ROOT, "golden-bulk");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const g = JSON.parse(line) as { mint: string; scan: { risk: string } };
        out.set(g.mint, g.scan.risk);
      }
    }
  }
  return out;
}

function report(measureFile: string | undefined, useLive: boolean): void {
  const base = JSON.parse(readFileSync(path.join(OUT, "baseline.json"), "utf8")) as BaselineRow[];
  const files = readdirSync(OUT).filter((f) => f.startsWith("measure-")).sort();
  const pick = measureFile ?? files[files.length - 1];
  if (!pick) { console.error("no measure file yet: run `measure` first (and wait: a measure taken right after the capture shows nothing)"); process.exit(1); }
  const m = JSON.parse(readFileSync(path.join(OUT, pick), "utf8")) as MeasureFile;
  const golden = useLive ? new Map<string, string>() : goldenVerdicts();
  const verdictOf = (r: BaselineRow): string => (useLive ? r.live : golden.get(r.mint) ?? r.live);
  const bands: Array<[string, (days: number | null) => boolean]> = [
    ["all", () => true],
    ["under 30 days old at T0", (d) => d !== null && d < 30],
    ["30 to 180 days", (d) => d !== null && d >= 30 && d < 180],
    ["over 180 days", (d) => d !== null && d >= 180],
  ];
  const outcomes: Outcome[] = ["rugged", "gone", "crashed", "survived"];
  const verdicts = ["SAFE", "CAUTION", "DANGER", "RUG"];
  console.log(`measure ${pick} (${((m.at - Math.min(...base.map((r) => r.capturedAt))) / 86_400_000).toFixed(1)} days after the first recording); verdict = ${useLive ? "the real scan at capture time" : "the current engine (golden)"}`);
  for (const [title, inBand] of bands) {
    const rows = base.filter((r) => {
      const created = r.state.deepest?.created ?? null;
      return inBand(created ? (r.capturedAt - created) / 86_400_000 : null) && classify(r.state, m.items[r.mint] ?? { pools: 0, deepest: null }) !== "excluded";
    });
    console.log(`\n== ${title}: ${rows.length} tokens with liquidity at T0`);
    console.log(`${"verdict".padEnd(9)}${"tokens".padStart(7)}${outcomes.map((o) => o.padStart(10)).join("")}   bad outcome (rugged + gone)`);
    for (const v of verdicts) {
      const sel = rows.filter((r) => verdictOf(r) === v);
      const cnt = Object.fromEntries(outcomes.map((o) => [o, sel.filter((r) => classify(r.state, m.items[r.mint] ?? { pools: 0, deepest: null }) === o).length]));
      const bad = cnt.rugged + cnt.gone;
      console.log(`${v.padEnd(9)}${String(sel.length).padStart(7)}${outcomes.map((o) => String(cnt[o]).padStart(10)).join("")}   ${sel.length ? `${bad}/${sel.length} = ${((100 * bad) / sel.length).toFixed(1)} %` : "-"}`);
    }
  }
  console.log("\nRead it with care: a short window and old tokens give few rugs (most rugs happen in the first days of a token), so a low rate on SAFE proves little until the cohort has enough rugs in it; the launch cohort (new tokens scanned at launch) is what settles detection.");
}

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd === "baseline") baseline();
else if (cmd === "measure") void measure(opt("--label") ?? "now");
else if (cmd === "report") report(opt("--measure"), rest.includes("--live"));
else { console.error("usage: outcomes.ts baseline | measure [--label 7d] | report [--measure FILE] [--live]"); process.exit(2); }
