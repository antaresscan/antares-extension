// scripts/solscan/price-history.mjs — the daily price history of tokens, from Solscan Pro ONLY (no other price source).
//
//   node scripts/solscan/price-history.mjs scripts/solscan/ath-mints.json scripts/solscan/out/price-history.json
//   node scripts/solscan/price-history.mjs --explore <mint> scripts/solscan/out/explore.json     (which Solscan routes answer, and what they look like)
//
// The key is read from the SOLSCAN_API_KEY environment variable, or typed when asked (hidden, nothing is echoed). It is never written anywhere: the output files hold prices, dates and
// HTTP statuses only. Nothing here calls any service but pro-api.solscan.io.
//
// Rate limit (plan Lite: 1 000 requests / 60 s, 100 compute units per call): one request at a time, at least MIN_GAP_MS apart (about 3 a second, a sixth of the limit), a 429 waits and retries,
// a 401/403 stops everything at once (a refused key must not be hammered). The output file is rewritten after every token and a second run skips the tokens already done, so a stop or a
// crash costs nothing. 150 tokens = 150 calls = 15 000 units (0.075 % of a month).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import readline from "node:readline";

const BASE = process.env.SOLSCAN_BASE_FOR_TESTS || "https://pro-api.solscan.io/v2.0"; // the override is for the offline test of this script only
const MIN_GAP_MS = 300;
const TIMEOUT_MS = 20_000;
const FROM = "20210101";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); }; // the prompt is shown, what is typed is not
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()); });
  });
}

const key = process.env.SOLSCAN_API_KEY || (await askHidden("Solscan API key (hidden, never saved): "));
if (!key) { console.error("No key: nothing was done."); process.exit(2); }

let lastCall = 0;
/** One GET, spaced, with a retry on 429 / 5xx / silence. Returns { status, body } (body = parsed JSON or null). Stops the whole run on 401/403. */
async function get(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let status = 0, body = null;
    try {
      const r = await fetch(BASE + path, { headers: { token: key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = r.status;
      const text = await r.text();
      try { body = JSON.parse(text); } catch { body = { _text: text.slice(0, 300) }; }
    } catch (e) { status = 0; body = { _error: String(e && e.message || e).slice(0, 120) }; }
    if (status === 401 || status === 403) { console.error(`\nSolscan refused the key (HTTP ${status}). Stopped: nothing more was sent.`); process.exit(3); }
    if (status === 429) { console.log("  429: waiting 15 s"); await sleep(15_000); continue; }
    if (status === 0 || status >= 500) { console.log(`  HTTP ${status}: retrying in ${2 ** attempt * 2} s`); await sleep(2 ** attempt * 2000); continue; }
    return { status, body };
  }
  return { status: 0, body: null };
}

function save(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

// ── --explore: which routes exist, and what they look like (status, keys of the answer, the first 400 characters). Prices and statuses only. ─────────────────────────────────────────
if (process.argv[2] === "--explore") {
  const mint = process.argv[3];
  const out = process.argv[4] || "scripts/solscan/out/explore.json";
  if (!mint || !out) { console.error("usage: --explore <mint> <out.json>"); process.exit(2); }
  const day = (n) => { const d = new Date(Date.now() - n * 86_400_000); return d.toISOString().slice(0, 10).replace(/-/g, ""); };
  const paths = [
    `/token/price?address=${mint}&from_time=${day(10)}&to_time=${today()}`,
    `/token/price?address=${mint}`,
    `/token/historical-data?address=${mint}`,
    `/token/ohlcv?address=${mint}`,
    `/token/market/ohlcv?address=${mint}`,
    `/token/meta?address=${mint}`,
    `/token/markets?token[]=${mint}&sort_by=tvl&page=1&page_size=3`,
    `/token/defi/activities?address=${mint}&page=1&page_size=3`,
    `/token/holders?address=${mint}&page=1&page_size=3`,
    `/token/trending?limit=3`,
    `/token/top`,
  ];
  const results = [];
  for (const p of paths) {
    const { status, body } = await get(p);
    const row = { path: p.replace(mint, "<mint>"), status, keys: body && typeof body === "object" ? Object.keys(body) : null, head: JSON.stringify(body).slice(0, 400) };
    results.push(row);
    console.log(String(status).padEnd(4), row.path);
  }
  save(out, results);
  console.log(`\nwritten: ${out}`);
  process.exit(0);
}

// ── default: the whole daily history of each token of a list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const [listFile, outFile] = process.argv.slice(2);
if (!listFile || !outFile || !existsSync(listFile)) { console.error("usage: node price-history.mjs <mints.json> <out.json>   (mints.json = [{ symbol, mint, ... }])"); process.exit(2); }
const list = JSON.parse(readFileSync(listFile, "utf8"));
const done = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const to = today();
let n = 0;
for (const item of list) {
  n++;
  if (done[item.mint] && (done[item.mint].status === 200 || done[item.mint].status === 404)) continue; // an answer is final: only silences are asked again
  const { status, body } = await get(`/token/price?address=${encodeURIComponent(item.mint)}&from_time=${FROM}&to_time=${to}`);
  const data = body && Array.isArray(body.data) ? body.data : null;
  done[item.mint] = {
    symbol: item.symbol, status, success: body && body.success, ...(body && body.errors ? { errors: body.errors } : {}),
    rows: data ? data.length : null,
    rowKeys: data && data[0] ? Object.keys(data[0]) : null, // is there anything but { date, price }?
    series: data ? data.map((r) => [r.date, r.price]) : null,
    asked: { from: FROM, to },
  };
  save(outFile, done);
  console.log(`${String(n).padStart(3)}/${list.length} ${String(item.symbol).padEnd(12)} HTTP ${status}  ${data ? data.length + " days " + (data[0] ? data[0].date : "") + " .. " + (data[data.length - 1] ? data[data.length - 1].date : "") : "no data"}`);
}
console.log(`\nDone: ${Object.keys(done).length} tokens in ${outFile}`);
