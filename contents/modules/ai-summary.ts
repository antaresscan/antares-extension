import { state } from "./state"

/**
 * Toggle the AI summary panel visibility in the overlay.
 * Replaces the old History panel with a collapsible AI summary.
 */
export function toggleAiSummary(): void {
  const panel = state.shadow?.querySelector("#ant-ai-summary") as HTMLElement | null
  if (!panel) return
  panel.classList.toggle("open")
}
