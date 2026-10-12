// contents/modules/verdict-label.ts — The word the overlay prints for a verdict.
//
// Pure function, no DOM, no chrome API. Same rule as js/verdict-label.js on the token page.

const VERDICT_LABELS: Record<string, string> = { SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER" }

/**
 * RUG is two different things, told apart by the API's `rugKind`:
 *   "RUG CONFIRMED"  something happened to the token (its pool was drained while it still traded, or it cannot be sold);
 *   "RUG RISK"       only the token's structure looks like a rug (who holds it, how it is built); nothing has happened yet.
 * A scan cached before the field existed has no kind: it reads as the weaker claim, "RUG RISK". The overlay never prints "RUG PULL"
 * any more: it claimed an event that the engine did not check. Any other verdict keeps its own word.
 */
export function verdictLabel(risk: string, rugKind?: string | null): string {
  if (risk === "RUG") return rugKind === "confirmed" ? "RUG CONFIRMED" : "RUG RISK"
  return VERDICT_LABELS[risk] || risk
}
