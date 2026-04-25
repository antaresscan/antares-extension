import type { ScanResponseData } from "../../shared/types"
import * as Sentry from "@sentry/browser"
import { API, LS_PREFIX, IGNORE } from "./constants"
import { state, scanCache } from "./state"
import { getCached, saveToLS } from "./cache"
import { getBox, showBox, attachClose, attachAnalysisBtn, triggerResultAnimations, buildHeader, buildResult } from "./components"
import { scanRateLimiter } from "../../shared/rate-limit"
import { logger } from "../../shared/logger"
import { getInstallId } from "../../shared/install-id"

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
      scanCache.delete(ca)
      try { localStorage.removeItem(LS_PREFIX + ca) } catch (e: unknown) { logger.warn("scanner", "Failed to remove LS cache", e) }
      state.lastCA = ""
      state.manuallyDismissed = false
      void scan(ca)
    }, 5_000)
  }
}

const MAX_RETRIES = 3
const BASE_RETRY_DELAY = 1500

function isRetryable(e: unknown): boolean {
  if (e instanceof Error) {
    const status = parseInt(e.message, 10)
    if (status === 429) return true
    if (status >= 500) return true
    if (e.name === "AbortError") return false
    if (e.message === "Failed to fetch") return true
  }
  return true
}

async function fetchWithRetry(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  retries = MAX_RETRIES
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    try {
      const res = await fetch(url, { signal, headers })
      if (!res.ok) {
        const status = res.status
        if ((status === 429 || status >= 500) && attempt < retries) {
          const delay = BASE_RETRY_DELAY * Math.pow(2, attempt)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw new Error("" + status)
      }
      return res
    } catch (e: unknown) {
      lastError = e
      if (signal.aborted) throw e
      if (!isRetryable(e) || attempt >= retries) throw e
      const delay = BASE_RETRY_DELAY * Math.pow(2, attempt)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastError
}

export async function scan(ca: string) {
  if (!ca) return

  if (!scanRateLimiter.tryAcquire()) {
    logger.warn("scanner", "scan rate-limited, retry after", scanRateLimiter.getRetryAfterMs())
    return
  }

  const el = getBox()
  const cached = getCached(ca)
  if (ca === state.lastCA && cached && el.style.display !== "none") return
  if (state.manuallyDismissed && ca === state.lastCA) return

  if (state.currentScanController) {
    if (ca !== state.lastCA) {
      state.currentScanController.abort()
      state.currentScanController = null
    } else {
      return
    }
  }

  state.manuallyDismissed = false
  state.lastCA = ca

  // ── Cached path ──────────────────────────────────────────────────────────────
  if (cached) {
    el.innerHTML = buildResult(cached, ca)
    showBox()
    triggerResultAnimations(el)
    attachClose(cached.aiSummary ?? null)
    attachAnalysisBtn(ca)
    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(cached, ca)
    })
    return
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────────
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
  showBox()
  attachClose(null)

  try {
    const installId = await getInstallId()
    const headers: Record<string, string> = installId ? { "X-Antares-Install": installId } : {}
    const res = await fetchWithRetry(`${API}?ca=${ca}`, controller.signal, headers)
    if (controller.signal.aborted) return
    const data = await res.json() as ScanResponseData
    if (controller.signal.aborted) return
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    el.innerHTML = buildResult(data, ca)
    showBox()
    triggerResultAnimations(el)
    attachClose(data.aiSummary ?? null)
    attachAnalysisBtn(ca)
    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(data, ca)
    })
  } catch (e: unknown) {
    if (controller.signal.aborted) return
    logger.warn("scanner", "scan failed after retries", e)
    try { Sentry.captureException(e) } catch { /* Sentry not initialized */ }
    if (state.lastCA === ca && state.boxEl) {
      state.boxEl.style.display = "none"
      state.boxEl.style.opacity = "0"
    }
  } finally {
    if (state.currentScanController === controller) {
      state.currentScanController = null
    }
  }
}
