// api/_lib/rugcheck.ts — Reading RugCheck's public report summary.
//
// GET /v1/tokens/{mint}/report/summary is about 300 bytes: the list of risks
// RugCheck raised (name, level, a figure in `value` for some), its own score,
// and the share of LP locked. That is all the engine reads. The full report
// (/report, 0.1 to 2.5 MB) is not downloaded: its `risks` list is identical to
// the summary's, and the engine's own validator rejected every real report
// anyway (`topHolders` is a list there, the schema expected an object).
//
// Risk names below are the ones RugCheck actually sends (captured from real
// answers, see __tests__/fixtures/rugcheck-summaries.json), matched exactly and
// case-insensitively. An unknown risk is ignored, never guessed at.

import type { RugCheckRisk, RugCheckSummary } from "./types";

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

/** The risk with this exact name (case-insensitive), if RugCheck raised it. */
export function rugCheckRisk(
  summary: RugCheckSummary | null | undefined,
  name: string,
): RugCheckRisk | undefined {
  if (!summary || !Array.isArray(summary.risks)) return undefined;
  const wanted = norm(name);
  return summary.risks.find((r) => norm(r?.name) === wanted);
}

/** "36.77%" gives 36.77. Null for anything that is not a percentage. */
export function parsePercent(value: unknown): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(String(value ?? ""));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

export interface RugCheckConcentration {
  /**
   * Share of supply held by the largest wallet. RugCheck only raises "Single
   * holder ownership" from about 20%, so null means "below that or unknown",
   * never "verified small".
   */
  top1Pct: number | null;
  /** RugCheck's own level for it: "danger" from about 40%, "warn" from about 20%. */
  top1Level: "danger" | "warn" | null;
  /**
   * The widest top-10 band raised: "High holder concentration" (more than 50%),
   * "Top 10 holders high ownership" (more than 70%), and "High ownership"
   * (the top users hold more than 80%, counted as the 70% band: RugCheck raises
   * it together with the 70% one).
   */
  top10Over: 50 | 70 | null;
}

/**
 * Concentration as RugCheck states it. RugCheck counts liquidity-pool accounts
 * among the holders, so its top-10 bands read higher than the engine's own
 * (MEW: 76% for RugCheck, 65% once pools are excluded). The single-holder risk
 * agreed with the on-chain reading in every case checked (HAWK 43.98%, MEW 36.77%).
 */
export function rugCheckConcentration(
  summary: RugCheckSummary | null | undefined,
): RugCheckConcentration {
  const single = rugCheckRisk(summary, "Single holder ownership");
  // RugCheck has sent "12763.08%" for one token (AXISOL): a share cannot pass 100.
  const parsed = single ? parsePercent(single.value) : null;
  const top1Pct = parsed === null ? null : Math.min(100, parsed);
  const level = norm(single?.level);
  const top1Level = top1Pct === null ? null : level === "danger" ? "danger" : "warn";

  const over70 =
    rugCheckRisk(summary, "Top 10 holders high ownership") !== undefined ||
    rugCheckRisk(summary, "High ownership") !== undefined;
  const over50 = rugCheckRisk(summary, "High holder concentration") !== undefined;
  return { top1Pct, top1Level, top10Over: over70 ? 70 : over50 ? 50 : null };
}
