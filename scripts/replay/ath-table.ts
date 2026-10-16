// scripts/replay/ath-table.ts
//
// The all-time high of the recorded tokens, for the replay (api/_lib/ath.ts asks CoinGecko for it, and the replay answers that request from this table:
// __tests__/replay/harness.ts). It is not a fact of the capture instant (it moves only when a token makes a new high), so it is not part of each recording.
//
//   npx tsx scripts/replay/ath-table.ts
//
// Four requests, not one per token: CoinGecko's list of every coin with its Solana address (once), then its market data 200 coins at a time. CoinGecko's public
// API (no key) allows a few calls a minute, so the requests are 12 seconds apart and a 429 is waited out. A token that is not in CoinGecko's list is left out of the
// table, and the replay answers its request with CoinGecko's own "not found" (404), which is what the engine would see.
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CORPUS = path.resolve("__tests__/replay/corpus");
const OUT = path.resolve("__tests__/replay/ath.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(url: string): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 429) { console.log("   429: waiting 65 s"); await sleep(65_000); continue; }
    if (!r.ok) throw new Error(`${url.slice(0, 90)} -> ${r.status}`);
    return (await r.json()) as T;
  }
  throw new Error("CoinGecko kept answering 429");
}

interface Listed { id: string; platforms?: Record<string, string | null> }
interface Market { id: string; ath: number | null; ath_date: string | null }

async function main(): Promise<void> {
  const mints = readdirSync(CORPUS).filter((f) => f.endsWith(".json.br")).map((f) => f.replace(/\.json\.br$/, ""));
  const list = await get<Listed[]>("https://api.coingecko.com/api/v3/coins/list?include_platform=true");
  const idOfMint = new Map<string, string>();
  for (const c of list) { const a = c.platforms?.solana; if (a) idOfMint.set(a, c.id); }
  const ids = [...new Set(mints.map((m) => idOfMint.get(m)).filter((x): x is string => !!x))];
  console.log(`${mints.length} recorded tokens, ${ids.length} known to CoinGecko`);
  const byId = new Map<string, Market>();
  for (let i = 0; i < ids.length; i += 200) {
    await sleep(12_000);
    const page = await get<Market[]>(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=1&sparkline=false&ids=${ids.slice(i, i + 200).join(",")}`);
    for (const m of page) byId.set(m.id, m);
    console.log(`   ${Math.min(i + 200, ids.length)}/${ids.length}`);
  }
  const tokens: Record<string, { ath: number; athDate: string | null }> = {};
  for (const mint of mints.sort()) {
    const id = idOfMint.get(mint);
    const m = id ? byId.get(id) : undefined;
    if (m && typeof m.ath === "number" && m.ath > 0) tokens[mint] = { ath: m.ath, athDate: m.ath_date ?? null };
  }
  const file = { recordedAt: new Date().toISOString().slice(0, 10), source: "CoinGecko /coins/list?include_platform=true and /coins/markets (public API, no key)", tokens };
  writeFileSync(OUT, `${JSON.stringify(file, null, 1)}\n`);
  console.log(`wrote ${Object.keys(tokens).length} tokens to ${path.relative(process.cwd(), OUT)}`);
}
void main();
