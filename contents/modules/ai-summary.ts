import { state } from "./state"
import { closePanelAnimated } from "./panel-close"

/**
 * Toggle the AI summary panel in the overlay.
 *
 * On first open the AI text is split into sentences and each sentence is
 * inserted as its own <div>. We use the DOM API (createElement +
 * textContent) rather than innerHTML so the panel cannot interpret any
 * HTML or script-bearing content the upstream summary might contain. This
 * is the structural defense — escapeHtml-on-string-templates was the
 * previous approach and one missed call site was enough for an XSS.
 *
 * Subsequent clicks just toggle the .open class without re-rendering.
 *
 * Mutex behavior: opening this panel always closes the Critical Flags
 * panel first. The two panels share the same vertical real estate inside
 * the overlay; with both open the box overflowed off-screen on shorter
 * viewports. One-at-a-time also matches the pattern users expect from
 * accordion-style disclosure.
 */
export function toggleAiSummary(aiSummary: string | null | undefined): void {
  const panel = state.shadow?.querySelector("#ant-ai-summary") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")
  if (isOpen) {
    closePanelAnimated(panel)
    return
  }

  // Mutex: close the Critical Flags panel before opening this one. The two
  // panels share the same vertical real estate inside the overlay; with
  // both open the box overflowed off-screen on shorter viewports. We use
  // the animated-close path so the swap feels coherent rather than one
  // panel snapping shut while the other slides open.
  closePanelAnimated(state.shadow?.querySelector("#ant-critical-flags") as HTMLElement | null)

  // Inject content only once
  if (!panel.dataset.loaded) {
    panel.dataset.loaded = "1"
    renderPanel(panel, aiSummary)
  }

  panel.classList.add("open")
}

/**
 * Render the panel body. Always replaces existing children so re-renders
 * are safe; here it only runs on first open.
 */
function renderPanel(panel: HTMLElement, aiSummary: string | null | undefined): void {
  panel.replaceChildren()

  if (!aiSummary) {
    const empty = document.createElement("div")
    empty.className = "ai-panel-empty"
    empty.textContent = "No AI summary available for this token."
    panel.appendChild(empty)
    return
  }

  const sentences = aiSummary
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  const inner = document.createElement("div")
  inner.className = "ai-panel-inner"

  sentences.forEach((sentence, i) => {
    const line = document.createElement("div")
    line.className = i === 0 ? "ai-panel-verdict" : "ai-panel-line"
    // textContent — the browser will never parse this as HTML, so any
    // < > & " ' the upstream summary contains is rendered as literal text.
    line.textContent = sentence
    inner.appendChild(line)
  })

  panel.appendChild(inner)
}
