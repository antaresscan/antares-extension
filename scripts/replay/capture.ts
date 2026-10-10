// scripts/replay/capture.ts
//
// Records the upstream responses of REAL scans into the replay corpus (__tests__/replay/corpus/<mint>.json.br).
// It talks to a throwaway PREVIEW deployment that carries the recorder (scripts/replay/record-function.ts.txt): see
// scripts/replay/README.md for the whole procedure. The preview holds the API keys, so nothing secret is needed here.
//
//   PREVIEW_URL=https://antares-extension-xxxx.vercel.app npx tsx scripts/replay/capture.ts [options] [SYMBOL|MINT ...]
//
//   (no argument)   the hand-vetted tokens of the manifest        --bulk     every token of bulk.json
//   SYMBOL|MINT     only these tokens (manifest or bulk)          --sample   with --bulk: only the tokens that run in every `npm test`
//   --force         record again a token that already has a file  --pace N   milliseconds to wait between two tokens (default 8000)
//
// It can be stopped and started again at any time: a token that already has a file is skipped (unless --force). A scan is tried up
// to 3 times while an upstream answered with a rate limit, a server error or a failure: the corpus must hold the data of a healthy
// scan. A bulk token that is still unhealthy after 3 attempts is NOT written (it is listed at the end, run again later).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gunzipSync } from "node:zlib";
import { REPLAY_TOKENS } from "../../__tests__/replay/manifest";
import { inSample, parseBulk } from "../../__tests__/replay/bulk";
import { exchangeKey } from "../../__tests__/replay/keys";
import { normalizeScan } from "../../__tests__/replay/normalize";

const PREVIEW = (process.env.PREVIEW_URL ?? "").replace(/\/$/, "");
if (!PREVIEW) { console.error("PREVIEW_URL is required (the preview deployment that carries the recorder)"); process.exit(2); }
const OUT = path.resolve("__tests__/replay/corpus"); // run from the repository root
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const paceIdx = args.indexOf("--pace");
const PACE_MS = paceIdx >= 0 ? Number(args[paceIdx + 1]) : 8_000;
const only = args.filter((a, i) => !a.startsWith("--") && !(paceIdx >= 0 && i === paceIdx + 1));

interface Exchange { method: string; url: string; body: string | null; status: number; contentType: string | null; text: string; error?: string; auth?: boolean }
interface RecorderAnswer { ca: string; startedAt: number; status: number; result: Record<string, unknown> | null; exchanges: string }
interface Target { symbol: string; mint: string; dead: boolean; curated: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** GeckoTerminal allows about 30 calls a minute per IP (a scan makes up to 6): after a 429, wait for the window to reset. */
const THROTTLE_WAIT_MS = 50_000;
/**
 * GeckoTerminal only feeds the chart layer (candles for the pump windows). Its public API is throttled for good from a shared IP, so
 * a bulk recording whose only defect is that is kept (marked `degraded`) rather than dropped: dropping them would leave the corpus
 * with the tokens that were lucky. Any other source failing (Helius, RugCheck, GoPlus, DexScreener) is retried later instead.
 */
const CHART_ONLY = /^api\.geckoterminal\.com /;
const badness = (gaps: string[]): number => gaps.reduce((n, g) => n + (CHART_ONLY.test(g) ? 1 : 10), 0);
const WANTED_LAYERS = ["dexscreener", "rugcheck", "goplus", "helius", "chart"];
/** Hosts whose failure makes a recording unhealthy. Solscan is left out: it answers 401 for good (paid plan), and the engine pauses it. */
const WATCHED_HOSTS = /api\.dexscreener\.com|api\.rugcheck\.xyz|api\.gopluslabs\.io|helius-rpc\.com|api\.geckoterminal\.com/;

/** The engine reads 4 keys of a RugCheck report; the rest (markets, lockers...) weighs megabytes on a large token. */
const RUGCHECK_KEEP = ["risks", "topHolders", "totalHolders", "creator", "creatorBalance", "tokenProgram", "tokenType", "mint", "mintAuthority", "freezeAuthority", "score", "score_normalised", "rugged"];

/**
 * Shrinks what the engine does not read. Holder pages of a large token are the bulk of a recording (10 pages of 1,000
 * wallets): the engine only asks how many DISTINCT wallets hold a non-zero balance, so a wallet becomes a short id (the
 * same wallet keeps the same id from page to page) and an amount becomes 1 ("not empty"). No wallet address is committed.
 */
function trim(e: Exchange, owners: Map<string, string>): Exchange {
  const idOf = (owner?: string): string | undefined => {
    if (!owner) return undefined;
    let id = owners.get(owner);
    if (!id) { id = `h${owners.size + 1}`; owners.set(owner, id); }
    return id;
  };
  try {
    if (/api\.rugcheck\.xyz\/v1\/tokens\/[^/]+\/report$/.test(e.url)) {
      const full = JSON.parse(e.text) as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const k of RUGCHECK_KEEP) if (k in full) kept[k] = full[k];
      return { ...e, text: JSON.stringify(kept) };
    }
    if (/helius-rpc\.com/.test(e.url) && e.body && /"method"\s*:\s*"getTokenAccounts"/.test(e.body)) {
      const full = JSON.parse(e.text) as { result?: { total?: number; limit?: number; token_accounts?: Array<{ owner?: string; amount?: number | string }> } };
      if (full.result?.token_accounts) {
        const r = full.result;
        return { ...e, text: JSON.stringify({ ...full, result: { total: r.total, limit: r.limit, token_accounts: r.token_accounts!.map((a) => ({ owner: idOf(a.owner), amount: Number(a.amount) > 0 ? 1 : 0 })) } }) };
      }
    }
  } catch { /* keep as recorded */ }
  return e;
}

