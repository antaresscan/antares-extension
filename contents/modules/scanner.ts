import type { ScanResponseData } from "../../shared/types"
import { API, LS_PREFIX, IGNORE } from "./constants"
import { state, scanCache } from "./state"
import { getCached, saveToLS } from "./cache"
import { getBox, showBox, hideBox, attachClose, triggerResultAnimations, buildHeader, buildResult } from "./components"

export function isValid(addr: string): boolean {
  if (addr.length < 32 || addr.length > 44) return false
  if (IGNORE.has(addr)) return false
  if (/^[A-Z]+$/.test(addr)) return false
  if (/^[0-9]+$/.test(addr)) return false
  return true
}

// [5.2] Price-based forced rescan
export function scheduleRescanIfPriceCrash(data: ScanResponseData, ca: string) {
  if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null }
  const pc1h = typeof data.priceChange1h === "number" ? data.priceChange1h : null
  if (pc1h !== null && pc1h < -30) {
    state.rescanTimer = setTimeout(() => {
      state.rescanTimer = null
      // Invalidate cache so rescan hits the API
      scanCache.delete(ca)
      try { localStorage.removeItem(LS_PREFIX + ca) } catch (e: unknown) { console.warn("[antares]", e) }
      // Force rescan
      state.lastCA = ""
      state.manuallyDismissed = false
      scan(ca)
    }, 5_000)
  }
}

export async function scan(ca: string) {
  if (!ca) return

  // [5.3] Stealth mode — send to background for badge update only, skip popup
  if (state.stealthMode) {
    if (ca === state.lastCA) return
    state.lastCA = ca
    try {
      chrome.runtime.sendMessage({ type: "SCAN", ca })
    } catch (e: unknown) { console.warn("[antares]", e) }
    return
  }

  const el = getBox()

  const cached = getCached(ca)
  if (ca === state.lastCA && cached && el.style.display !== "none") return
  if (state.manuallyDismissed && ca === state.lastCA) return
  if (state.currentScanController) return
  if (ca !== state.lastCA) { state.manuallyDismissed = false; state.lastCA = ca }

  if (cached) {
    el.innerHTML = buildResult(cached, ca)
    showBox()
    triggerResultAnimations(el)
    attachClose()
    scheduleRescanIfPriceCrash(cached, ca)
    return
  }

  // Abort any previous in-flight scan, start a new one
  const controller = new AbortController()
  state.currentScanController = controller

  if (state.boxEl) state.boxEl.className = "box"
  el.innerHTML = `
    <div class="topbar" style="background:linear-gradient(90deg,transparent,#3a3a3f,transparent)"></div>
    ${buildHeader()}
    <div class="skel">
      <div class="skel-verdict"></div>
      <div class="skel-bar"></div>
      <div class="skel-line"></div>
      <div class="skel-line"></div>
      <div class="skel-line"></div>
    </div>
  `
  showBox(); attachClose()

  try {
    const res  = await fetch(`${API}?ca=${ca}`, { signal: controller.signal })
    if (controller.signal.aborted) return
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json() as ScanResponseData
    if (controller.signal.aborted) return
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    el.innerHTML = buildResult(data, ca)
    showBox()
    triggerResultAnimations(el)
    attachClose()
    // [5.2] Schedule forced rescan if price crashed > -30% in 1h
    scheduleRescanIfPriceCrash(data, ca)
  } catch (e: unknown) {
    if (controller.signal.aborted) return
    console.warn("[antares]", e)
    if (state.lastCA === ca) {
      if (state.boxEl) state.boxEl.className = "box danger"
      el.innerHTML = `
        <div class="topbar"></div>
        ${buildHeader()}
        <div style="color:#ff5f5f;font-size:12px;padding:12px 14px;font-family:'IBM Plex Mono',monospace">API Error &mdash; retry later</div>
      `
      showBox(); attachClose()
    }
  } finally {
    if (state.currentScanController === controller) {
      state.currentScanController = null
    }
  }
}
