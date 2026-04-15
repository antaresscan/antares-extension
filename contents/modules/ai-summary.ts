import { state } from "./state"

/**
 * Toggle the AI summary panel in the overlay.
 * On first open, injects the aiSummary text into the panel.
 * Subsequent clicks collapse/expand without re-rendering.
 */
export function toggleAiSummary(aiSummary: string | null | undefined): void {
  const panel = state.shadow?.querySelector("#ant-ai-summary") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")

  if (isOpen) {
    panel.classList.remove("open")
    return
  }

  // Inject content only once
  if (!panel.dataset.loaded) {
    panel.dataset.loaded = "1"
    if (!aiSummary) {
      panel.innerHTML = `<div class="ai-panel-empty">No AI summary available for this token.</div>`
    } else {
      // Split on sentence boundaries for better readability
      const sentences = aiSummary
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.trim().length > 0)

      const html = sentences
        .map((s, i) => {
          const isFirst = i === 0
          const cls = isFirst ? "ai-panel-verdict" : "ai-panel-line"
          return `<div class="${cls}">${escapeHtml(s.trim())}</div>`
        })
        .join("")

      panel.innerHTML = `<div class="ai-panel-inner">${html}</div>`
    }
  }

  panel.classList.add("open")
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ))
}
