// __tests__/replay/replay-bulk-summary.test.ts
//
// The two error counts of the bulk corpus that must not get worse (bulk-baseline.json), computed from the golden lines (no
// replay: the golden files are the engine's answers, and `replay:update` is the only thing that rewrites them).
//
//   falseSafeOnDumped  tokens whose market looked dumped from the outside (weak label DANGER or RUG) and that the engine calls SAFE:
//                      a rug waved through. The worst error a scanner can make.
//   falseAlarmOnSafe   tokens that looked overwhelmingly safe (weak label SAFE: very large market, deep liquidity, old) and that the
//                      engine calls DANGER or RUG: a false alarm on a big name, which is what makes users stop trusting the verdict.
//
// The labels are weak (see bulk.ts), so the counts are not zero; what is checked is their DIRECTION. A count that rises fails (the
// engine got worse on the bulk). A count that falls fails too, until the baseline is lowered in the same pull request: an
// improvement is locked in the day it lands, the way a `knownIssue` is removed the day it is fixed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHARDS } from "./bulk";
import { loadBulk } from "./harness";
import { readGolden, UPDATE } from "./bulk-shard";

interface Baseline { falseSafeOnDumped: number; falseAlarmOnSafe: number }
const baseline = JSON.parse(readFileSync(fileURLToPath(new URL("./bulk-baseline.json", import.meta.url)), "utf8")) as Baseline;

describe.skipIf(UPDATE)("the bulk corpus does not get worse", () => {
  const weak = new Map(loadBulk().map((t) => [t.mint, t]));
  const rows: Array<{ symbol: string; weak: string; risk: string }> = [];
  for (let shard = 0; shard < SHARDS; shard++) {
    for (const g of readGolden(shard).values()) rows.push({ symbol: g.symbol, weak: weak.get(g.mint)?.weak ?? "?", risk: g.scan.risk });
  }

  it("prints how the engine's verdicts spread over the weak labels", () => {
    const labels = ["SAFE", "CAUTION", "DANGER", "RUG"];
    const lines = labels.map((w) => `  weak ${w.padEnd(7)} ${labels.map((r) => `${r} ${String(rows.filter((x) => x.weak === w && x.risk === r).length).padStart(4)}`).join("  ")}`);
    console.log(`[replay] bulk: ${rows.length} tokens; rows = weak label, columns = verdict of the engine\n${lines.join("\n")}`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("no more rugs waved through: tokens that looked dumped are not called SAFE", () => {
    const hits = rows.filter((x) => (x.weak === "DANGER" || x.weak === "RUG") && x.risk === "SAFE");
    expect(hits.length, `falseSafeOnDumped is ${hits.length}, the baseline says ${baseline.falseSafeOnDumped}. ${hits.length < baseline.falseSafeOnDumped ? "Improved: lower the baseline in bulk-baseline.json." : `Worse: ${hits.slice(0, 12).map((x) => x.symbol).join(", ")}`}`).toBe(baseline.falseSafeOnDumped);
  });

  it("no more false alarms on big names: tokens that looked overwhelmingly safe are not called DANGER or RUG", () => {
    const hits = rows.filter((x) => x.weak === "SAFE" && (x.risk === "DANGER" || x.risk === "RUG"));
    expect(hits.length, `falseAlarmOnSafe is ${hits.length}, the baseline says ${baseline.falseAlarmOnSafe}. ${hits.length < baseline.falseAlarmOnSafe ? "Improved: lower the baseline in bulk-baseline.json." : `Worse: ${hits.slice(0, 12).map((x) => x.symbol).join(", ")}`}`).toBe(baseline.falseAlarmOnSafe);
  });
});
