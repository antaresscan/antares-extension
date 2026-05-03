import type { ScanResponseData, QuotaStatus } from "../../shared/types"
import * as Sentry from "@sentry/browser"
import { API, LS_PREFIX, IGNORE } from "./constants"
import { state, scanCache } from "./state"
import { getCached, saveToLS } from "./cache"
import { getBox, showBox, attachClose, attachAnalysisBtn, triggerResultAnimations, buildResultNode, buildSkeletonNode, buildQuotaExhaustedNode } from "./components"
import { scanRateLimiter } from "../../shared/rate-limit"
import { logger } from "../../shared/logger"
import { getInstallId } from "../../shared/install-id"

/**
 * Thrown by fetchWithRetry when a 429 carries quota headers showing
 * the user has burned their daily allowance (limit > 0, remaining = 0).
 * Distinct from a generic 429 (rate-limit burst, which is recoverable
 * with a retry) — quota exhaustion needs different UX: stop retrying,
 * tell the user, point them at /pricing.
 */
export class QuotaExhaustedError extends Error {
  constructor(public readonly quota: QuotaStatus) {
    super("quota_exhausted")
    this.name = "QuotaExhaustedError"
  }
}

/**
 * Read the dev-tier override from chrome.storage.local. Set via the
 * options page; returns null when unset or invalid. The scanner uses
 * this to add an `X-Antares-Dev-Tier` header to scan requests so the
 * dev can force Free/Pro/Lifetime in real time without redeploying or
 * editing Redis. Server-side gate (DEV_PRO_INSTALLS env) ensures only
 * dev-listed installs can actually override.
 */
async function readDevTierOverride(): Promise<string | null> {
  try {
    const data = await new Promise<{ antares_dev_tier?: string }>((resolve) =>
      chrome.storage.local.get(["antares_dev_tier"], (v) => resolve(v as { antares_dev_tier?: string })),
    )
    const v = data.antares_dev_tier
    if (v === "free" || v === "pro" || v === "lifetime") return v
    return null
  } catch {
    return null
  }
}

// Pull X-Antares-Quota-* headers off a /api/scan response into a structured
// shape the overlay can render. Returns undefined when headers are missing
// (old API version, errored response, or CORS not exposing them) so callers
// can simply hide the badge instead of showing zeros.
function extractQuotaFromHeaders(headers: Headers): QuotaStatus | undefined {
  const tier = headers.get("X-Antares-Quota-Tier")
  if (tier !== "free" && tier !== "pro" && tier !== "lifetime") return undefined
  const used = parseInt(headers.get("X-Antares-Quota-Used") ?? "0", 10)
  const limit = parseInt(headers.get("X-Antares-Quota-Limit") ?? "-1", 10)
  const remaining = parseInt(headers.get("X-Antares-Quota-Remaining") ?? "-1", 10)
  const resetAt = parseInt(headers.get("X-Antares-Quota-Reset") ?? "0", 10)
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined
  return { tier, used, limit, remaining, resetAt }
}

export function isValid(addr: string): boolean {
  if (addr.length < 32 || addr.length > 44) return false
  if (IGNORE.has(addr)) return false
  if (/^[A-Z]+$/.test(addr)) return false
  if (/^[0-9]+$/.test(addr)) return false
  return true
}

