import { describe, it, expect } from "vitest";
import { makeFlag } from "../api/_lib/helpers";
import {
  HARD_BLOCK_PATTERNS,
  classifySafeBlockedReasons,
  classifyByCodes,
  legacyReasonsOfLabel,
  legacyFallbackReasonsOfLabel,
} from "../api/_lib/scoring";
import type { LayerResult, SafeBlockedReason, ScanFlag, Severity } from "../api/_lib/types";

// A flag says which safe-gate reasons it stands for (ScanFlag.reasons), instead of the classifier reading its text with about 25
// regexes. This file proves the reader of the codes (classifyByCodes) and the restructured text reader (classifySafeBlockedReasons)
// both give exactly what the ORIGINAL classifier gave, copied below word for word.

// ─── The original classifier, verbatim (before the codes existed) ─────────────────────────────────────────────────────────────
function originalClassify(layers: LayerResult[]): SafeBlockedReason[] {
  const reasons: SafeBlockedReason[] = [];
  const seen: Record<string, boolean> = {};
  function add(r: SafeBlockedReason) { if (r === "lp" && seen["lp_unverified"]) return; if (!seen[r]) { seen[r] = true; reasons.push(r); } }

  for (const layer of layers) {
    if (!layer.safeBlocked) continue;
    let matched = false;
    for (const flag of layer.flags) {
      for (const entry of HARD_BLOCK_PATTERNS) {
        if (entry[0].test(flag.label)) { add(entry[1]); matched = true; }
      }
    }
    if (!matched) {
      if (layer.source === "dexscreener") {
        for (const f of layer.flags) {
          if (/(?:extreme |coordinated )?pump pattern|parabolic|pump.fun.*exit trap|pump.*newborn/i.test(f.label)) add("pump");
          if (/rug staircase|rug pattern|coordinated dump|dump and run|exit trap|exit liquidity/i.test(f.label)) add("rug_pattern");
          if (/wash/i.test(f.label)) add("wash_trading");
        }
      }
      if (layer.source === "solscan" || layer.source === "helius") {
        for (const f of layer.flags) {
          if (/holder/i.test(f.label) || /wallet.*holds/i.test(f.label) || /top.*hold/i.test(f.label)) add("holders");
          if (/newborn|fresh|age|<\d+h|<\d+min/i.test(f.label)) add("age");
        }
      }
      if (layer.source === "rugcheck") {
        for (const f of layer.flags) {
          if (/LP|liquidity/i.test(f.label)) add("lp");
        }
      }
    }
  }

  return reasons;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const layerOf = (source: string, safeBlocked: boolean, flags: ScanFlag[]): LayerResult => ({ source, trust: 1, available: true, flags, forceRug: false, safeBlocked });

/** The same flag, with the codes the legacy text reader would have derived from its label: what a layer will say once migrated. */
function withCodes(source: string, label: string, severity: Severity = "critical"): ScanFlag {
  return makeFlag(label, severity, 0, { reasons: legacyReasonsOfLabel(label), fallbackReasons: legacyFallbackReasonsOfLabel(source, label) });
}

const stripCodes = (flags: ScanFlag[]): ScanFlag[] => flags.map(({ label, severity, impact }) => ({ label, severity, impact }));

// ─── makeFlag ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("makeFlag carries codes only when it has some", () => {
  it("a flag made the old way is unchanged: three keys, nothing else", () => {
    expect(makeFlag("Honeypot detected", "critical", 0)).toStrictEqual({ label: "Honeypot detected", severity: "critical", impact: 0 });
  });

  it("empty code lists are left out", () => {
    expect(makeFlag("x", "info", 0, { reasons: [], fallbackReasons: [] })).toStrictEqual({ label: "x", severity: "info", impact: 0 });
  });

  it("reasons and fallbackReasons are kept when given", () => {
    const f = makeFlag("Top 10 hold 90% — extreme concentration", "critical", 0, { reasons: ["concentration"], fallbackReasons: ["holders"] });
    expect(f.reasons).toEqual(["concentration"]);
    expect(f.fallbackReasons).toEqual(["holders"]);
  });
});

