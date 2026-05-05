/**
 * Animate-and-close a disclosure panel (AI summary / critical flags).
 *
 * The panels open via a CSS keyframe on `.open`. Closing was instant
 * (just `classList.remove("open")` → `display:none`), which felt abrupt
 * compared to the smooth open. To get a symmetric reverse animation we:
 *
 *   1. Add `.closing` while keeping `.open` — so the panel stays
 *      `display:block` and the `.open.closing` keyframe can drive
 *      opacity + translateY back to the starting position.
 *   2. Wait for `animationend`, then strip both classes — at which
 *      point `.ai-panel` / `.cf-panel` revert to `display:none`.
 *
 * No-op when the panel is missing or already closed/closing — idempotent
 * so the mutex callers (open A → close B) don't have to check first.
 */
export function closePanelAnimated(panel: HTMLElement | null): void {
  if (!panel) return
  if (!panel.classList.contains("open")) return
  if (panel.classList.contains("closing")) return
  panel.classList.add("closing")
  panel.addEventListener(
    "animationend",
    () => panel.classList.remove("open", "closing"),
    { once: true },
  )
}
