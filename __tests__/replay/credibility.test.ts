// __tests__/replay/credibility.test.ts
//
// The owner's own judgement, written down where a change to the engine cannot unsay it by accident. Two lists, both of real recorded tokens, both with the reason in the
// owner's words or on facts that do not depend on the engine:
//
//   SERIOUS      real projects the market has proven. The engine must never call them DANGER or RUG (CAUTION is enough: a concentrated top 10, a bridge or a fall from a
//                high is something to say, not something to condemn).
//   NOT FORGIVEN tokens whose insiders already sold. The engine must never call them SAFE or CAUTION, whatever the market cap and the pool say.
//
// It reads the golden files (what the CURRENT engine says on the recorded data), so it needs no network and runs with the rest of the replay. A token is added to a list by
// the owner's word, with the date: the lists are not for the engine to grow by itself. Anything not listed here is not a claim.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GOLDEN_BULK = fileURLToPath(new URL("./golden-bulk/", import.meta.url));

type Verdict = "SAFE" | "CAUTION" | "DANGER" | "RUG";
/** `vetted`: the token is one of the hand-vetted ones (manifest.ts), whose golden verdict is in golden.json under its symbol. */
interface Entry { symbol: string; mint: string; why: string; vetted?: true }

const SERIOUS: Entry[] = [
  { symbol: "CARDS", mint: "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp", why: "Collector Crypt: 31 000 holders, $4M pool, 407 days, -9 % from its all-time high. The owner, 2026-10-15: a serious blue chip, condemned for its top 10." },
  { symbol: "MET", mint: "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL", why: "Meteora: 48 000 holders, $3M pool, 332 days, -45 % from its high. Was RUG for its top 10 (the DEX's own treasuries and vaults)." },
  { symbol: "SPX", mint: "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr", why: "SPX6900 (Wormhole): 76 000 holders, 2.8 years, $2M pool, -84.6 % from its high. The owner, 2026-10-16: a real blue chip; its mint authority is the Wormhole bridge, which nobody holds a key for." },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", vetted: true, why: "Jupiter: 830 000 holders, $1.2B of cap, -84.3 % from its high, a top 10 at 66 % (the DAO and its vesting wallets). The owner, 2026-10-16: the same box as CARDS, a top 10 that is important." },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", vetted: true, why: "Raydium: 266 000 holders, $640M of cap, -89.0 % from its high, a top 10 at 77 % (the protocol's treasuries). The owner, 2026-10-16: the same box as CARDS." },
];

const NOT_FORGIVEN: Entry[] = [
  { symbol: "MELANIA", mint: "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P", why: "-99 % from its all-time high, two insider wallets of 30 %. The owner, 2026-10-15: a scam that already rugged, not credible." },
  { symbol: "LUNA", mint: "9se6kma7LeGcQWyRBNcYzyxZPE3r9t9qWZ8SnjnN3jJ7", why: "Wormhole-wrapped LUNA: -98.4 % from its all-time high. The owner, 2026-10-16: it cannot be CAUTION, it should even be a RUG; a bridge-held mint authority does not change that." },
  { symbol: "TRUNK", mint: "9mV4WUukVsva5wYcYW4veo34CNDiF44sh3Ji65JNdvh5", why: "Wormhole-wrapped TRUNK: -96.3 % from its all-time high. The owner, 2026-10-16: it cannot be CAUTION, it should even be a RUG." },
  { symbol: "YZY", mint: "DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY", why: "-90 % from its all-time high, three insider wallets (27 / 18 / 18 %). The owner, 2026-10-15: a scam that already rugged, not credible." },
  { symbol: "GRIFFAIN", mint: "KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP", why: "-98 % from its all-time high, a top 10 at 49 %, a buy / sell imbalance. The owner, 2026-10-16: a rug the engine left in CAUTION while SPX and CARDS were DANGER, not credible." },
];

function goldenVerdicts(): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const f of readdirSync(GOLDEN_BULK).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of readFileSync(`${GOLDEN_BULK}${f}`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const g = JSON.parse(line) as { mint: string; scan: { risk: Verdict } };
      out.set(g.mint, g.scan.risk);
    }
  }
  return out;
}
/** The hand-vetted tokens (golden.json, keyed by symbol) next to the bulk ones (golden-bulk, keyed by mint). */
const vettedVerdicts = JSON.parse(readFileSync(fileURLToPath(new URL("./golden.json", import.meta.url)), "utf8")) as Record<string, { risk: Verdict }>;
const verdicts = goldenVerdicts();
const verdictOf = (e: Entry): Verdict | undefined => (e.vetted ? vettedVerdicts[e.symbol]?.risk : verdicts.get(e.mint));

describe("credibility: the owner's judgement on real tokens", () => {
  it.each(SERIOUS.map((e) => [e.symbol, e] as const))("%s is serious: never DANGER or RUG", (_s, e) => {
    const v = verdictOf(e);
    expect(v, `${e.symbol} is not in the golden files`).toBeDefined();
    expect(["SAFE", "CAUTION"], `${e.symbol} is ${v}. ${e.why}`).toContain(v);
  });
  it.each(NOT_FORGIVEN.map((e) => [e.symbol, e] as const))("%s already rugged: never SAFE or CAUTION", (_s, e) => {
    const v = verdictOf(e);
    expect(v, `${e.symbol} is not in the golden files`).toBeDefined();
    expect(["DANGER", "RUG"], `${e.symbol} is ${v}. ${e.why}`).toContain(v);
  });
  it("witness: the check can fail (a verdict outside the band is reported)", () => {
    expect(["SAFE", "CAUTION"]).not.toContain("DANGER");
    expect(["DANGER", "RUG"]).not.toContain("CAUTION");
  });
});
