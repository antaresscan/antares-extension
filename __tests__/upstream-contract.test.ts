// __tests__/upstream-contract.test.ts
//
// CONTRACT tests: the engine is run on REAL upstream responses (captured 2026-10-09/10 from the live GoPlus and RugCheck
// APIs, see __tests__/fixtures/upstream-real; the 2.5 MB RugCheck report is trimmed to the keys the engine reads and its
// holder arrays are cut to 3 entries). They exist because the tests used to be written on the same invented contract as
// the code:
//  - the RugCheck /report returns `topHolders` as an ARRAY; the schema expected an object, so EVERY real report was
//    rejected and its holders, creator and risks never reached the engine;
//  - the RugCheck layer read fields the API does not send (lpBurned, mintAuthorityEnabled...) and ignored `risks[]`;
//  - GoPlus' Solana fields (mintable, freezable, trusted_token, holders...) were stripped by the schema;
//  - layers announced themselves "available" without having read anything.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pickGoPlusResult, isRugCheckReport, isValidRugCheckSummary } from "../api/_lib/helpers";
import { layerRugCheck, layerGoPlus, layerSolscan } from "../api/_lib/layers";
import type { RugCheckSummary, RugCheckReport, GoPlusTokenResult } from "../api/_lib/types";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const PAPER = "GesEHJvkMwsaNKKVPowAhDD7P8XooDKtpswTQQ3Fpump";
const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/upstream-real/${name}`, import.meta.url), "utf8"));

describe("RugCheck /report guard accepts the real response", () => {
  it.each(["rugcheck-report-bonk.json", "rugcheck-report-paper.json"])("%s (topHolders is an array)", (name) => {
    const raw = fx(name) as { topHolders: unknown };
    expect(Array.isArray(raw.topHolders)).toBe(true); // the fixture really has the shape that used to be rejected
    expect(isRugCheckReport(raw)).toBe(true);
  });

  it("still accepts the older object shape, and still rejects a wrong type", () => {
    expect(isRugCheckReport({ risks: [], topHolders: { top10Percentage: 25 }, totalHolders: 5 })).toBe(true);
    expect(isRugCheckReport({ topHolders: "nope" })).toBe(false);
  });

  it.each(["rugcheck-summary-bonk.json", "rugcheck-summary-paper.json"])("%s passes the summary guard", (name) => {
    expect(isValidRugCheckSummary(fx(name))).toBe(true);
  });
});

describe("GoPlus Solana fields survive validation", () => {
  it("keeps mintable, freezable, trusted_token, holder_count, holders and pool TVL for BONK", () => {
    const g = pickGoPlusResult(fx("goplus-bonk.json"), BONK) as GoPlusTokenResult;
    expect(g).not.toBeNull();
    expect(g.mintable).toEqual({ authority: [], status: "0" });
    expect((g.freezable as { status: string }).status).toBe("0");
    expect(g.trusted_token).toBe(0);
    expect(g.holder_count).toBe("1024740");
    expect(g.holders).toHaveLength(10);
    expect(g.dex).toHaveLength(10);
    expect(g.dex?.every((d) => d.tvl !== undefined)).toBe(true);
  });

  it("a brand-new token has authorities but no holder_count yet", () => {
    const g = pickGoPlusResult(fx("goplus-paper.json"), PAPER) as GoPlusTokenResult;
    expect(g.mintable).toBeDefined();
    expect(g.holder_count).toBeUndefined();
  });
});

describe("layerRugCheck reads the real risks[]", () => {
  const bonkSummary = fx("rugcheck-summary-bonk.json") as RugCheckSummary;
  const bonkReport = fx("rugcheck-report-bonk.json") as RugCheckReport;
  const risk = (r: object): RugCheckSummary => ({ risks: [r] }) as RugCheckSummary;

  it("turns the real Mutable metadata risk into an info flag (it used to produce nothing)", () => {
    const l = layerRugCheck(bonkSummary, bonkReport, BONK, "Bonk");
    expect(l.available).toBe(true);
    expect(l.flags.map((f) => `${f.severity}:${f.label}`)).toContain("info:Mutable metadata");
    expect(l.trust).toBeCloseTo(0.95, 2);
    expect(l.safeBlocked).toBe(false);
    expect(l.forceRug).toBe(false);
  });

  it("ignores the RugCheck Low Liquidity risk (DexScreener owns that signal) and stays clean for PAPER", () => {
    const l = layerRugCheck(fx("rugcheck-summary-paper.json") as RugCheckSummary, fx("rugcheck-report-paper.json") as RugCheckReport, PAPER, "paper");
    expect(l.available).toBe(true);
    expect(l.flags.filter((f) => f.severity !== "info")).toEqual([]);
  });

  it.each([
    [{ name: "Large Amount of LP Unlocked", value: "", level: "danger" }, "warning", "Large Amount of LP Unlocked"],
    [{ name: "Copycat token", value: "", level: "warn" }, "warning", "Copycat token"],
    [{ name: "Fee config enabled", value: "", level: "warn" }, "warning", "Fee config enabled"],
    [{ name: "Permanent Control Enabled", value: "", level: "danger" }, "critical", "Permanent Control Enabled"],
  ])("maps %j to a %s flag", (r, severity, label) => {
    const l = layerRugCheck(risk(r), null, BONK);
    expect(l.flags.map((f) => `${f.severity}:${f.label}`)).toContain(`${severity}:${label}`);
  });

  it("writes a numeric value once in parentheses, and never doubles parentheses RugCheck already sends", () => {
    expect(layerRugCheck(risk({ name: "High holder correlation", value: "11", level: "warn" }), null, BONK).flags[0].label).toBe("High holder correlation (11)");
    expect(layerRugCheck(risk({ name: "High holder correlation", value: "(11)", level: "warn" }), null, BONK).flags[0].label).toBe("High holder correlation (11)");
  });

  it("an unknown danger risk is a warning, not an automatic critical", () => {
    const l = layerRugCheck(risk({ name: "Single holder ownership", value: "", level: "danger" }), null, BONK);
    expect(l.flags.map((f) => `${f.severity}:${f.label}`)).toContain("warning:RugCheck: Single holder ownership");
    expect(l.flags.some((f) => f.severity === "critical")).toBe(false);
    expect(l.forceRug).toBe(false);
  });

  it("does not turn the mint / freeze authority risks into flags here (the chain decides, elsewhere)", () => {
    const l = layerRugCheck(risk({ name: "Mint Authority still enabled", value: "", level: "danger" }), null, BONK);
    expect(l.flags.some((f) => /mint authority/i.test(f.label))).toBe(false);
  });
});

describe("layers are available only when they read something", () => {
  it("RugCheck: not available for null, {} or an error answer; available for an empty risks list", () => {
    expect(layerRugCheck(null, null, BONK).available).toBe(false);
    expect(layerRugCheck({} as RugCheckSummary, null, BONK).available).toBe(false);
    expect(layerRugCheck({ error: "not found" } as RugCheckSummary, null, BONK).available).toBe(false);
    expect(layerRugCheck({ message: "token not found" } as RugCheckSummary, null, BONK).available).toBe(false);
    expect(layerRugCheck({ risks: [] } as RugCheckSummary, null, BONK).available).toBe(true); // "no risks" is a real answer
  });

  it("GoPlus: not available for null or an empty result; available for a real one", () => {
    expect(layerGoPlus(null).available).toBe(false);
    expect(layerGoPlus({} as GoPlusTokenResult).available).toBe(false);
    const real = pickGoPlusResult(fx("goplus-bonk.json"), BONK) as GoPlusTokenResult;
    const l = layerGoPlus(real);
    expect(l.available).toBe(true);
    expect(l.flags.some((f) => f.severity === "critical")).toBe(false);
  });

  it("Solscan: the age safeguards still apply without Solscan data, but the layer is not a source", () => {
    const withoutSolscan = layerSolscan(null, 0.2, null, null, false); // 12 minutes old, the age comes from DexScreener
    expect(withoutSolscan.available).toBe(false);
    expect(withoutSolscan.safeBlocked).toBe(true);
    expect(withoutSolscan.flags.some((f) => /Newborn token/i.test(f.label) && f.severity === "critical")).toBe(true);
    expect(layerSolscan(null, 0.2, null, null, true).available).toBe(true);
    expect(layerSolscan(null, 0.2, null, null).available).toBe(true); // the default keeps the previous behaviour
  });
});