// ─── classifyByCodes: the rule ────────────────────────────────────────────────────────────────────────────────────────────────
describe("classifyByCodes", () => {
  it("reads the reasons of the flags of a safeBlocked layer, in order, without repeats", () => {
    const layers = [
      layerOf("goplus", true, [makeFlag("a", "critical", 0, { reasons: ["honeypot"] }), makeFlag("b", "critical", 0, { reasons: ["mint", "honeypot"] })]),
      layerOf("chart", true, [makeFlag("c", "warning", 0, { reasons: ["chart"] })]),
    ];
    expect(classifyByCodes(layers)).toEqual(["honeypot", "mint", "chart"]);
  });

  it("ignores a layer that is not safeBlocked, whatever its flags carry", () => {
    expect(classifyByCodes([layerOf("goplus", false, [makeFlag("a", "critical", 0, { reasons: ["honeypot"] })])])).toEqual([]);
  });

  it("uses the fallback reasons of a layer only when none of its flags has a reason", () => {
    const soft = makeFlag("Helius unavailable — holder concentration unverified", "warning", 0, { fallbackReasons: ["holders"] });
    expect(classifyByCodes([layerOf("helius", true, [soft])])).toEqual(["holders"]);
    const hard = makeFlag("Top 10 hold 90% — extreme concentration", "critical", 0, { reasons: ["concentration"], fallbackReasons: ["holders"] });
    expect(classifyByCodes([layerOf("helius", true, [soft, hard])])).toEqual(["concentration"]);
  });

  it("a flag that stands for no reason adds nothing", () => {
    expect(classifyByCodes([layerOf("goplus", true, [makeFlag("LP Burned ✓", "bonus", 0)])])).toEqual([]);
  });

  it('keeps the old rule: "lp" is dropped once "lp_unverified" is in, but "lp_unverified" after "lp" stays', () => {
    const unverifiedFirst = [layerOf("rugcheck", true, [makeFlag("a", "warning", 0, { reasons: ["lp_unverified"] }), makeFlag("b", "critical", 0, { reasons: ["lp"] })])];
    expect(classifyByCodes(unverifiedFirst)).toEqual(["lp_unverified"]);
    const hardFirst = [layerOf("rugcheck", true, [makeFlag("b", "critical", 0, { reasons: ["lp"] }), makeFlag("a", "warning", 0, { reasons: ["lp_unverified"] })])];
    expect(classifyByCodes(hardFirst)).toEqual(["lp", "lp_unverified"]);
  });

  it("witness: the text of a flag does not matter, only its codes", () => {
    const f = makeFlag("Honeypot detected — cannot sell", "critical", 0); // text says honeypot, no code says so
    expect(classifyByCodes([layerOf("goplus", true, [f])])).toEqual([]);
    expect(classifySafeBlockedReasons([layerOf("goplus", true, [f])])).toEqual(["honeypot"]);
  });
});

