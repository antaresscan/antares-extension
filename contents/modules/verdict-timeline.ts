import { state } from "./state"
import type { VerdictHistoryEntry } from "../../shared/types"

/**
 * Toggle the Verdict Timeline panel in the overlay.
 *
 * Renders the per-token verdict history persisted in Redis ZSET
 * `vh:{ca}` (oldest first; the most recent is the current scan).
 * Each entry surfaces the verdict, score and a short event tag
 * (e.g. "Top wallet 31% ↑", "LP burned ↑") that explains what
 * triggered the shift.
 *
 * Empty state when this is the first scan recorded for the token —
 * "Come back after a future scan to see the trajectory."
 *
 * Shadow-DOM-safe: every value goes through textContent.
 *
 * Mutex: opening this panel closes the four sibling disclosure
 * panels first.
 */
export function toggleVerdictTimeline(history: VerdictHistoryEntry[] | null | undefined): void {
  const panel = state.shadow?.querySelector("#ant-verdict-timeline") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")
  if (isOpen) {
    panel.classList.remove("open")
    return
  }

  closeSiblings(panel.id)

  if (!panel.dataset.loaded) {
    panel.dataset.loaded = "1"
    renderPanel(panel, history)
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

function verdictKey(v: string): string {
  const u = (v || "").toUpperCase()
  if (u === "SAFE") return "s"
  if (u === "CAUTION") return "c"
  if (u === "DANGER") return "d"
  if (u === "RUG" || u === "RUG PULL") return "r"
  return ""
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "—"
  const ms = typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts
  const diff = Date.now() - ms
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago"
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago"
  return Math.round(diff / 86_400_000) + "d ago"
}

function renderPanel(panel: HTMLElement, history: VerdictHistoryEntry[] | null | undefined): void {
  panel.replaceChildren()

  const entries = Array.isArray(history) ? history : []
  if (entries.length === 0) {
    const empty = document.createElement("div")
    empty.className = "vt-panel-empty"
    empty.textContent = "First scan recorded for this token."
    panel.appendChild(empty)
    return
  }

  const inner = document.createElement("div")
  inner.className = "vt-panel-inner"

  entries.forEach((entry, i) => {
    const isLatest = i === entries.length - 1
    const k = verdictKey(entry.verdict)

    const row = document.createElement("div")
    row.className = "vt-row" + (isLatest ? " vt-row-now" : "")

    const dot = document.createElement("span")
    dot.className = "vt-dot vt-dot-" + k
    row.appendChild(dot)

    const meta = document.createElement("div")
    meta.className = "vt-meta"

    const top = document.createElement("div")
    top.className = "vt-top"

    const verdictEl = document.createElement("span")
    verdictEl.className = "vt-verdict vt-verdict-" + k
    verdictEl.textContent = String(entry.verdict || "—").toUpperCase()
    top.appendChild(verdictEl)

    const scoreEl = document.createElement("span")
    scoreEl.className = "vt-score"
    scoreEl.textContent = entry.score != null ? String(entry.score) : "—"
    top.appendChild(scoreEl)

    const timeEl = document.createElement("span")
    timeEl.className = "vt-time"
    timeEl.textContent = isLatest ? "now" : formatRelativeTime(entry.ts)
    top.appendChild(timeEl)

    meta.appendChild(top)

    const eventLabel = isLatest ? "current scan" : entry.event
    if (eventLabel && eventLabel.length > 0) {
      const evEl = document.createElement("div")
      evEl.className = "vt-event"
      evEl.textContent = eventLabel
      meta.appendChild(evEl)
    }

    row.appendChild(meta)
    inner.appendChild(row)
  })

  panel.appendChild(inner)
}
