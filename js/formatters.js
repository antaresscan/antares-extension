// js/formatters.js — Pure formatting helpers used across the token page.
//
// Everything here is a pure function: same input → same output, no DOM,
// no network, no globals. That makes the module trivially testable and
// reusable from any view-builder.
//
// History note: prior to the modular split these helpers lived inline
// in token-app.js. Two `formatAge` declarations (one taking hours, one
// taking minutes) coexisted at script scope, and the later definition
// silently overrode the earlier one for every call site — so the
// on-chain "Token Age" cell was rendering hours as if they were minutes
// (a 30-day-old token displayed "12h"). The split here fixes that bug
// by giving each function a distinct name (`formatAgeHours` vs
// `formatAgeMin`) and forcing each call site to be explicit.

/** Format a USD amount with K / M / B suffixes. Negative values are
 *  unsigned — callers add their own +/- prefix. Returns "—" for null/undef. */
export function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Format a percentage delta with sign + class for colour-coding.
 *  Returns { txt: "+2.34%" | "-1.20%" | "—", cls: "up" | "dn" | "neu" }. */
export function pct(n) {
  if (n == null) return { txt: "—", cls: "neu" };
  const s = n > 0 ? "+" : "";
  const cls = n > 0 ? "up" : n < 0 ? "dn" : "neu";
  return { txt: `${s}${n.toFixed(2)}%`, cls };
}

/** Compact age label with "old" suffix — used in the hero badge.
 *  Returns null when no age input. Examples: "12h old", "3d old", "2mo old". */
