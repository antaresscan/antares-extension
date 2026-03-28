import { POS_KEY } from "./constants"
import { state } from "./state"

function commitPos() {
  state.rafId = null
  if (!state.host) return
  state.posX = state.pendingX
  state.posY = state.pendingY
  state.host.style.transform = `translate(${state.posX}px,${state.posY}px)`
}

/** Clamp position so widget stays within viewport bounds */
function clampPosition() {
  if (!state.host) return
  const w = state.host.offsetWidth || 280
  const h = state.host.offsetHeight || 360
  state.posX = Math.max(0, Math.min(window.innerWidth - w, state.posX))
  state.posY = Math.max(0, Math.min(window.innerHeight - h, state.posY))
  state.pendingX = state.posX
  state.pendingY = state.posY
  state.host.style.transform = `translate(${state.posX}px,${state.posY}px)`
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x: state.posX, y: state.posY })) } catch (e: unknown) { console.warn("[antares]", e) }
}

export function initDrag() {
  if (!state.host) return

  // Restore or default position
  try {
    const saved = localStorage.getItem(POS_KEY)
    if (saved) {
      const p = JSON.parse(saved) as { x: number; y: number }
      state.posX = p.x; state.posY = p.y
    } else {
      state.posX = window.innerWidth  - 310
      state.posY = window.innerHeight - 400
    }
  } catch (e: unknown) {
    console.warn("[antares]", e)
    state.posX = window.innerWidth  - 310
    state.posY = window.innerHeight - 400
  }

  state.pendingX = state.posX; state.pendingY = state.posY
  state.host.style.transform = `translate(${state.posX}px,${state.posY}px)`

  // Clamp on window resize so widget never gets stuck off-screen
  window.addEventListener("resize", clampPosition)

  state.host.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.composedPath()[0] as Element
    if (target?.closest?.(".x")) return
    if (!target?.closest?.(".hd")) return
    const hdEl = (e.currentTarget as HTMLElement)
    try { hdEl.setPointerCapture(e.pointerId) } catch (e2: unknown) { console.warn("[antares]", e2) }
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
    nx = Math.max(0, Math.min(window.innerWidth  - state.host.offsetWidth,  nx))
    ny = Math.max(0, Math.min(window.innerHeight - state.host.offsetHeight, ny))
    state.pendingX = nx; state.pendingY = ny
    if (!state.rafId) state.rafId = requestAnimationFrame(commitPos)
  }, { passive: true })

  state.host.addEventListener("pointerup", (e: PointerEvent) => {
    if (e.pointerId !== state.activePointerId) return
    state.activePointerId = null
    document.documentElement.style.userSelect = ""
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: state.posX, y: state.posY })) } catch (e2: unknown) { console.warn("[antares]", e2) }
  })

  state.host.addEventListener("pointercancel", () => {
    state.activePointerId = null
    document.documentElement.style.userSelect = ""
  })
}
