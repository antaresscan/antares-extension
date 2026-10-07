// __tests__/rugcheck.test.ts
//
// RugCheck's summary, read the way RugCheck actually sends it. The layer used to
// read fields the summary never had (lpBurned, topHolders.top10Percentage,
// mintAuthorityEnabled...) and every test fed it those invented fields, so the
// layer was "available", scored 1.0 and said nothing for every real token. These
// tests use real answers (fixtures/rugcheck-summaries.json, captured from
// api.rugcheck.xyz, not edited).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePercent, rugCheckConcentration, rugCheckRisk } from "../api/_lib/rugcheck";
import { layerRugCheck, layerHelius } from "../api/_lib/layers";
import { classifySafeBlockedReasons } from "../api/_lib/scoring";
import { determineVerdict } from "../api/_lib/pipeline";
import { isValidRugCheckSummary } from "../api/_lib/helpers";
import type { RugCheckSummary } from "../api/_lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "rugcheck-summaries.json"), "utf8"),
) as { summaries: Record<string, { mint: string; summary: RugCheckSummary }> };

const real = (key: string): RugCheckSummary => {
  const entry = FIXTURES.summaries[key];
  if (!entry) throw new Error(`no fixture ${key}`);
  return entry.summary;
};

const labels = (r: { flags: Array<{ label: string }> }) => r.flags.map((f) => f.label);
const severities = (r: { flags: Array<{ severity: string }> }) => r.flags.map((f) => f.severity);

describe("fixtures", () => {
  it("are real RugCheck summaries: every one has the keys the API sends and none of the invented ones", () => {
    for (const [key, { summary }] of Object.entries(FIXTURES.summaries)) {
      expect(Array.isArray(summary.risks), key).toBe(true);
      expect(typeof summary.score, key).toBe("number");
      expect(typeof summary.score_normalised, key).toBe("number");
      for (const invented of ["lpBurned", "lpLocked", "metaMutable", "topHolders", "mintAuthorityEnabled", "freezeAuthorityEnabled"]) {
        expect(summary, `${key} must not have ${invented}`).not.toHaveProperty(invented);
      }
    }
  });
});

describe("isValidRugCheckSummary", () => {
  it("accepts every real summary", () => {
    for (const [key, { summary }] of Object.entries(FIXTURES.summaries)) {
      expect(isValidRugCheckSummary(summary), key).toBe(true);
    }
  });

  it("accepts RugCheck's error answer, which scan.ts treats as 'not found'", () => {
    expect(isValidRugCheckSummary({ error: "unable to generate report" })).toBe(true);
  });

  it("rejects things that are not a summary", () => {
    expect(isValidRugCheckSummary(null)).toBe(false);
    expect(isValidRugCheckSummary("summary")).toBe(false);
    expect(isValidRugCheckSummary({})).toBe(false);
    expect(isValidRugCheckSummary({ lpBurned: true })).toBe(false);
    expect(isValidRugCheckSummary({ risks: { not: "an array" } })).toBe(false);
    expect(isValidRugCheckSummary({ risks: [{ name: "x", score: "10" }] })).toBe(false);
  });
});

describe("reading helpers", () => {
  it("rugCheckRisk matches the exact name, case-insensitively", () => {
    expect(rugCheckRisk(real("BONK"), "mutable METADATA")?.level).toBe("warn");
    expect(rugCheckRisk(real("BONK"), "Mutable")).toBeUndefined(); // not a substring match
    expect(rugCheckRisk(null, "Mutable metadata")).toBeUndefined();
    expect(rugCheckRisk({}, "Mutable metadata")).toBeUndefined();
  });

  it("parsePercent reads RugCheck's figures", () => {
    expect(parsePercent("36.77%")).toBeCloseTo(36.77, 5);
    expect(parsePercent(" 30.00% ")).toBe(30);
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("$2410.49")).toBeNull();
    expect(parsePercent(undefined)).toBeNull();
  });

});