export function age(h) {
  if (!h) return null;
  if (h < 24) return `${Math.round(h)}h old`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d old`;
  return `${Math.floor(d / 30)}mo old`;
}

/** Format a token unit price. Picks the right precision based on
 *  magnitude so "0.0000023" stays readable rather than rounding to 0. */
export function fmtPrice(p) {
  if (!p) return "—";
  const n = parseFloat(p);
  if (n < 0.000001) return `$${n.toExponential(2)}`;
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Detailed age formatter for HOURS input. Used by the on-chain "Token Age"
 * cell. Returns "30m", "5h", "3d", or "5d 4h" depending on magnitude.
 *
 * Prior to the modular split this was the first declaration of `formatAge`
 * in token-app.js — silently shadowed at runtime by a second declaration
 * that took minutes. Renamed `formatAgeHours` here to make the contract
 * explicit at every call site.
 */
export function formatAgeHours(hours) {
  if (!hours && hours !== 0) return null;
  if (hours < 1) return Math.round(hours * 60) + "m";
  if (hours < 24) return Math.round(hours) + "h";
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

/**
 * Compact age formatter for MINUTES input. Used by the Insider Watch
 * activity feed where each entry's `ageMin` is supplied by the backend.
 * Returns "just now", "12min", "3h", or "2d".
 *
 * Prior to the modular split this was the second declaration of
 * `formatAge` in token-app.js — overrode the hours variant for every
 * call site, breaking the on-chain Token Age cell. Renamed
 * `formatAgeMin` here to fix that.
 */
export function formatAgeMin(min) {
  if (typeof min !== "number" || !Number.isFinite(min)) return "—";
  if (min < 1) return "just now";
  if (min < 60) return min + "min";
  const h = Math.floor(min / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

/** Escape HTML entities for safe interpolation into innerHTML strings.
 *  Returns "" for null/undef/empty. Mirrors the encodeURIComponent pattern. */
export function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

/** Escape HTML entities but re-allow bare `<b>` and `</b>` tags only.
 *  Used for backend-supplied descriptive strings that intentionally emphasise
 *  a numeric span (e.g. "Holds <b>3.2%</b> of supply"). Any other tag — and
 *  even <b> with attributes like `<b class=x>` — stays escaped, so a
 *  compromised upstream cannot inject `<script>`, `<iframe>`, `<b onclick=…>`
 *  or `<b/onmouseover=…>`. Safe by default; allows the one specific shape
 *  the API contract documents. */
export function escapeHtmlAllowBold(str) {
  if (!str) return "";
  const esc = escapeHtml(str);
  return esc.replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>");
}

/** Compact USD formatter — like `fmt` but with M/K rounding optimised for
 *  the activity feed (which displays signed values, smaller magnitudes). */
export function fmtUsd(v) {
  const a = Math.abs(v);
  if (a >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (a >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + a.toFixed(0);
}

/** Compact token-amount formatter without dollar prefix. Returns "—"
 *  when the input isn't a finite number. */
export function fmtTok(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (a >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return v.toFixed(0);
}

// ─── Flag descriptions ──────────────────────────────────────────────────────
// Plain-language explanations for every critical/warning flag the backend
// emits. Keys match the exact `flag.label` strings produced by the layers
// pipeline. `getFlagDescription` falls back to a prefix match so minor
// label tweaks (parenthetical source suffixes, percentage values) still
// resolve to the right description.
export const FLAG_DESCRIPTIONS = {
  "Mint Authority enabled": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Mint Authority enabled (RugCheck)": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Freeze Authority enabled": "The dev can freeze your wallet and prevent you from selling.",
  "Freeze Authority enabled (RugCheck)": "The dev can freeze your wallet and prevent you from selling.",
  "LP not burned or locked": "The dev can pull all liquidity in one transaction and crash the price to zero.",
  "LP not burned but token is mature and liquid (unverified LP)": "Liquidity is not locked — the dev can still rug at any time.",
  "Honeypot detected — cannot sell": "You cannot sell this token. Any funds spent are gone.",
  "Bundle activity detected": "Coordinated wallets bought together to fake demand — classic pump and dump setup.",
  "Bundle holds": "A coordinated group controls a large portion of supply and can dump at will.",
  "Sniper activity detected": "Bots bought massively at launch before anyone else could — supply is concentrated.",
  "Top 10 holders > 70%": "Ten wallets control over 70% of the supply. If they sell together, the price collapses.",
  "Top 10 holders > 50%": "Half the supply is in 10 wallets — high dump risk.",
  "Single wallet holds": "One wallet controls a huge portion of supply and can crash the price alone.",
  "Metadata mutable": "The dev can change the token name, symbol and logo after launch — common in rug setups.",
  "Helius unavailable — holder concentration unverified": "Holder-distribution data was not available for this scan, so a very large wallet cannot be ruled out. The verdict is capped at CAUTION until it can be checked: re-scan in a moment.",
  "Wash trading detected": "The trading volume is fake — bots trading with themselves to create false activity.",
  "Sell tax": "A hidden fee is taken every time you sell — often used to bleed holders slowly.",
  "Buy tax": "A fee is taken on every purchase — used to fund the dev or prevent exits.",
  "Owner holds > 5%": "The owner wallet holds a large stake and can dump it at any time.",
  "Creator holds > 5%": "The creator wallet holds a large stake and can dump it at any time.",
  "Blacklist capability": "The dev can blacklist specific wallets and prevent them from selling.",
  "Transfer pausable": "The dev can pause all transfers, trapping everyone's funds.",
  "Hidden owner": "The real owner of the contract is hidden — a known red flag for rug pulls.",
  "Upgradeable/proxy contract": "The contract code can be replaced after launch — any security audit becomes worthless.",
  "LP Burned ✓": "The liquidity is permanently burned. The dev cannot pull it.",
  "Well distributed supply ✓": "The token supply is well spread across many wallets — good sign.",
  "Strong holder base (5K+) ✓": "Over 5000 holders — strong community adoption signal.",
  "Established token (30d+) ✓": "The token has survived over 30 days — most rugs die within hours.",
};

/** Resolve a plain-language description for a flag label. Tries exact match
 *  first, then prefix-match so suffixed variants (e.g. "Single wallet holds 18%")
 *  still resolve to the base description. Returns null when no match. */
export function getFlagDescription(label) {
  if (FLAG_DESCRIPTIONS[label]) return FLAG_DESCRIPTIONS[label];
  for (const key of Object.keys(FLAG_DESCRIPTIONS)) {
    if (label.toLowerCase().startsWith(key.toLowerCase())) return FLAG_DESCRIPTIONS[key];
  }
  return null;
}
