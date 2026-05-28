import type { ScanResponseData, QuotaStatus } from "../../shared/types"
import * as Sentry from "@sentry/browser"
import { API, QUOTA_URL, LS_PREFIX, IGNORE } from "./constants"
import { state, scanCache } from "./state"
import { getCached, saveToLS } from "./cache"
import { readSessionToken } from "./session-token"
import { getBox, showBox, attachClose, attachAnalysisBtn, triggerResultAnimations, applyFinalAnimationValues, buildResultNode, buildSkeletonNode, buildQuotaExhaustedNode, buildErrorNode } from "./components"
import { scanRateLimiter } from "../../shared/rate-limit"
import { logger } from "../../shared/logger"
import { getInstallId } from "../../shared/install-id"
// NOTE 2026-05-20: the Zod runtime validation of /api/scan responses
// was the root cause of the overlay-not-mounting incident (bisect
// confirmed: TEST-B with Zod = KO, TEST-C with Sentry hooks but no
// Zod = OK). Removing the import + the safeParse block restores the
// overlay. The schema file (shared/schemas.ts) stays around for
// future use but is no longer wired into the content-script bundle.
// If we want runtime validation back, it needs:
//   1. A real headed-Chrome E2E test that catches this regression
//      class (the current Playwright e2e is skipped in CI and never
//      caught this)
//   2. A fail-open posture that does not import the Zod schema at
//      module top-level (defer behind a flag or lazy-load)

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
    if (v === "free" || v === "pro" || v === "yearly" || v === "lifetime") return v
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
  if (
    tier !== "free" &&
    tier !== "pro" &&
    tier !== "yearly" &&
    tier !== "lifetime"
  ) {
    return undefined
  }
  const used = parseInt(headers.get("X-Antares-Quota-Used") ?? "0", 10)
  const limit = parseInt(headers.get("X-Antares-Quota-Limit") ?? "-1", 10)
  const remaining = parseInt(headers.get("X-Antares-Quota-Remaining") ?? "-1", 10)
  const resetAt = parseInt(headers.get("X-Antares-Quota-Reset") ?? "0", 10)
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined
  return { tier, used, limit, remaining, resetAt }
}

/**
 * Optimistic tier sync — re-render the visible overlay with a new tier
 * WITHOUT waiting for a full /api/scan refetch.
 *
 * Why this exists: the previous tier-sync path on chrome.storage.onChanged
 * was "clearCache + silent rescan" which forced the user to wait 2-5s for
 * /api/scan to roundtrip before the Pro/Free badge flipped. Login felt
 * "stuck on Free" for several seconds, and logout often appeared not to
 * work at all if the user navigated away during the rescan window.
 *
 * The scan DATA (verdict, score, flags) doesn't change with tier — only
 * the UI gating does. So on a session change we can:
 *   1. Resolve the new tier (logout = instant Free, login = /api/quota in
 *      ~100ms vs /api/scan's 2-5s).
 *   2. Patch `_quota.tier` on the already-cached scan data.
 *   3. Re-render the box in place.
 *
 * Net effect: tier badge swaps in <300ms (down from 2-5s) and the
 * background silent rescan still runs to refresh price/score data.
 *
 * Returns when the optimistic UI commit is done. Failures fail silently
 * — the background silent rescan is the safety net that always corrects
 * the visible tier eventually.
 */