// [5.2] Price-based forced rescan
//
// If a token has dropped >30% in the last hour we re-fetch the verdict
// after a short delay so the overlay reflects post-crash state. Side
// effect we have to manage: the rescan calls scan() which replaces
// the box subtree via el.replaceChildren(buildResultNode(...)) and
// wipes the .open class on whichever disclosure panel the user might
// be reading at that moment. The user-reported "panel refreshes
// itself every 5 seconds and closes" symptom on volatile RUG tokens
// (e.g. AMC at -52%/1h) was exactly this — they'd open Critical
// Flags or AI Summary and the rescan timer would fire under them.
//
// Fix: if a panel is open when the rescan timer fires, skip the
// rescan and re-arm. The overlay stays stable as long as the user
// is actively reading; once they close the panel the rescan resumes
// on its normal cadence.
export function scheduleRescanIfPriceCrash(data: ScanResponseData, ca: string) {
  if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null }
  const pc1h = typeof data.priceChange1h === "number" ? data.priceChange1h : null
  if (pc1h !== null && pc1h < -30) {
    state.rescanTimer = setTimeout(() => {
      state.rescanTimer = null
      // Postpone the rescan if the user has a disclosure panel open
      // — re-rendering the overlay underneath them would close the
      // panel and feel like a refresh bug.
      const aiOpen = state.shadow?.querySelector("#ant-ai-summary.open")
      const cfOpen = state.shadow?.querySelector("#ant-critical-flags.open")
      if (aiOpen || cfOpen) {
        scheduleRescanIfPriceCrash(data, ca)
        return
      }
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
        // Quota exhaustion vs rate-limit burst: both surface as 429,
        // but only the second is recoverable via retry. The server
        // sets X-Antares-Quota-Remaining=0 only when the daily limit
        // is hit, so we use that as the discriminator. Surface as a
        // typed error so the caller can render the right overlay
        // instead of bouncing through MAX_RETRIES delays for nothing.
        if (status === 429) {
          const quota = extractQuotaFromHeaders(res.headers)
          if (quota && quota.limit > 0 && quota.remaining === 0) {
            throw new QuotaExhaustedError(quota)
          }
        }
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
      // QuotaExhaustedError is by design non-retryable — bubble up.
      if (e instanceof QuotaExhaustedError) throw e
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

  // Resolve install_id once up-front so every render path (cached,
  // loading skeleton, result, quota-exhausted) can bake it into
  // upgrade-CTA hrefs synchronously. Async window.open in click
  // handlers gets popup-blocked, so the install_id must be present at
  // the moment the <a> is constructed, not awaited inside a click.
  const installId = await getInstallId()

  // ── Cached path ──────────────────────────────────────────────────────────────
  if (cached) {
    // replaceChildren swaps the subtree atomically — never round-trips
    // markup through the parser, so a malformed cached payload cannot
    // re-introduce HTML interpretation. buildResultNode constructs the
    // tree via DOM API only.
    el.replaceChildren(buildResultNode(cached, ca, installId))
    showBox()
    triggerResultAnimations(el)
    attachClose(cached.aiSummary ?? null, cached.flags ?? null)
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

  el.replaceChildren(buildSkeletonNode())
  showBox()
  attachClose(null)

  try {
    const headers: Record<string, string> = installId ? { "X-Antares-Install": installId } : {}
    const devTier = await readDevTierOverride()
    if (devTier) headers["X-Antares-Dev-Tier"] = devTier
    const res = await fetchWithRetry(`${API}?ca=${ca}`, controller.signal, headers)
    if (controller.signal.aborted) return
    const quota = extractQuotaFromHeaders(res.headers)
    const data = await res.json() as ScanResponseData
    if (controller.signal.aborted) return
    if (quota) data._quota = quota
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    el.replaceChildren(buildResultNode(data, ca, installId))
    showBox()
    triggerResultAnimations(el)
    attachClose(data.aiSummary ?? null, data.flags ?? null)
    attachAnalysisBtn(ca)
    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(data, ca)
    })
  } catch (e: unknown) {
    if (controller.signal.aborted) return
    // Quota exhausted: render a clear "you've hit the cap" overlay
    // with an upgrade CTA — never silently hide the box, that just
    // makes the extension look broken on the 26th scan of the day.
    if (e instanceof QuotaExhaustedError) {
      logger.info("scanner", "quota exhausted", {
        used: e.quota.used,
        limit: e.quota.limit,
        resetAt: e.quota.resetAt,
      })
      if (state.lastCA === ca) {
        if (state.boxEl) state.boxEl.className = "box caution"
        el.replaceChildren(buildQuotaExhaustedNode(e.quota, installId))
        showBox()
        attachClose(null)
      }
      return
    }
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
