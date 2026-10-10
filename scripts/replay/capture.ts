// scripts/replay/capture.ts
//
// Records the upstream responses of REAL scans into the replay corpus (__tests__/replay/corpus/<SYMBOL>.json.gz).
// It talks to a throwaway PREVIEW deployment that carries the recorder (scripts/replay/record-function.ts.txt): see
// scripts/replay/README.md for the whole procedure. The preview holds the API keys, so nothing secret is needed here.
//
//   PREVIEW_URL=https://antares-extension-xxxx.vercel.app npx tsx scripts/replay/capture.ts [SYMBOL ...]
//
// Without symbols, every token of the manifest is recorded. A capture is retried (up to 3 times) while a source that
// should have answered did not (a rate limit, a timeout): the corpus must hold the data a healthy scan sees.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { REPLAY_TOKENS } from "../../__tests__/replay/manifest";
import { exchangeKey } from "../../__tests__/replay/keys";
import { normalizeScan } from "../../__tests__/replay/normalize";

const PREVIEW = (process.env.PREVIEW_URL ?? "").replace(/\/$/, "");
if (!PREVIEW) { console.error("PREVIEW_URL is required (the preview deployment that carries the recorder)"); process.exit(2); }
const OUT = path.resolve("__tests__/replay/corpus"); // run from the repository root
const only = process.argv.slice(2);

interface Exchange { method: string; url: string; body: string | null; status: number; contentType: string | null; text: string; error?: string; auth?: boolean }
interface RecorderAnswer { ca: string; startedAt: number; status: number; result: Record<string, unknown> | null; exchanges: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WANTED_LAYERS = ["dexscreener", "rugcheck", "goplus", "helius", "chart"];

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

async function recordOnce(mint: string): Promise<{ answer: RecorderAnswer; exchanges: Exchange[] } | null> {
  try {
    const r = await fetch(`${PREVIEW}/api/replay-record?ca=${mint}`, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok) { console.log(`   recorder answered HTTP ${r.status}`); return null; }
    const answer = (await r.json()) as RecorderAnswer;
    const exchanges = JSON.parse(gunzipSync(Buffer.from(answer.exchanges, "base64")).toString("utf8")) as Exchange[];
    return { answer, exchanges };
  } catch (e) { console.log(`   recorder failed: ${(e as Error).message}`); return null; }
}

const missing = (result: Record<string, unknown> | null, expectDead: boolean): string[] => {
  const layers = (result?.layers ?? {}) as Record<string, { available?: boolean }>;
  const need = expectDead ? ["dexscreener"] : WANTED_LAYERS;
  return need.filter((l) => layers[l]?.available !== true);
};

void (async () => {
  mkdirSync(OUT, { recursive: true });
  const tokens = REPLAY_TOKENS.filter((t) => only.length === 0 || only.includes(t.symbol));
  let failed = 0;
  for (const t of tokens) {
    const dead = t.dead === true;
    let best: { answer: RecorderAnswer; exchanges: Exchange[]; gaps: string[] } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const rec = await recordOnce(t.mint);
      if (rec && rec.answer.result) {
        const gaps = missing(rec.answer.result, dead);
        if (!best || gaps.length < best.gaps.length) best = { ...rec, gaps };
        if (gaps.length === 0) break;
        console.log(`   ${t.symbol}: attempt ${attempt}, layers missing: ${gaps.join(", ")}`);
      }
      await sleep(8_000 * attempt);
    }
    if (!best) { console.log(`FAILED  ${t.symbol}: no usable recording`); failed++; continue; }
    const owners = new Map<string, string>();
    const exchanges = best.exchanges.map((e) => trim(e, owners)).map((e) => ({ k: exchangeKey(e.method, e.url, e.body, e.auth === true), s: e.status, c: e.contentType, t: e.text, ...(e.error ? { x: e.error } : {}) }));
    const file = { symbol: t.symbol, mint: t.mint, capturedAt: best.answer.startedAt, exchanges, live: normalizeScan(best.answer.result) };
    const gz = gzipSync(Buffer.from(JSON.stringify(file)), { level: 9 });
    writeFileSync(path.join(OUT, `${t.symbol}.json.gz`), gz);
    console.log(`${best.gaps.length ? "PARTIAL" : "ok     "} ${t.symbol.padEnd(10)} ${String(exchanges.length).padStart(3)} exchanges, ${(gz.length / 1024).toFixed(0).padStart(4)} KB, live verdict ${file.live.risk} ${file.live.score}${best.gaps.length ? `  (layers still missing: ${best.gaps.join(", ")})` : ""}`);
  }
  console.log(failed ? `\n${failed} token(s) could not be recorded` : "\nall recorded");
  process.exit(failed ? 1 : 0);
})();
