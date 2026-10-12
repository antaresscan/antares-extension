// js/verdict-label.js — The word the token page prints for a verdict.
//
// Pure function, no DOM, no network. It lives in its own file (and not in formatters.js) on purpose: /js/* is cached for 5 minutes, and a
// browser holding the old formatters.js next to the new token-app.js would fail to link a missing export and show a blank page. A new
// file has no old copy in any cache.

const VERDICT_LABELS = { SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER" };

/** RUG is two different things, told apart by the API's `rugKind`:
 *    "RUG PULL"       something happened to the token (its pool was drained while it still traded, or it cannot be sold);
 *    "RUG RISK"       only the token's structure looks like a rug (who holds it, how it is built); nothing has happened yet.
 *  A scan cached before the field existed has no kind: it reads as the weaker claim, "RUG RISK". "RUG PULL" says an event happened, so it is
 *  printed only when the engine observed one (it used to be printed for every RUG); the same two words as the overlay. Any other verdict
 *  keeps its own word. */
export function verdictLabel(risk, rugKind) {
  if (risk === "RUG") return rugKind === "confirmed" ? "RUG PULL" : "RUG RISK";
  return VERDICT_LABELS[risk] || risk;
}