const isInsiderGraph = (e: Exchange): boolean => /api\.helius\.xyz\/v0\/transactions/.test(e.url) || (/helius-rpc\.com/.test(e.url) && /"method"\s*:\s*"getSignaturesForAddress"/.test(e.body ?? ""));

async function recordOnce(mint: string): Promise<{ answer: RecorderAnswer; exchanges: Exchange[] } | null> {
  try {
    const r = await fetch(`${PREVIEW}/api/replay-record?ca=${mint}`, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok) { console.log(`   recorder answered HTTP ${r.status}`); return null; }
    const answer = (await r.json()) as RecorderAnswer;
    const exchanges = (JSON.parse(gunzipSync(Buffer.from(answer.exchanges, "base64")).toString("utf8")) as Exchange[]).filter((e) => !isInsiderGraph(e));
    return { answer, exchanges };
  } catch (e) { console.log(`   recorder failed: ${(e as Error).message}`); return null; }
}

/** What makes a recording unhealthy: an upstream that failed or throttled (so the data is not what a healthy scan sees). */
function problems(result: Record<string, unknown> | null, exchanges: Exchange[], t: Target): string[] {
  const out: string[] = [];
  for (const e of exchanges) {
    if (!WATCHED_HOSTS.test(e.url)) continue;
    if (e.status === 0 || e.status === 429 || e.status >= 500) {
      const rpc = /"method"\s*:\s*"([A-Za-z]+)"/.exec(e.body ?? "")?.[1];
      const page = /"page"\s*:\s*(\d+)/.exec(e.body ?? "")?.[1];
      out.push(`${new URL(e.url).host}${rpc ? ` ${rpc}${page ? ` p${page}` : ""}` : ""} ${e.status === 0 ? (e.error ?? "failed") : e.status}`);
    }
  }
  if (t.curated) {
    const layers = (result?.layers ?? {}) as Record<string, { available?: boolean }>;
    const need = t.dead ? ["dexscreener"] : WANTED_LAYERS;
    for (const l of need) if (layers[l]?.available !== true) out.push(`layer ${l} missing`);
  }
  return [...new Set(out)];
}

const brotli = (buf: Buffer): Buffer => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });

