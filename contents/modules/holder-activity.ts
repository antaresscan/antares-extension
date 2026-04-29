import { state } from "./state"
import type { HolderActivityPayload } from "../../shared/types"

/**
 * Toggle the Holder Activity panel in the overlay.
 *
 * The API produces this payload via composeHolderActivity, which
 * classifies each top holder's last-60min movement using Solscan
 * recentTransfers. Rows that come back as Static + ±0% + empty
 * description are filtered out — the backend ships them for top
 * holders that exist on-chain but had zero activity in the window,
 * and surfacing six identical "Static · ±0%" rows reads as "broken"
 * to the user. If the filter empties the list, the panel shows an
 * honest empty state explaining why.
 *
 * Shadow-DOM-safe: every text node uses textContent (or createElement
 * with no innerHTML) so labels and descriptions coming from the API
 * cannot be interpreted as HTML.
 *
 * Mutex: opening this panel closes Critical Flags / AI Summary /
 * Outcome Histogram / Verdict Timeline first. With multiple open
 * the overlay overflows the viewport on shorter screens.
 */
export function toggleHolderActivity(activity: HolderActivityPayload | null | undefined): void {
  const panel = state.shadow?.querySelector("#ant-holder-activity") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")
  if (isOpen) {
    panel.classList.remove("open")
    return
  }

  closeSiblings(panel.id)

  if (!panel.dataset.loaded) {
    panel.dataset.loaded = "1"
    renderPanel(panel, activity)
  }

  panel.classList.add("open")
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

function renderPanel(panel: HTMLElement, activity: HolderActivityPayload | null | undefined): void {
  panel.replaceChildren()

  const allRows = activity && Array.isArray(activity.rows) ? activity.rows : []
  // Drop pure-Static rows (no activity) — they read as broken when
  // they're the only content. Keep Static rows that at least have a
  // description (which means the backend had something specific to say).
  const activeRows = allRows.filter((r) => {
    const isStatic = String(r.label || "").toLowerCase() === "static"
    const hasPct = typeof r.pctChange === "number" && Math.abs(r.pctChange) >= 0.05
    const hasDesc = typeof r.desc === "string" && r.desc.length > 0
    return !isStatic || hasPct || hasDesc
  })

  if (activeRows.length === 0) {
    const empty = document.createElement("div")
    empty.className = "ha-panel-empty"
    empty.textContent =
      allRows.length > 0
        ? "All top holders are static in the last 60 minutes."
        : "No recent transfers available."
    panel.appendChild(empty)
    return
  }

  const inner = document.createElement("div")
  inner.className = "ha-panel-inner"

  for (const row of activeRows) {
    const rowEl = document.createElement("div")
    rowEl.className = "ha-row"

    const avatarEl = document.createElement("span")
    avatarEl.className = "ha-avatar ha-avatar-" + (row.role || "real")
    avatarEl.textContent = row.avatar || ""
    rowEl.appendChild(avatarEl)

    const labelEl = document.createElement("span")
    labelEl.className = "ha-label ha-label-" + String(row.label || "").toLowerCase()
    labelEl.textContent = row.label || ""
    rowEl.appendChild(labelEl)

    const pctEl = document.createElement("span")
    const pctClass = row.pctChange > 0 ? "up" : row.pctChange < 0 ? "dn" : "flat"
    pctEl.className = "ha-pct ha-pct-" + pctClass
    pctEl.textContent = row.pctChangeDisp || "±0%"
    rowEl.appendChild(pctEl)

    if (row.desc && row.desc.length > 0) {
      const descEl = document.createElement("div")
      descEl.className = "ha-desc"
      descEl.textContent = row.desc
      rowEl.appendChild(descEl)
    }

    inner.appendChild(rowEl)
  }

  panel.appendChild(inner)

  // Footer: net flow over the window
  if (activity) {
    const foot = document.createElement("div")
    foot.className = "ha-foot"

    const lblEl = document.createElement("span")
    lblEl.className = "ha-foot-lbl"
    lblEl.textContent =
      activity.netFlowDirection === "out"
        ? "Net flow OUT (60min)"
        : activity.netFlowDirection === "in"
          ? "Net flow IN (60min)"
          : "Net flow flat (60min)"

    const valEl = document.createElement("span")
    valEl.className = "ha-foot-val ha-foot-val-" + (activity.netFlowDirection || "flat")
    const pct = typeof activity.netFlowPct === "number" ? activity.netFlowPct : 0
    valEl.textContent = (pct > 0 ? "+" : "") + pct.toFixed(1) + "%"

    foot.appendChild(lblEl)
    foot.appendChild(valEl)
    panel.appendChild(foot)
  }
}
