// js/compute.js — Pure business-logic helpers for the token page.
//
// These functions translate raw /api/scan response fields into the
// shapes the views need to render. They are deterministic — same input
// always produces same output, no DOM, no clock, no network — so they
// move out of the view-builder file and become unit-testable without
// any browser harness.

/**
 * Derive the 5 score-breakdown dimensions from the /api/scan payload.
 * The radar chart and the breakdown bars both consume this shape.
 *
 *   LP Security        — 100 if burned, 70 if locked, 0 if open, null otherwise
 *   Holder Distribution — 100 - top10HolderPct (clamp 0-100)
 *   Trading Authenticity — vol/liq < 5 = healthy; higher = wash risk
 *   Token Maturity     — age_hours / 720 (1 month) * 100
 *   Source Consensus   — average trust across all available layers
 *
 * Any dimension returns null when the underlying signal is missing —
 * the radar then renders that axis pegged to 0 visually but flagged
 * "—" in the bars.
 *
 * @param {object} d  /api/scan response object.
 * @returns {{
 *   lp: number | null,
 *   holders: number | null,
 *   trading: number | null,
 *   maturity: number | null,
 *   sources: number | null,
 *   total: number,
 * }}
 */
export function computeScoreBreakdown(d) {
  let lp = null;
  if (d.lpBurned === true) lp = 100;
  else if (d.lpLocked === true) lp = 70;
  else if (d.lpBurned === false || d.lpLocked === false) lp = 0;

  const top10 = typeof d.top10HolderPct === "number" ? d.top10HolderPct : null;
  const holders =
    top10 != null
      ? Math.max(0, Math.min(100, Math.round(100 - top10)))
      : null;

  const liq = d.liquidity ?? d.pair?.liquidity?.usd ?? null;
  const vol = d.volume24h ?? d.pair?.volume?.h24 ?? null;
  let trading = null;
  if (liq && vol && liq > 0) {
    const ratio = vol / liq;
    trading = ratio < 5 ? 100 : Math.max(0, Math.round(100 - (ratio - 5) * 8));
  }

  const ageH = d.solscanTokenAgeHours ?? null;
  const maturity =
    ageH != null ? Math.min(100, Math.round((ageH / 720) * 100)) : null;

  const layers = d.layers || {};
  const layerArr = Object.values(layers).filter((l) => l && l.available);
  const sources =
    layerArr.length > 0
      ? Math.round(
          (layerArr.reduce((a, l) => a + (l.trust || 0), 0) /
            layerArr.length) *
            100,
        )
      : null;

  return { lp, holders, trading, maturity, sources, total: d.score || 0 };
}

/**
 * Estimate slippage cost at five sell sizes using a constant-product
 * AMM model. Returns null when the LP figure is missing so the caller
 * can hide the tab gracefully.
 *
 * Slippage model: with L = total USD liquidity (both sides), the quote
 * reserve is L/2. For a sell of `amount` USD against that reserve, the
 * slippage is `amount / (amount + L/2)` — a closed-form approximation
 * that's within a few bps of the true Uniswap-style x*y=k math at the
 * sizes we report.
 *
 * @param {number | null} liqUsd  Total USD liquidity on the pair.
 * @returns {Array<{
 *   amount: number,
 *   slipDisplay: string,
 *   widthPct: number,
 *   cls: 'ok' | 'warn' | 'bad',
 *   note: string,
 * }> | null}
 */
export function computeExitLiquidity(liqUsd) {
  if (!liqUsd || liqUsd <= 0) return null;
  const tiers = [100, 1000, 5000, 10000, 20000];
  return tiers.map((amount) => {
    const slippagePct = (amount / (amount + liqUsd / 2)) * 100;
    const lostUsd = amount * (slippagePct / 100);
    let cls;
    let note;
    if (slippagePct < 3) {
      cls = "ok";
      note = "Easy exit";
    } else if (slippagePct < 8) {
      cls = "ok";
      note = "Acceptable";
    } else if (slippagePct < 20) {
      cls = "warn";
      note = `<b>${fmtUsdRough(lostUsd)} lost</b>`;
    } else if (slippagePct < 50) {
      cls = "warn";
      note = `<b>${fmtUsdRough(lostUsd)} lost</b> · split your sell`;
    } else {
      cls = "bad";
      note = "<b>You'd crash the price</b>";
    }
    const slipDisplay =
      slippagePct > 50 ? "~ DUMPS" : `${slippagePct.toFixed(1)}%`;
    const widthPct = Math.min(100, slippagePct * 1.6);
    return { amount, slipDisplay, widthPct, cls, note };
  });
}

// Local helper — same shape as formatters.fmt but inlined here so this
// module has no dependencies. The exit-liquidity tier list is the only
// caller; using fmt would create a circular-feeling import we don't need.
function fmtUsdRough(n) {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Extract a percentage from the first matching flag label. Some upstream
 * tokens populate the structured `top10HolderPct` field; others only emit
 * a flag like `"Top 10 wallets hold 82% of supply"`. Callers use this as
 * a fallback when the structured field is null so the visual still gets
 * a measured number.
 *
 * @param {Array<{label?: string}>} flags  /api/scan flag list.
 * @param {RegExp} regex  Capture group 1 must be the percentage.
 * @returns {number | null}
 */
export function parsePctFromFlags(flags, regex) {
  for (const f of flags) {
    const m = (f.label || "").match(regex);
    if (m && m[1]) {
      const n = parseFloat(m[1]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

// ─── Flags shown on the token page ───────────────────────────────────────
//
// A scan with no holder data carries the layer flag
// "Helius unavailable — holder concentration unverified" and the API caps
// that verdict at CAUTION. The page hides pipeline-status flags ("X
// unavailable") because they describe our plumbing, not the token; this one
// is the exception, since it is the reason the verdict is not SAFE. Plain-JS
// copy of shared/holders-unverified.ts (the extension side). Keep in sync.
export const HOLDERS_UNVERIFIED_LABEL = "Holder concentration unverified";

export function isHoldersUnverifiedFlag(label) {
  return typeof label === "string" && /holder concentration unverified/i.test(label);
}

/** Label to display for a flag: the unverified-holders flag is shown under a
 *  neutral name (the check that is missing), every other label is unchanged. */
export function displayFlagLabel(label) {
  return isHoldersUnverifiedFlag(label) ? HOLDERS_UNVERIFIED_LABEL : label;
}

/** Flags that count and are listed on the page: warning/critical only, minus
 *  pipeline-status ones ("... unavailable"), except the unverified-holders
 *  flag, which explains the verdict. */
export function visibleFlags(flags) {
  return (flags || []).filter((f) => {
    if (f.severity === "bonus" || f.severity === "info") return false;
    if (
      typeof f.label === "string" &&
      /\bunavailable\b/i.test(f.label) &&
      !isHoldersUnverifiedFlag(f.label)
    ) {
      return false;
    }
    return true;
  });
}