void (async () => {
  mkdirSync(OUT, { recursive: true });
  const curated: Target[] = REPLAY_TOKENS.map((t) => ({ symbol: t.symbol, mint: t.mint, dead: t.dead === true, curated: true }));
  const bulk: Target[] = parseBulk(readFileSync(path.resolve("__tests__/replay/bulk.json"), "utf8")).map((t) => ({ symbol: t.symbol, mint: t.mint, dead: false, curated: false }));
  const pool = [...curated, ...(flag("--bulk") || only.length > 0 ? bulk : [])];
  let targets: Target[];
  if (only.length > 0) targets = pool.filter((t) => only.includes(t.symbol) || only.includes(t.mint));
  else if (flag("--bulk")) targets = [...curated, ...bulk.filter((t) => !flag("--sample") || inSample(t.mint))];
  else targets = curated;
  const todo = targets.filter((t) => flag("--force") || !existsSync(path.join(OUT, `${t.mint}.json.br`)));
  console.log(`${targets.length} token(s) selected, ${targets.length - todo.length} already recorded, ${todo.length} to record (pace ${PACE_MS} ms)`);

  const left: string[] = [];
  let done = 0, kb = 0;
  const started = Date.now();
  for (const t of todo) {
    const t0 = Date.now();
    let best: { answer: RecorderAnswer; exchanges: Exchange[]; gaps: string[] } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const rec = await recordOnce(t.mint);
      if (rec && rec.answer.result) {
        const gaps = problems(rec.answer.result, rec.exchanges, t);
        if (!best || badness(gaps) < badness(best.gaps)) best = { ...rec, gaps };
        if (gaps.length === 0) break;
        console.log(`   ${t.symbol}: attempt ${attempt}, unhealthy: ${gaps.join(", ")}`);
        if (attempt < 3) await sleep(gaps.some((g) => g.endsWith(" 429")) ? THROTTLE_WAIT_MS : 3_000);
      } else if (attempt < 3) await sleep(8_000 * attempt);
    }
    const tag = `[${String(done + left.length + 1).padStart(String(todo.length).length)}/${todo.length}] ${t.symbol.padEnd(12)} ${t.mint.slice(0, 8)}`;
    if (!best) { console.log(`FAILED  ${tag}: no usable recording`); left.push(`${t.symbol} ${t.mint} (no recording)`); await sleep(PACE_MS); continue; }
    const blocking = best.gaps.filter((g) => !CHART_ONLY.test(g));
    if (blocking.length > 0 && !t.curated) { console.log(`LATER   ${tag}: still unhealthy (${blocking.join(", ")}), not written`); left.push(`${t.symbol} ${t.mint} (${blocking.join(", ")})`); await sleep(PACE_MS); continue; }
    const owners = new Map<string, string>();
    const exchanges = best.exchanges.map((e) => trim(e, owners)).map((e) => ({ k: exchangeKey(e.method, e.url, e.body, e.auth === true), s: e.status, c: e.contentType, t: e.text, ...(e.error ? { x: e.error } : {}) }));
    // `degraded` names what was throttled when the scan was recorded and could not be had again (only the chart source, see CHART_ONLY).
    const file = { symbol: t.symbol, mint: t.mint, capturedAt: best.answer.startedAt, exchanges, live: normalizeScan(best.answer.result), ...(best.gaps.length ? { degraded: best.gaps } : {}) };
    const packed = brotli(Buffer.from(JSON.stringify(file)));
    writeFileSync(path.join(OUT, `${t.mint}.json.br`), packed);
    done++; kb += packed.length / 1024;
    console.log(`${best.gaps.length ? "PARTIAL" : "ok     "} ${tag} ${String(exchanges.length).padStart(3)} exch ${(packed.length / 1024).toFixed(0).padStart(3)} KB  ${file.live.risk} ${file.live.score}  ${((Date.now() - t0) / 1000).toFixed(0)}s${best.gaps.length ? `  (still: ${best.gaps.join(", ")})` : ""}`);
    await sleep(PACE_MS);
  }
  console.log(`\nrecorded ${done} token(s), ${kb.toFixed(0)} KB, in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  if (left.length) console.log(`${left.length} token(s) not recorded (run again later):\n${left.map((l) => `  ${l}`).join("\n")}`);
  process.exit(left.length ? 1 : 0);
})();