describe("rugCheckConcentration", () => {
  it("reads HAWK (a rug): one wallet at 43.98%, danger, and a top-10 above 50%", () => {
    expect(rugCheckConcentration(real("HAWK"))).toEqual({ top1Pct: 43.98, top1Level: "danger", top10Over: 50 });
  });

  it("reads MEW: 36.77% is only a warning for RugCheck", () => {
    expect(rugCheckConcentration(real("MEW"))).toEqual({ top1Pct: 36.77, top1Level: "warn", top10Over: 50 });
  });

  it("reads TRUMP: the 70% band, and 'High ownership' counts as the same band", () => {
    expect(rugCheckConcentration(real("TRUMP"))).toEqual({ top1Pct: 72.69, top1Level: "danger", top10Over: 70 });
  });

  it("reads nothing where RugCheck raised nothing", () => {
    for (const key of ["WIF", "BONK", "MYRO", "USDC", "HORNY"]) {
      expect(rugCheckConcentration(real(key)), key).toEqual({ top1Pct: null, top1Level: null, top10Over: null });
    }
  });

  it("caps an absurd figure: RugCheck sent 12763.08% for one token", () => {
    const c = rugCheckConcentration(real("SINGLE_HOLDER_OVER_100"));
    expect(c.top1Pct).toBe(100);
    expect(c.top1Level).toBe("danger");
  });
});

describe("layerRugCheck on real summaries", () => {
  it("is unavailable, not clean, when there is no usable summary", () => {
    for (const bad of [null, {}, { error: "unable to generate report" }, { score: 5 }] as Array<RugCheckSummary | null>) {
      const r = layerRugCheck(bad);
      expect(r.available).toBe(false);
      expect(r.flags[0].label).toBe("RugCheck unavailable");
    }
  });

  it("says nothing about a token RugCheck found nothing on (WIF)", () => {
    const r = layerRugCheck(real("WIF"));
    expect(r).toMatchObject({ available: true, trust: 1, forceRug: false, safeBlocked: false });
    expect(r.flags).toEqual([]);
  });

  it("only notes the mutable metadata on BONK, as information", () => {
    const r = layerRugCheck(real("BONK"));
    expect(labels(r)).toEqual(["Metadata mutable"]);
    expect(severities(r)).toEqual(["info"]);
    expect(r.trust).toBeCloseTo(0.9, 5);
    expect(r.safeBlocked).toBe(false);
  });

  it("flags a creator with a history of rugs as critical and closes the safe gate", () => {
    const r = layerRugCheck(real("CREATOR_RUGGED"));
    const flag = r.flags.find((f) => /creator history/i.test(f.label));
    expect(flag?.severity).toBe("critical");
    expect(r.safeBlocked).toBe(true);
  });

  it("does not flag the mint / freeze authority yet: RugCheck raises it on issuer-controlled assets", () => {
    // 118 of the 506 corpus tokens carry "Mint Authority still enabled", among them
    // USDG, CASH, ORCA and the tokenized stocks. The engine flags no authority today
    // (the GoPlus layer reads fields its Solana answer does not have), and switching
    // RugCheck's on alone would turn 19 of the 43 SAFE-labelled tokens DANGER.
    for (const key of ["MINT_AND_FREEZE", "MINT_ONLY"]) {
      const r = layerRugCheck(real(key));
      expect(r.flags.filter((f) => f.severity !== "info"), key).toEqual([]);
      expect(r.safeBlocked, key).toBe(false);
    }
  });

  it("leaves out the risks other layers measure better or that fire on legitimate assets", () => {
    // A dead pool (LP unlocked, low liquidity, few LP providers), a copycat, a
    // symbol mismatch and a low-liquidity token: none of them becomes a flag here.
    for (const key of ["DEAD_POOL_IGNORED_RISKS", "COPYCAT", "SYMBOL_MISMATCH", "HORNY"]) {
      const r = layerRugCheck(real(key));
      expect(r.flags.filter((f) => f.severity !== "info"), key).toEqual([]);
      expect(r.trust, key).toBeGreaterThan(0.89);
    }
  });

  describe("deceptive names (unchanged)", () => {
    it("'Vanguard' in the name closes the safe gate", () => {
      const r = layerRugCheck(real("WIF"), "Vanguard Digital Oil Reserve");
      expect(r.safeBlocked).toBe(true);
      expect(labels(r).some((l) => /deceptive name/i.test(l))).toBe(true);
    });

    it("'BlackRock' in the name closes the safe gate", () => {
      expect(layerRugCheck(real("WIF"), "BlackRock Treasury Token").safeBlocked).toBe(true);
    });

    it("an ordinary name does not", () => {
      expect(labels(layerRugCheck(real("WIF"), "Bonk")).some((l) => /deceptive name/i.test(l))).toBe(false);
    });
  });
});