export async function applyOptimisticTierUpdate(newToken: string | undefined): Promise<void> {
  const ca = state.lastCA
  if (!ca) return // no token page currently visible, nothing to update
  const entry = scanCache.get(ca)
  if (!entry) return // no cached scan to patch — the background rescan will produce a fresh one

  // Resolve the new quota status. Logout is unconditional Free; login
  // hits the lightweight /api/quota endpoint which already does session-
  // gated tier resolution server-side and doesn't increment any counter.
  let quota: QuotaStatus
  if (!newToken) {
    quota = { tier: "free", used: 0, limit: 50, remaining: 50, resetAt: 0 }
  } else {
    try {
      const installId = await getInstallId()
      const headers: Record<string, string> = { "X-Antares-Session": newToken }
      if (installId) headers["X-Antares-Install"] = installId
      const res = await fetch(QUOTA_URL, { headers, credentials: "include" })
      if (!res.ok) return // silent: background rescan will catch this
      const body = await res.json()
      // /api/quota response shape matches QuotaStatus exactly. Defensive
      // narrowing in case of future API drift — if the tier field is
      // missing or invalid, skip the optimistic update and let the
      // background rescan handle it.
      if (
        body?.tier !== "free" && body?.tier !== "pro" &&
        body?.tier !== "yearly" && body?.tier !== "lifetime"
      ) {
        return
      }
      quota = {
        tier: body.tier,
        used: typeof body.used === "number" ? body.used : 0,
        limit: typeof body.limit === "number" ? body.limit : -1,
        remaining: typeof body.remaining === "number" ? body.remaining : -1,
        resetAt: typeof body.resetAt === "number" ? body.resetAt : 0,
      }
    } catch {
      return
    }
  }

  // Patch the cache entry in place. The data fields stay byte-identical
  // except for _quota — buildResultNode reads _quota.tier to decide the
  // gating, so this is enough to flip the overlay's tier UI.
  const newData: ScanResponseData = { ...entry.data, _quota: quota }
  scanCache.set(ca, { data: newData, ts: entry.ts, session: newToken ?? null })

  // Re-render the box in place. getBox() returns the content container
  // that scan() also writes to; replaceChildren is atomic, no flicker.
  const el = getBox()
  if (state.boxEl?.style.display === "none") return // overlay hidden, no DOM update needed
  const installId = await getInstallId()
  el.replaceChildren(buildResultNode(newData, ca, installId))
  applyFinalAnimationValues(el)
  attachClose(newData.aiSummary ?? null, newData.flags ?? null, newData.risk ?? null)
  attachAnalysisBtn(ca)
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

/**
 * Options for `scan()`.
 *
 * `silent: true` is the "tier just changed under our feet" path — used by:
 *   - chrome.storage.onChanged on session change (login/logout)
 *   - visibilitychange when a backgrounded tab regains focus
 *
 * The promise: when an overlay is already on screen with stale data, do
 * NOT flash a skeleton on the way to the new data. Keep the existing
 * overlay visible, run the fetch in the background, and atomically swap
 * in the new result the moment it lands. Also skip entrance animations
 * (a re-render shouldn't replay the box-fade-in) and don't hide the
 * overlay on a transient network blip — the user keeps seeing what they
 * had until the next legitimate scan trigger.
 *
 * When silent is true but no overlay is currently visible (e.g. error
 * state or first-load), we fall through to the normal skeleton+animation
 * path — there's nothing on screen worth preserving.
 */
export interface ScanOptions {
  silent?: boolean
}

export async function scan(ca: string, opts: ScanOptions = {}) {
  if (!ca) return

  if (!(await scanRateLimiter.tryAcquire())) {
    const retryAfter = await scanRateLimiter.getRetryAfterMs()
    logger.warn("scanner", "scan rate-limited, retry after", retryAfter)
    return
  }

  const el = getBox()
  // getCached is async because it consults chrome.storage.local for the
  // current session token and returns null if the cached entry was
  // scanned under a different session — a Pro entry can never survive
  // a logout, even if the chrome.storage.onChanged listener missed
  // (e.g. tab was discarded by Chrome and re-injected from LS).
  const cached = await getCached(ca)
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

  // Snapshot whether the overlay was already showing rendered content at
  // the START of this call. Silent mode only suppresses the skeleton +
  // animations when there's something worth preserving — if the box is
  // hidden (first scan, prior error, user-dismissed) silent has nothing
  // to do and we render normally.
  const wasOverlayVisible =
    el.style.display !== "none" &&
    (state.boxEl?.style.display ?? "") !== "none"
  const skipFlashUI = !!opts.silent && wasOverlayVisible

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
    if (skipFlashUI) {
      // Silent rescan: skip the entrance animation BUT still write the
      // final score + bar values into the DOM. Without this, the cached
      // overlay rendered "0 / 1000" with a 0%-wide bar after every
      // login/logout because triggerResultAnimations is what writes the
      // data-target / data-w values (the score textContent is initially
      // "0" and the bar width starts at 0%).
      applyFinalAnimationValues(el)
    } else {
      triggerResultAnimations(el)
    }
    attachClose(cached.aiSummary ?? null, cached.flags ?? null, cached.risk ?? null)
    attachAnalysisBtn(ca)
    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(cached, ca)
    })
    return
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────────
  const controller = new AbortController()
  state.currentScanController = controller

  if (!skipFlashUI) {
    // Normal first-load / nav path: show the skeleton while we fetch.
    // Reset className to neutral here — the skeleton predates the actual
    // verdict result, so we don't want a leftover verdict colour bleeding
    // through. buildResultNode will set the correct verdict class when
    // the fetch returns.
    if (state.boxEl) state.boxEl.className = "box"
    el.replaceChildren(buildSkeletonNode())
    showBox()
    attachClose(null)
  } else {
    // Silent rescan with overlay already showing: KEEP the existing
    // verdict class (e.g. "box caution") so the topbar's coloured
    // gradient stays in place — the .refreshing animation slides that
    // same gradient left-to-right. The previous version reset className
    // to plain "box" before adding .refreshing, which stripped the
    // gradient entirely and made the shimmer slide an invisible blank
    // track. User-visible effect: "the animation doesn't work."
    state.boxEl?.classList.add("refreshing")
  }

  // Floor on how long the shimmer must be visible. Without this, a
  // sub-300ms API response makes the shimmer flash for an imperceptible
  // moment then disappear — reads as a UI glitch. 500ms is the lower
  // bound where motion registers as intentional rather than accidental.
  const MIN_SHIMMER_MS = 500
  const shimmerStartedAt = Date.now()

  try {
    const headers: Record<string, string> = installId ? { "X-Antares-Install": installId } : {}
    const devTier = await readDevTierOverride()
    if (devTier) headers["X-Antares-Dev-Tier"] = devTier
    // Forward the website-issued session JWT (written by the bridge on
    // /account.html sign-in). Without this the API treats every scan as
    // anonymous → returns Free regardless of the user's actual tier.
    const sessionToken = await readSessionToken()
    if (sessionToken) headers["X-Antares-Session"] = sessionToken
    const res = await fetchWithRetry(`${API}?ca=${ca}`, controller.signal, headers)
    if (controller.signal.aborted) return
    const quota = extractQuotaFromHeaders(res.headers)
    const raw = await res.json()
    if (controller.signal.aborted) return
    // RUNTIME VALIDATION REMOVED (2026-05-20, incident PR #510).
    //
    // The Zod safeParse used to live here as defence against /api/scan
    // payload drift. Bisect (TEST-B with Zod = KO, TEST-C without =
    // OK on the same user setup) proved that even with the fail-open
    // posture I added in PR #515, the mere act of importing the Zod
    // schema at module top level was enough to crash the content
    // script during boot on the user's Chrome — the overlay never
    // mounted. Pulled the import + the safeParse so the content
    // script boots cleanly. Trust the raw payload from /api/scan
    // (the backend is the source of truth, and any catastrophic type
    // mismatch will fail naturally inside buildResultNode rather
    // than killing the entire overlay path).
    //
    // Re-adding runtime validation requires:
    //   1. A real headed-Chrome E2E test that reproduces this exact
    //      crash so we never ship a Zod regression to users again.
    //   2. Either lazy-loading the Zod module or running validation
    //      behind a flag — never at module top level.
    const data = raw as ScanResponseData
    if (quota) data._quota = quota
    // Stamp the entry with the session token used for this fetch so
    // getCached() can later detect login/logout drift and force a
    // re-fetch instead of serving the stale tier.
    scanCache.set(ca, { data, ts: Date.now(), session: sessionToken ?? null })
    saveToLS(ca, data, sessionToken ?? null)
    // Hold the shimmer for the minimum visible duration before swapping
    // in the result. Only matters on silent rescans (where the shimmer
    // is the loading affordance) — non-silent paths show a skeleton
    // which has its own pulse animation and doesn't need this gate.
    if (skipFlashUI) {
      const elapsed = Date.now() - shimmerStartedAt
      if (elapsed < MIN_SHIMMER_MS) {
        await new Promise<void>((r) => setTimeout(r, MIN_SHIMMER_MS - elapsed))
      }
      if (controller.signal.aborted) return
    }
    el.replaceChildren(buildResultNode(data, ca, installId))
    showBox()
    if (skipFlashUI) {
      // Silent rescan: skip the entrance animation BUT still write the
      // final score + bar values into the DOM. Without this, the cached
      // overlay rendered "0 / 1000" with a 0%-wide bar after every
      // login/logout because triggerResultAnimations is what writes the
      // data-target / data-w values (the score textContent is initially
      // "0" and the bar width starts at 0%).
      applyFinalAnimationValues(el)
      // Completion flash: after the shimmer slides offstage, pulse the
      // topbar with a green glow for ~600ms so the user feels the swap
      // "land". Without this the shimmer just stops and the new tier
      // appears, which doesn't punctuate the moment of change. The
      // class self-removes after the animation so a follow-up rescan
      // can replay the flash. See styles.ts → @keyframes refresh-flash.
      const topbar = el.querySelector(".topbar")
      if (topbar) {
        topbar.classList.add("flash")
        setTimeout(() => topbar.classList.remove("flash"), 700)
      }
    } else {
      triggerResultAnimations(el)
    }
    attachClose(data.aiSummary ?? null, data.flags ?? null, data.risk ?? null)
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
    // Don't tear down a visible overlay on a silent-fetch failure —
    // a transient network blip during a session-change refresh shouldn't
    // make the user's working overlay disappear. Preserve what they had
    // and let the next legitimate scan trigger retry.
    //
    // For non-silent failures (initial load / nav) we used to hide the
    // box outright (`display: none`), which made the extension look
    // broken — overlay just vanished after ~10s of retries. Now we
    // render a clear error state with a one-click retry button so the
    // user knows what happened and can recover without page reload.
    if (state.lastCA === ca && !skipFlashUI) {
      // Reset the per-scan state so the retry button can re-enter
      // scan() cleanly (otherwise alreadyHandled() / dedup checks
      // would short-circuit because lastCA still points at this CA).
      el.replaceChildren(buildErrorNode(() => {
        state.lastCA = ""
        state.manuallyDismissed = false
        void scan(ca)
      }))
      showBox()
      attachClose(null)
    }
  } finally {
    if (state.currentScanController === controller) {
      state.currentScanController = null
    }
    // Defensive: strip the shimmer class on every exit path so a
    // failed/aborted silent fetch doesn't leave the topbar animating
    // forever. On success this is a no-op because buildResultNode's
    // className overwrite already removed it.
    state.boxEl?.classList.remove("refreshing")
  }
}