// ─── The labels the engine really produces: one per kind of case ──────────────────────────────────────────────────────────────
const LABELS: Array<[string, Severity]> = [
  ["Honeypot detected — cannot sell", "critical"],
  ["Cannot sell all tokens", "critical"],
  ["Mint authority active — supply can be inflated", "critical"],
  ["Freeze authority active — wallets can be frozen", "critical"],
  ["LP not burned or locked — dev can rug liquidity (contract not clean)", "critical"],
  ["LP holds 12% of supply — negligible rug risk", "info"],
  ["LP-to-supply ratio could not be computed", "warning"],
  ["LP Burned ✓", "bonus"],
  ["LP Locked > 180 days ✓", "bonus"],
  ["LP lock duration < 30 days", "warning"],
  ["Wash trading detected (vol/liq > 15) — bundler dump", "critical"],
  ["High vol/liquidity ratio (>10×) — probable wash volume", "critical"],
  ["Extreme pump +12% in 1h + structural weakness — bundler exit trap", "critical"],
  ["Pump +12% on newborn token (<2h) + structural weakness — exit trap", "critical"],
  ["Pump +12% on newborn token (<1h)", "warning"],
  ["Coordinated pump pattern", "warning"],
  ["Extreme 24h pump +12% — exit liquidity trap", "critical"],
  ["Crashcoin pattern: near-perfect parabolic chart", "warning"],
  ["Parabolic launch: high risk exit liquidity setup", "warning"],
  ["Liquidity mirage: volume >> liquidity (wash)", "critical"],
  ["Blow-off top: price collapsed >55% from peak", "critical"],
  ["Early volume exhaustion near highs", "warning"],
  ["Buy/sell imbalance (coordinated pump)", "warning"],
  ["Bundle holds ~12% of supply — coordinated buy/dump", "critical"],
  ["Bundler detected (RugCheck summary)", "critical"],
  ["Sniper activity detected", "critical"],
  ["Deceptive name — impersonates real institution: \"X\"", "critical"],
  ["Very few holders (<15)", "critical"],
  ["Low holders (<50)", "warning"],
  ["Top 10 hold 12% — extreme concentration", "critical"],
  ["Top 10 hold 12% — high concentration · control risk", "critical"],
  ["Top 10 hold 12% — elevated · exchanges may be included", "warning"],
  ["Top 10 hold 12% — moderate concentration", "warning"],
  ["Top 10 hold 12% — moderate · exchanges likely included", "info"],
  ["Single wallet holds 12% — high concentration · young token", "critical"],
  ["Single wallet holds 12% — elevated concentration · young token", "warning"],
  ["Helius unavailable — holder concentration unverified", "warning"],
  ["Holder data unreliable (broken upstream view) — mature pair, deep liquidity", "info"],
  ["Strong holder base (5K+) ✓", "bonus"],
  ["Newborn token on-chain (<30min)", "critical"],
  ["Fresh token on-chain (<6h)", "warning"],
  ["Bot-farmed holders: many accounts, near-zero activity", "warning"],
  ["Established token (30d+) ✓", "bonus"],
  ["Very low liquidity (<$1k)", "critical"],
  ["No website / Twitter / Telegram — high rug risk", "critical"],
  ["RugCheck: Top 10 holders high ownership", "warning"],
  ["Mutable metadata", "info"],
];
const SOURCES = ["dexscreener", "rugcheck", "goplus", "helius", "solscan", "chart", "crossvalidation"];

// Deterministic pseudo-random numbers, so a failure can be replayed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the three classifiers agree on every combination of real labels", () => {
  const random = rng(20261011);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
  const cases: LayerResult[][] = [];
  for (let n = 0; n < 4000; n++) {
    const layerCount = 1 + Math.floor(random() * 5);
    const layers: LayerResult[] = [];
    for (let i = 0; i < layerCount; i++) {
      const source = pick(SOURCES);
      const flagCount = Math.floor(random() * 5);
      const flags: ScanFlag[] = [];
      for (let j = 0; j < flagCount; j++) {
        const [label, severity] = pick(LABELS);
        flags.push(withCodes(source, label, severity));
      }
      layers.push(layerOf(source, random() < 0.8, flags));
    }
    cases.push(layers);
  }

  it("the restructured text reader gives what the original gave (4000 random sets of layers)", () => {
    for (const layers of cases) {
      const plain = layers.map((l) => ({ ...l, flags: stripCodes(l.flags) }));
      expect(classifySafeBlockedReasons(plain)).toEqual(originalClassify(plain));
    }
  });

  it("the reader of the codes gives what the original gave, in the same order (4000 random sets of layers)", () => {
    for (const layers of cases) {
      const plain = layers.map((l) => ({ ...l, flags: stripCodes(l.flags) }));
      expect(classifyByCodes(layers)).toEqual(originalClassify(plain));
    }
  });

  it("the sample is not trivial: it holds sets with no reason, one reason and several", () => {
    const sizes = cases.map((layers) => originalClassify(layers.map((l) => ({ ...l, flags: stripCodes(l.flags) }))).length);
    expect(sizes.filter((s) => s === 0).length).toBeGreaterThan(100);
    expect(sizes.filter((s) => s === 1).length).toBeGreaterThan(100);
    expect(sizes.filter((s) => s >= 3).length).toBeGreaterThan(100);
  });
});
