// __tests__/replay/replay.test.ts
//
// ANTI-REGRESSION REPLAY. The real /api/scan engine is run on the recorded upstream responses of real tokens (see
// harness.ts and scripts/replay/README.md). It differs from the old backtest, which re-reads verdicts that were stored in
// fixtures and never runs the engine: here a change to a schema, a fetcher, a layer or the scoring changes the result.
//
// For each token of the corpus, three things are checked:
//   1. the scan answers, and every upstream request it makes was recorded (a pull request that adds a call must refresh
//      the corpus: that needs the real API keys, so it is a deliberate act and not something that slips in);
//   2. the verdict, score, flags and facts equal the committed golden file. A change is not forbidden: it is made VISIBLE.
//      The author runs `npm run replay:update` and the diff of golden.json, reviewed in the pull request, shows which tokens
//      moved and why. An accidental change fails here;
//   3. the verdict is one a human accepts for that token (manifest.ts). A token the engine gets wrong is a `knownIssue`:
//      reported, not failing, and failing the day it is fixed so that the marker is removed with the fix.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPLAY_TOKENS, type Verdict } from "./manifest";
import { loadRecording, recordedSymbols, replayScan, type ReplayOutcome } from "./harness";
import type { NormalizedScan } from "./normalize";

const GOLDEN_FILE = fileURLToPath(new URL("./golden.json", import.meta.url));
const UPDATE = process.env.REPLAY_UPDATE === "1";
const golden: Record<string, NormalizedScan> = existsSync(GOLDEN_FILE) ? (JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, NormalizedScan>) : {};
const replayed: Record<string, NormalizedScan> = {};

describe("the corpus is consistent", () => {
  it("every token of the manifest has a recording, and every recording belongs to a token", () => {
    expect(recordedSymbols()).toEqual(REPLAY_TOKENS.map((t) => t.symbol).sort());
  });

  it("symbols and mints are unique", () => {
    expect(new Set(REPLAY_TOKENS.map((t) => t.symbol)).size).toBe(REPLAY_TOKENS.length);
    expect(new Set(REPLAY_TOKENS.map((t) => t.mint)).size).toBe(REPLAY_TOKENS.length);
  });

  it("every recording is of the mint the manifest names", () => {
    for (const t of REPLAY_TOKENS) expect(loadRecording(t.symbol)?.mint, t.symbol).toBe(t.mint);
  });

  it.skipIf(UPDATE)("the golden file holds exactly the tokens of the manifest", () => {
    expect(Object.keys(golden).sort(), "run `npm run replay:update` after adding or removing a token").toEqual(REPLAY_TOKENS.map((t) => t.symbol).sort());
  });
});

describe.each(REPLAY_TOKENS.filter((t) => loadRecording(t.symbol) !== null))("replay $symbol", (token) => {
  let outcome: ReplayOutcome;

  beforeAll(async () => {
    outcome = await replayScan(loadRecording(token.symbol)!);
    replayed[token.symbol] = outcome.result;
  }, 60_000);

  it("answers, and every upstream request it makes was recorded", () => {
    expect(outcome.status).toBe(200);
    expect(outcome.misses, "the engine now makes a request that is not in the recording: refresh it (scripts/replay/README.md)").toEqual([]);
  });

  it.skipIf(UPDATE)("gives the same verdict, score, flags and facts as the golden file", () => {
    expect(golden[token.symbol], `no golden entry for ${token.symbol}: run \`npm run replay:update\``).toBeDefined();
    expect(outcome.result, `the replayed scan of ${token.symbol} changed. If that is intended, run \`npm run replay:update\` and review the diff of golden.json`).toEqual(golden[token.symbol]);
  });

  it("returns a verdict a human accepts, or is a known issue", () => {
    const accepted = (token.expected as Verdict[]).includes(outcome.result.risk as Verdict);
    if (token.knownIssue) {
      expect(accepted, `${token.symbol} is now ${outcome.result.risk}, which is accepted: it is fixed. Remove its knownIssue (${token.knownIssue.id}).`).toBe(false);
    } else {
      expect(accepted, `${token.symbol}: the engine says ${outcome.result.risk} (${outcome.result.score}); accepted: ${token.expected.join(" or ")}. ${token.why}`).toBe(true);
    }
  });
});

describe("the replay is deterministic", () => {
  it("replaying the same recording twice gives the same result", async () => {
    const rec = loadRecording("BONK");
    if (!rec) return;
    const a = await replayScan(rec);
    const b = await replayScan(rec);
    expect(a.result).toEqual(b.result);
  }, 60_000);
});

afterAll(() => {
  const symbols = Object.keys(replayed);
  if (UPDATE && symbols.length === REPLAY_TOKENS.length) {
    const ordered: Record<string, NormalizedScan> = {};
    for (const t of REPLAY_TOKENS) ordered[t.symbol] = replayed[t.symbol];
    writeFileSync(GOLDEN_FILE, `${JSON.stringify(ordered, null, 2)}\n`);
    console.log(`[replay] golden.json rewritten for ${symbols.length} tokens`);
  }
  if (symbols.length > 0) {
    const ok = REPLAY_TOKENS.filter((t) => replayed[t.symbol] && (t.expected as string[]).includes(replayed[t.symbol].risk));
    const known = REPLAY_TOKENS.filter((t) => t.knownIssue);
    console.log(`[replay] ${ok.length}/${symbols.length} tokens get a verdict a human accepts; ${known.length} known issue(s): ${known.map((t) => `${t.symbol}->${replayed[t.symbol]?.risk} (${t.knownIssue!.id})`).join(", ") || "none"}`);
  }
});