describe("layerRugCheck holder concentration", () => {
  it("adds nothing while the engine has its own holder list: the finer reading wins, wallets are not counted twice", () => {
    for (const key of ["HAWK", "MEW", "TRUMP", "PIPPIN", "PNUT"]) {
      const r = layerRugCheck(real(key), null, true);
      expect(r.flags.filter((f) => /wallet holds|top 10/i.test(f.label)), key).toEqual([]);
      expect(r.safeBlocked, key).toBe(false);
    }
    // and holderDataAvailable defaults to true
    expect(layerRugCheck(real("HAWK")).flags).toEqual([]);
  });

  it("without a holder list, HAWK's 44% wallet is critical and a hard concentration reason", () => {
    const r = layerRugCheck(real("HAWK"), null, false);
    expect(labels(r)).toEqual(
      expect.arrayContaining(["Single wallet holds 44% — high concentration (RugCheck)", "Top 10 holders > 50% (RugCheck)"]),
    );
    expect(r.flags.find((f) => /single wallet/i.test(f.label))?.severity).toBe("critical");
    expect(r.flags.find((f) => /top 10/i.test(f.label))?.severity).toBe("warning");
    expect(r.safeBlocked).toBe(true);
    expect(classifySafeBlockedReasons([r])).toEqual(expect.arrayContaining(["concentration", "concentration_light"]));
  });

  it("without a holder list, MEW's 37% wallet is only a soft warning", () => {
    const r = layerRugCheck(real("MEW"), null, false);
    expect(labels(r)).toContain("Single wallet holds 37% — elevated (RugCheck)");
    expect(r.flags.some((f) => f.severity === "critical")).toBe(false);
    expect(classifySafeBlockedReasons([r])).toEqual(["concentration_light"]);
  });

  it("without a holder list, TRUMP's 70% band is critical and hard", () => {
    const r = layerRugCheck(real("TRUMP"), null, false);
    expect(labels(r)).toEqual(
      expect.arrayContaining(["Single wallet holds 73% — high concentration (RugCheck)", "Top 10 holders > 70% (RugCheck)"]),
    );
    expect(classifySafeBlockedReasons([r])).toContain("concentration");
    expect(r.trust).toBeLessThan(0.3);
  });

  it("shows a capped figure for the absurd 12763.08% value", () => {
    const r = layerRugCheck(real("SINGLE_HOLDER_OVER_100"), null, false);
    expect(labels(r)).toContain("Single wallet holds 100% — high concentration (RugCheck)");
  });

  it("adds nothing for tokens RugCheck raised no concentration on, even without a holder list", () => {
    for (const key of ["WIF", "BONK", "MYRO"]) {
      const r = layerRugCheck(real(key), null, false);
      expect(r.flags.filter((f) => /wallet holds|top 10/i.test(f.label)), key).toEqual([]);
    }
  });
});

describe("what changes for the verdict when Helius is down", () => {
  // Before: with no holder list the engine capped every token at CAUTION, a rug
  // like HAWK included, even though RugCheck itself said "danger". Now RugCheck's
  // concentration is the fallback reading.
  const heliusDown = layerHelius([], 0);

  it("HAWK was CAUTION without RugCheck's reading and is DANGER with it", () => {
    expect(heliusDown.available).toBe(false);
    expect(heliusDown.safeBlocked).toBe(true);

    const withoutRugCheck = determineVerdict({
      score: 820,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: classifySafeBlockedReasons([heliusDown]),
      sourcesUsedCount: 4,
      warningFlagsCount: 0,
      criticalFlagsCount: 0,
    });
    expect(withoutRugCheck).toBe("CAUTION");

    const rug = layerRugCheck(real("HAWK"), null, false);
    const layers = [heliusDown, rug];
    const verdict = determineVerdict({
      score: 820,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: classifySafeBlockedReasons(layers),
      sourcesUsedCount: 4,
      warningFlagsCount: rug.flags.filter((f) => f.severity !== "info").length,
      criticalFlagsCount: rug.flags.filter((f) => f.severity === "critical").length,
    });
    expect(classifySafeBlockedReasons(layers)).toEqual(expect.arrayContaining(["holders", "concentration"]));
    expect(verdict).toBe("DANGER");
  });

  it("a clean token stays capped at CAUTION: RugCheck's silence does not verify the holders", () => {
    const rug = layerRugCheck(real("WIF"), null, false);
    expect(rug.flags).toEqual([]);
    const reasons = classifySafeBlockedReasons([heliusDown, rug]);
    expect(reasons).toEqual(["holders"]);
    expect(
      determineVerdict({
        score: 820,
        forceRug: false,
        safeBlocked: true,
        safeBlockedReasons: reasons,
        sourcesUsedCount: 4,
        warningFlagsCount: 0,
        criticalFlagsCount: 0,
      }),
    ).toBe("CAUTION");
  });
});
