import type { ScanResponseData } from "../../shared/types"
import * as Sentry from "@sentry/browser"
import { API, LS_PREFIX, IGNORE } from "./constants"
import { state, scanCache } from "./state"
import { getCached, saveToLS } from "./cache"
import { getBox, showBox, attachClose, triggerResultAnimations, buildHeader, buildResult } from "./components"
import { scanRateLimiter } from "../../shared/rate-limit"

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
      void scan(ca)
    }, 5_000)
  }
}

/** Maximum number of retry attempts before giving up silently */
const MAX_RETRIES = 3
/** Delay between retries in ms (doubles each attempt) */
const BASE_RETRY_DELAY = 1500

/** Check if an error is retryable (network/server issues) */
function isRetryable(e: unknown): boolean {
  if (e instanceof Error) {
    const status = parseInt(e.message, 10)
    if (status === 429) return true // Rate limit
    if (status >= 500) return true // Server errors
    if (e.name === "AbortError") return false // User-initiated abort
    if (e.message === "Failed to fetch") return true // Network error
  }
  return true // Default: retry unknown errors
}

/** Fetch with automatic retry + exponential backoff */
async function fetchWithRetry(
  url: string,
  signal: AbortSignal,
  retries = MAX_RETRIES
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    try {
      const res = await fetch(url, { signal })
      // 429 / 5xx => retry
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

  // Client-side rate limiting to prevent API flooding
  if (!scanRateLimiter.tryAcquire()) {
    console.warn("[antares] scan rate-limited, retry after", scanRateLimiter.getRetryAfterMs(), "ms")
    return
  }

  // Extension disabled — do nothing
  if (!state.enabled) return

  const el = getBox()
  const cached = getCached(ca)
  if (ca === state.lastCA && cached && el.style.display !== "none") return
  if (state.manuallyDismissed && ca === state.lastCA) return

  if (state.currentScanController) {
    if (ca !== state.lastCA) {
      state.currentScanController.abort(); state.currentScanController = null;
    } else { return; }
  }

  state.manuallyDismissed = false;
  state.lastCA = ca;

  if (cached) {
    el.innerHTML = buildResult(cached, ca)
    showBox()
    triggerResultAnimations(el)
    attachClose()
    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(cached, ca)
    })
    return
  }

  const controller = new AbortController()
  state.currentScanController = controller

  if (state.boxEl) state.boxEl.className = "box"
  el.innerHTML = `
${buildHeader()}
<div class="loading"></div>`
  showBox(); attachClose()

  try {
    const res = await fetchWithRetry(`${API}?ca=${ca}`, controller.signal)
    if (controller.signal.aborted) return
    const data = await res.json() as ScanResponseData
    if (controller.signal.aborted) return

    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)

    el.innerHTML = buildResult(data, ca)
    showBox()
    triggerResultAnimations(el)
    attachClose()

    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(data, ca)
    })
  } catch (e: unknown) {
    if (controller.signal.aborted) return
    console.warn("[antares] scan failed after retries:", e)
    try { Sentry.captureException(e) } catch { /* Sentry not initialized */ }
    // Silent failure: hide the box instead of showing an error to the user.
    // The scan will be retried automatically on next navigation or page change.
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
