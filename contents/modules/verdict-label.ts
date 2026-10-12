// contents/modules/verdict-label.ts — The word the overlay prints for a verdict.
//
// Pure function, no DOM, no chrome API. Same rule as js/verdict-label.js on the token page.

const VERDICT_LABELS: Record<string, string> = { SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER" }

/**
 * RUG is two different things, told apart by the API's `rugKind`:
 *   "RUG PULL"       something happened to the token (its pool was drained while it still traded, or it cannot be sold);
 *   "RUG RISK"       only the token's structure looks like a rug (who holds it, how it is built); nothing has happened yet.
 * A scan cached before the field existed has no kind: it reads as the weaker claim, "RUG RISK". "RUG PULL" says an event happened, so it is
 * printed only when the engine observed one (it used to be printed for every RUG). "RUG CONFIRMED" was tried and is too wide for the overlay
 * (its title is 46 px Bebas Neue in a 262 px box). Any other verdict keeps its own word.
 */
export function verdictLabel(risk: string, rugKind?: string | null): string {
  if (risk === "RUG") return rugKind === "confirmed" ? "RUG PULL" : "RUG RISK"
  return VERDICT_LABELS[risk] || risk
}
