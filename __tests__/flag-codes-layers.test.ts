import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  layerRugCheck, layerCrossValidation, judgeContractFacts,
} from "../api/_lib/layers";
import { getLpRiskBucket } from "../api/_lib/lp-risk-matrix";
import {
  legacyReasonsOfLabel, legacyFallbackReasonsOfLabel, codesFromUpstreamText, classifySafeBlockedReasons, classifyByCodes,
} from "../api/_lib/scoring";
import { checkReasonParity } from "../api/_lib/reason-parity";
import { toPublicFlag } from "../api/_lib/pipeline";
import type { AuthorityFacts } from "../api/_lib/facts";
import type { LayerResult, RugCheckSummary, ScanFlag } from "../api/_lib/types";

// Every layer puts on each flag the safe-gate reasons it stands for (ScanFlag.reasons / fallbackReasons). While the text reader still
// decides, these tests prove the codes are exactly what the text reader derives from the labels, on the 140 places that create a flag.

// ─── 1. Every makeFlag of layers.ts, read from the source ─────────────────────────────────────────────────────────────────────
// The recorded tokens only reach the flags their data triggers. This reads the source, so it covers the flags nobody has hit yet.
const BT = String.fromCharCode(96);
const SOURCE = readFileSync(fileURLToPath(new URL("../api/_lib/layers.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const SOURCE_OF: Record<string, string> = {
  layerDexScreener: "dexscreener", layerRugCheck: "rugcheck", judgeContractFacts: "goplus", layerGoPlus: "goplus",
  layerHelius: "helius", layerSolscan: "solscan", layerChart: "chart", layerCrossValidation: "crossvalidation",
};

interface Site { line: number; args: string[]; source: string | undefined }

function readSites(text: string): Site[] {
  const fns: Array<{ line: number; name: string }> = [];
  text.split("\n").forEach((l, i) => { const m = l.match(/^export function (\w+)\(/); if (m) fns.push({ line: i + 1, name: m[1] }); });
  const sites: Site[] = [];
  let idx = 0;
  while ((idx = text.indexOf("makeFlag(", idx)) >= 0) {
    if (/[A-Za-z0-9_$.]/.test(text[idx - 1] ?? " ")) { idx += 9; continue; }
    let i = idx + "makeFlag(".length;
    const args: string[] = [];
    let depth = 0, cur = "";
    const stack: string[] = [];
    for (; i < text.length; i++) {
      const c = text[i];
      const top = stack[stack.length - 1];
      if (stack.length && top !== "expr") {
        cur += c;
        if (c === "\\") { cur += text[++i]; continue; }
        if ((top === "'" && c === "'") || (top === '"' && c === '"')) stack.pop();
        else if (top === BT) {
          if (c === BT) stack.pop();
          else if (c === "$" && text[i + 1] === "{") { cur += text[++i]; stack.push("expr"); }
        }
        continue;
      }
      if (c === "'" || c === '"' || c === BT) { stack.push(c); cur += c; continue; }
      if (top === "expr") {
        if (c === "{") { depth++; cur += c; continue; }
        if (c === "}") { if (depth === 0) { stack.pop(); cur += c; continue; } depth--; cur += c; continue; }
        cur += c; continue;
      }
      if (c === "(" || c === "[" || c === "{") { depth++; cur += c; continue; }
      if (c === ")" || c === "]" || c === "}") {
        if (c === ")" && depth === 0) { args.push(cur.trim()); break; }
        depth--; cur += c; continue;
      }
      if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    const line = text.slice(0, idx).split("\n").length;
    let fn = "";
    for (const f of fns) if (f.line <= line) fn = f.name;
    sites.push({ line, args: args.filter((a, k) => !(k === args.length - 1 && a === "")), source: SOURCE_OF[fn] });
    idx = i;
  }
  return sites;
}

/** The label of a site when it is fixed text or text with numbers in it ("12" stands for a number); null when it is computed. */
function labelOf(arg: string): string | null {
  const q = arg[0];
  if (q === '"' || q === "'") return arg.slice(1, -1);
  if (q === BT) {
    const body = arg.slice(1, -1);
    if (/\$\{[^}]*(tokenName|name\b|"mint"|r\.value)[^}]*\}/.test(body)) return null; // text from outside, or a variant: tested below
    return body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "12");
  }
  return null;
}

/** The array literals of `{ reasons: [...], fallbackReasons: [...] }`. */
function codesOfArg(arg: string | undefined): { reasons: string[]; fallbackReasons: string[] } {
  const pick = (key: string): string[] => {
    const m = arg?.match(new RegExp(`${key}: \\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  };
  return { reasons: pick("reasons"), fallbackReasons: pick("fallbackReasons") };
}

describe("every makeFlag of layers.ts carries the codes the text reader derives from its label", () => {
  const sites = readSites(SOURCE);
  const known = sites.filter((s) => labelOf(s.args[0] ?? "") !== null);

  it("finds the 140 places that create a flag, and most of them have a label that can be checked", () => {
    expect(sites.length).toBe(140);
    expect(known.length).toBeGreaterThan(125);
    expect(sites.every((s) => s.source !== undefined)).toBe(true);
  });

  it("each of them says exactly the reasons and fallback reasons of its label", () => {
    const wrong: string[] = [];
    for (const s of known) {
      const label = labelOf(s.args[0])!;
      const want = { reasons: legacyReasonsOfLabel(label), fallbackReasons: legacyFallbackReasonsOfLabel(s.source!, label) };
      const got = codesOfArg(s.args[3]);
      if (JSON.stringify(want) !== JSON.stringify(got)) wrong.push(`layers.ts:${s.line} ${JSON.stringify(label)} wants ${JSON.stringify(want)}, says ${JSON.stringify(got)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("witness: the check can fail (a site with the wrong codes would be reported)", () => {
    const fake = 'makeFlag("Honeypot detected — cannot sell", "critical", 0, { reasons: ["mint"] })';
    const site = readSites(fake)[0];
    const label = labelOf(site.args[0])!;
    expect(JSON.stringify(codesOfArg(site.args[3]))).not.toBe(JSON.stringify({ reasons: legacyReasonsOfLabel(label), fallbackReasons: [] }));
  });
});

// ─── 2. The flags whose label is computed ─────────────────────────────────────────────────────────────────────────────────────
describe("the LP risk matrix says which reasons each of its labels stands for", () => {
  // The share of supply is a fraction here: 0.45 is 45 %.
  const cases: Array<[string, number | null, number | null]> = [
    ["<1%", 0.004, 24 * 400], ["1-5%", 0.03, 24 * 30], ["5-10%", 0.07, 24 * 30], ["10-15%", 0.12, 24 * 30],
    ["15-30%", 0.2, 24 * 30], ["30-60%", 0.45, 24 * 30], [">60%", 0.8, 24 * 3], ["unknown", null, 24 * 30],
  ];

  it("flagReasons is what the text reader derives from flagLabel, for every bucket", () => {
    for (const [name, pct, age] of cases) {
      const b = getLpRiskBucket(pct, age);
      expect(b.pctBucket, name).toBe(name);
      expect(b.flagReasons, `${name}: ${b.flagLabel}`).toEqual(legacyReasonsOfLabel(b.flagLabel));
    }
  });

  it('the rugcheck fallback has always read every LP label as "lp": the layer says so, and the text reader agrees on all of them', () => {
    for (const [name, pct, age] of cases) {
      const b = getLpRiskBucket(pct, age);
      expect(legacyFallbackReasonsOfLabel("rugcheck", b.flagLabel), name).toEqual(["lp"]);
    }
  });

  it("high and extreme exposure carry both reasons (as the text reader always gave), the others only lp_unverified", () => {
    expect(getLpRiskBucket(0.45, 24 * 30).flagReasons).toEqual(["lp", "lp_unverified"]);
    expect(getLpRiskBucket(0.8, 24 * 3).flagReasons).toEqual(["lp", "lp_unverified"]);
    expect(getLpRiskBucket(0.03, 24 * 30).flagReasons).toEqual(["lp_unverified"]);
  });
});

describe("the flags with a variable label", () => {
  it("cross-validation: a mint conflict stands for mint, a freeze conflict for freeze", () => {
    const facts = { mint: null, freeze: null, sellBlocked: null, trusted: false, source: "chain", compared: true, conflicts: ["mint", "freeze"], riskyExtensions: [] } as unknown as AuthorityFacts;
    const layer = layerCrossValidation(null, [], null, null, null, 0, facts);
    const conflicts = layer.flags.filter((f) => /authority conflict/i.test(f.label));
    expect(conflicts.map((f) => f.reasons)).toEqual([["mint"], ["freeze"]]);
    for (const f of conflicts) expect(f.reasons).toEqual(legacyReasonsOfLabel(f.label));
  });

  it("a token whose NAME says 'Mint authority' does not add the reason mint (the text reader would)", () => {
    const layer = layerRugCheck({ lpBurned: true } as RugCheckSummary, null, "m", "JPMorgan Mint authority");
    const f = layer.flags.find((x) => /^Deceptive name/.test(x.label));
    expect(f, "the impersonation flag is raised").toBeDefined();
    expect(f!.reasons).toEqual(["deceptive_name"]);
    expect(legacyReasonsOfLabel(f!.label)).toEqual(["mint", "deceptive_name"]); // what reading the text gives: the name leaks in
  });

  it("RugCheck's own risk names are read once, when the flag is created, by codesFromUpstreamText", () => {
    const rugData = {
      risks: [
        { name: "Large Amount of LP Unlocked", value: "40%", level: "danger", score: 1 },
        { name: "High holder correlation", level: "warn", score: 1 },
        { name: "Something unheard of about liquidity", level: "danger", score: 1 },
        { name: "Something unheard of", level: "danger", score: 1 },
      ],
    } as unknown as RugCheckSummary;
    const layer = layerRugCheck(rugData, null, "m");
    const fromRisks = layer.flags.filter((f) => /unlocked|correlation|unheard/i.test(f.label));
    expect(fromRisks.length).toBe(4);
    for (const f of fromRisks) {
      const want = codesFromUpstreamText("rugcheck", f.label);
      expect({ reasons: f.reasons ?? [], fallbackReasons: f.fallbackReasons ?? [] }, f.label).toEqual({ reasons: want.reasons ?? [], fallbackReasons: want.fallbackReasons ?? [] });
    }
    expect(fromRisks.find((f) => /LP Unlocked/.test(f.label))!.fallbackReasons).toEqual(["lp"]);
  });

  it("a non-transferable token: the flag stands for no reason, as for the text reader", () => {
    const v = judgeContractFacts({ mint: false, freeze: false, sellBlocked: true, trusted: false, source: "chain", compared: false, conflicts: [], riskyExtensions: [] } as unknown as AuthorityFacts);
    const f = v.flags.find((x) => /Non-transferable/.test(x.label))!;
    expect(f.reasons).toBeUndefined();
    expect(legacyReasonsOfLabel(f.label)).toEqual([]);
  });
});

// ─── 3. The parity check, and the public shape of a flag ──────────────────────────────────────────────────────────────────────
const layerWith = (flags: ScanFlag[], source = "goplus"): LayerResult => ({ source, trust: 1, available: true, flags, forceRug: false, safeBlocked: true });

describe("checkReasonParity", () => {
  const withCodes = layerWith([{ label: "Honeypot detected — cannot sell", severity: "critical", impact: 0, reasons: ["honeypot"] }]);
  const withoutCodes = layerWith([{ label: "Honeypot detected — cannot sell", severity: "critical", impact: 0 }]);

  it("is true when the codes say what the text says", () => {
    expect(checkReasonParity([withCodes], classifySafeBlockedReasons([withCodes]))).toBe(true);
  });

  it("throws in strict mode (the tests) when they differ, and says both answers", () => {
    expect(process.env.ANTARES_STRICT_PARITY).toBe("1");
    expect(() => checkReasonParity([withoutCodes], classifySafeBlockedReasons([withoutCodes]))).toThrow(/codes say \[\].*text says \["honeypot"\]/);
  });

  it("outside strict mode it only reports false: the text answer is the one used", () => {
    const was = process.env.ANTARES_STRICT_PARITY;
    delete process.env.ANTARES_STRICT_PARITY;
    try {
      expect(checkReasonParity([withoutCodes], classifySafeBlockedReasons([withoutCodes]))).toBe(false);
    } finally {
      process.env.ANTARES_STRICT_PARITY = was;
    }
    expect(classifyByCodes([withoutCodes])).toEqual([]);
  });
});

describe("toPublicFlag", () => {
  it("keeps the label, the severity and the impact, and drops the engine's own codes", () => {
    const f: ScanFlag = { label: "x", severity: "critical", impact: 3, reasons: ["lp"], fallbackReasons: ["holders"] };
    expect(toPublicFlag(f)).toStrictEqual({ label: "x", severity: "critical", impact: 3 });
  });
});
