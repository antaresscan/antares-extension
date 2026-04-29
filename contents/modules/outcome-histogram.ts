import { state } from "./state"
import type { OutcomeStatsPayload } from "../../shared/types"

/**
 * Toggle the Outcome Histogram panel in the overlay.
 *
 * Renders the heuristic profile-match output: 3 hero stats
 * (median time-to-rug, % rugged in 24h, % alive at 30d), the
 * 36-bucket distribution with the "YOU" marker on youBucketIndex,
 * and the 3 most-similar past launches with their realised losses.
 *
 * Verdict gate: the toggle only fires for RUG / DANGER tokens.
 * The backend composeOutcomeStats currently falls through to a
 * slow-death cluster for any non-RUG verdict, which produced
 * misleading "time-to-rug 2d" stats on bluechip CAUTION tokens.
 * Until the corpus-based KNN matcher ships, this section is only
 * meaningful for tokens already flagged as a clear risk.
 *
 * Shadow-DOM-safe: every value goes through textContent. The bar
 * heights are derived numbers (no string templates).
 *
 * Mutex: opening this panel closes the four sibling disclosure
 * panels first.
 */
export function toggleOutcomeHistogram(stats: OutcomeStatsPayload | null | undefined): void {
  const panel = state.shadow?.querySelector("#ant-outcome-histogram") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")
  if (isOpen) {
    panel.classList.remove("open")
    return
  }

  closeSiblings(panel.id)

  if (!panel.dataset.loaded) {
    panel.dataset.loaded = "1"
    renderPanel(panel, stats)
  }

  panel.classList.add("open")
}

/** Returns true when the verdict band justifies showing the
 *  Outcome Histogram. SAFE and CAUTION return false (the section
 *  button stays hidden in the overlay footer). */
export function shouldShowOutcomeHistogram(verdict: string | null | undefined): boolean {
  const v = String(verdict || "").toUpperCase()
  return v === "RUG" || v === "RUG PULL" || v === "DANGER"
}

const SIBLING_PANEL_IDS = [
  "ant-critical-flags",
  "ant-ai-summary",
  "ant-holder-activity",
  "ant-outcome-histogram",
  "ant-verdict-timeline",
]

function closeSiblings(selfId: string): void {
  for (const id of SIBLING_PANEL_IDS) {
    if (id === selfId) continue
    const node = state.shadow?.querySelector("#" + id) as HTMLElement | null
    node?.classList.remove("open")
  }
}

function renderPanel(panel: HTMLElement, stats: OutcomeStatsPayload | null | undefined): void {
  panel.replaceChildren()

  if (
    !stats ||
    !Array.isArray(stats.distribution) ||
    stats.distribution.length === 0
  ) {
    const empty = document.createElement("div")
    empty.className = "oh-panel-empty"
    empty.textContent = "Outcome distribution unavailable for this token."
    panel.appendChild(empty)
    return
  }

  const inner = document.createElement("div")
  inner.className = "oh-panel-inner"

  // ── Hero stats: 3 numbers in a row ──
  const stats3 = document.createElement("div")
  stats3.className = "oh-stats"
  stats3.appendChild(buildStat("Median TTR", stats.timeToRugMedianDisp || "—", "danger"))
  stats3.appendChild(buildStat("Rugged 24h", pctDisp(stats.pctRugged24h), "danger"))
  stats3.appendChild(buildStat("Alive 30d", pctDisp(stats.pctAlive30d), "safe"))
  inner.appendChild(stats3)

  // ── Bar chart ──
  const dist = stats.distribution
  const maxVal = Math.max.apply(null, dist) || 1
  const youIdx = typeof stats.youBucketIndex === "number" ? stats.youBucketIndex : -1

  const bars = document.createElement("div")
  bars.className = "oh-bars"
  for (let i = 0; i < dist.length; i++) {
    const bar = document.createElement("div")
    bar.className = "oh-bar" + (i === youIdx ? " oh-bar-you" : "")
    const h = Math.max(2, Math.round((dist[i] / maxVal) * 100))
    bar.style.height = h + "%"
    bars.appendChild(bar)
  }
  inner.appendChild(bars)

  const axis = document.createElement("div")
  axis.className = "oh-axis"
  ;["0h", "4h", "12h", "24h", "3d", "7d", "30d+"].forEach((t) => {
    const span = document.createElement("span")
    span.textContent = t
    axis.appendChild(span)
  })
  inner.appendChild(axis)

  // ── Most-similar past launches ──
  if (Array.isArray(stats.mostSimilar) && stats.mostSimilar.length > 0) {
    const simTitle = document.createElement("div")
    simTitle.className = "oh-sim-title"
    simTitle.textContent = "Most similar"
    inner.appendChild(simTitle)

    const simWrap = document.createElement("div")
    simWrap.className = "oh-sim-wrap"
    stats.mostSimilar.slice(0, 3).forEach((s) => {
      const card = document.createElement("div")
      card.className = "oh-sim-card"

      const sym = document.createElement("div")
      sym.className = "oh-sim-sym"
      sym.textContent = s.symbol || "—"
      card.appendChild(sym)

      const meta = document.createElement("div")
      meta.className = "oh-sim-meta"
      const hrs = s.ruggedAfterHours
      const hrsDisp = hrs < 24 ? hrs + "h" : Math.round(hrs / 24) + "d"
      const lossDisp = s.loss != null ? s.loss.toFixed(0) + "%" : "—"
      meta.textContent = "Rugged after " + hrsDisp + " · " + lossDisp
      card.appendChild(meta)

      simWrap.appendChild(card)
    })
    inner.appendChild(simWrap)
  }

  // Disclaimer
  const disc = document.createElement("div")
  disc.className = "oh-disclaimer"
  disc.textContent = "Heuristic profile match. Indicative — not a forecast."
  inner.appendChild(disc)

  panel.appendChild(inner)
}

function buildStat(lbl: string, val: string, tone: "danger" | "warn" | "safe"): HTMLElement {
  const wrap = document.createElement("div")
  wrap.className = "oh-stat oh-stat-" + tone
  const lblEl = document.createElement("div")
  lblEl.className = "oh-stat-lbl"
  lblEl.textContent = lbl
  wrap.appendChild(lblEl)
  const valEl = document.createElement("div")
  valEl.className = "oh-stat-val"
  valEl.textContent = val
  wrap.appendChild(valEl)
  return wrap
}

function pctDisp(n: number | null | undefined): string {
  if (n == null) return "—"
  return Math.round(n) + "%"
}
