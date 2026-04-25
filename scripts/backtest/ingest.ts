// scripts/backtest/ingest.ts
//
// CLI: read a list of mint addresses from corpus/mints.txt and write a
// fresh snapshot for each to corpus/snapshots/{mint}.json. Designed to
// be run twice on the same mint list — once to capture `initial` (right
// after a token launches) and once later to capture `current` (used to
// derive ground truth in J3).
//
// Usage:
//   HELIUS_KEY=xxx node --import tsx scripts/backtest/ingest.ts initial
//   HELIUS_KEY=xxx node --import tsx scripts/backtest/ingest.ts current
//
// We intentionally process mints sequentially with a small delay rather
// than fanning out: the public DexScreener / RugCheck endpoints rate-
// limit aggressively, and a serial loop is correct-by-construction.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchSnapshot } from "./fetch-snapshot";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, "../../corpus");
const MINTS_FILE = resolve(CORPUS_DIR, "mints.txt");
const SNAPSHOTS_DIR = resolve(CORPUS_DIR, "snapshots");

const REQUEST_DELAY_MS = 1500;

type Bucket = "initial" | "current";

async function main(): Promise<void> {
  const bucket = (process.argv[2] ?? "current") as Bucket;
  if (bucket !== "initial" && bucket !== "current") {
    console.error(`Unknown bucket "${bucket}". Use "initial" or "current".`);
    process.exit(2);
  }

  const heliusKey = process.env.HELIUS_KEY ?? null;
  if (!heliusKey) {
    console.warn("HELIUS_KEY not set — top1HolderPct and holderCount will be null.");
  }

  const mints = await readMints();
  if (mints.length === 0) {
    console.error(`No mints found in ${MINTS_FILE}. Add one address per line.`);
    process.exit(2);
  }

  await mkdir(resolve(SNAPSHOTS_DIR, bucket), { recursive: true });
  console.log(`Ingesting ${mints.length} mints into bucket "${bucket}"`);

  let ok = 0;
  let failed = 0;
  for (const [i, mint] of mints.entries()) {
    try {
      const snap = await fetchSnapshot(mint, { heliusKey });
      const out = resolve(SNAPSHOTS_DIR, bucket, `${mint}.json`);
      await writeFile(out, JSON.stringify(snap, null, 2));
      ok++;
      console.log(`[${i + 1}/${mints.length}] ${mint} → ${out}`);
    } catch (e) {
      failed++;
      console.error(`[${i + 1}/${mints.length}] ${mint} FAILED: ${(e as Error).message}`);
    }
    if (i < mints.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nDone: ${ok} ok, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function readMints(): Promise<string[]> {
  const raw = await readFile(MINTS_FILE, "utf8");
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
