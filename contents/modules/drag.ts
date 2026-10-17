import { POS_KEY } from "./constants"
import { state } from "./state"
import { logger } from "../../shared/logger"

function commitPos() {
  state.rafId = null
  if (!state.host) return
  state.posX = state.pendingX
  state.posY = state.pendingY
  state.host.style.transform = `translate(${state.posX}px,${state.posY}px)`
}

/**
 * Clamp position so widget stays within viewport bounds.
 *
 * No transition: tried adding an eased clamp animation but it created
 * a race — resize fires many times during a window-corner drag, each
 * call applied a 300ms transition, and overlapping transitions made
 * subsequent user-drag feel mushy until the last one ended. Reverted
 * to instant clamp; the snap is barely visible on a real resize and
 * the trade-off (smooth resize vs reliable drag) wasn't worth it.
 *
 * Skip entirely when nothing changed — avoids wasted style recalc on
 * every resize event when the widget is already inside bounds.
 *
 * `persist: false` when the box is placed at injection: the saved spot is kept for a larger window, the box is only drawn inside this one.
 */
function clampPosition(persist = true) {
  if (!state.host) return
  const w = state.host.offsetWidth || CARD_W
  const h = state.host.offsetHeight || 360
  const newX = Math.max(0, Math.min(window.innerWidth - w, state.posX))
  const newY = Math.max(0, Math.min(window.innerHeight - h, state.posY))
  if (newX === state.posX && newY === state.posY) return
  state.posX = newX
  state.posY = newY
  state.pendingX = state.posX
  state.pendingY = state.posY
  state.host.style.transform = `translate(${state.posX}px,${state.posY}px)`
  if (!persist) return
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x: state.posX, y: state.posY })) } catch (e: unknown) { logger.warn(e) }
}

/** The card is 290 px wide (.box in styles.ts): the width counted for it while the box is still empty and has none. */
const CARD_W = 290

/** How much of the card's top-left corner must be in view for the user to see it and grab it by its header. */
const GRIP_W = 100
const GRIP_H = 60

function headerInView(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= window.innerWidth - GRIP_W && y <= window.innerHeight - GRIP_H
}

// One reference, so that the listener added by every initDrag (createHost runs again when the page strips the host) is added only once.
const clampOnResize = () => clampPosition()

/** The saved spot, when it is one: two finite numbers. It sits in the SITE's localStorage, so it is read as unknown. */
function savedPosition(): { x: number; y: number } | null {
  try {
    const saved = localStorage.getItem(POS_KEY)
    if (!saved) return null
    const p = JSON.parse(saved) as { x?: unknown; y?: unknown } | null
    if (typeof p?.x === "number" && Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y)) return { x: p.x, y: p.y }
  } catch (e: unknown) {
    logger.warn(e)
  }
  return null
}

export function initDrag() {
  if (!state.host) return

  // Restore or default position, then draw it inside THIS window. The spot may have been saved in a larger window (another screen):
  // restored as it was, the box sat off-screen, invisible on every page of the site until the window was resized (the clamp only ran
  // on resize). A saved value that is not two numbers counts as none.
  const saved = savedPosition()
  state.posX = saved ? saved.x : window.innerWidth - 310
  state.posY = saved ? saved.y : window.innerHeight - 400

  state.pendingX = state.posX; state.pendingY = state.posY
  state.host.style.transform = `translate(${state.posX}px,${state.posY}px)`
  // Only a spot that would leave the card (nearly) out of this window is moved. At injection the box is still empty, so its size is a guess
  // (290 x 360): clamping every spot with it moved a card parked low in the window up by the difference with the real card (measured in a real
  // Chromium: parked at y 489, card 311 high, drawn at 440), and the real height is not steady either (178, 323, then 311 px while it is drawn).
  // A spot where the header is in view stays as the user left it, as before.
  if (!headerInView(state.posX, state.posY)) clampPosition(false)

  // Clamp on window resize so widget never gets stuck off-screen
  window.addEventListener("resize", clampOnResize)

  // The press is heard INSIDE the shadow root, not on the host. The root is closed (components.ts), and for a listener outside a closed root
  // the event path stops at the host: composedPath()[0] would be the host, never the header that was pressed, and no drag would ever start.
  // Inside the root, e.target is the real element. The pointer is still captured on the host, so the moves and the release below (heard on the
  // host) keep arriving when the pointer leaves the card.
  state.shadow?.addEventListener("pointerdown", (ev: Event) => {
    const e = ev as PointerEvent
    const target = e.target as Element | null
    if (target?.closest?.(".x")) return
    if (!target?.closest?.(".hd")) return
    try { state.host!.setPointerCapture(e.pointerId) } catch (e2: unknown) { logger.warn(e2) }
    state.activePointerId = e.pointerId
    const r = state.host!.getBoundingClientRect()
    state.dragOX = e.clientX - r.left
    state.dragOY = e.clientY - r.top
    document.documentElement.style.userSelect = "none"
    e.preventDefault()
  })

  state.host.addEventListener("pointermove", (e: PointerEvent) => {
    if (state.activePointerId === null || e.pointerId !== state.activePointerId || !state.host) return
    let nx = e.clientX - state.dragOX
    let ny = e.clientY - state.dragOY
    nx = Math.max(0, Math.min(window.innerWidth - state.host.offsetWidth, nx))
    ny = Math.max(0, Math.min(window.innerHeight - state.host.offsetHeight, ny))
    state.pendingX = nx; state.pendingY = ny
    if (!state.rafId) state.rafId = requestAnimationFrame(commitPos)
  }, { passive: true })

  state.host.addEventListener("pointerup", (e: PointerEvent) => {
    if (e.pointerId !== state.activePointerId) return
    state.activePointerId = null
    document.documentElement.style.userSelect = ""
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: state.posX, y: state.posY })) } catch (e2: unknown) { logger.warn(e2) }
  })

  state.host.addEventListener("pointercancel", () => {
    state.activePointerId = null
    document.documentElement.style.userSelect = ""
  })
}
