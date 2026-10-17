import type { ScanResponseData, QuotaStatus } from "../../shared/types"
import { API, IGNORE, RISK_CLASS } from "./constants"
import { state, resetSourceGap } from "./state"
import { getCached, getStale, cacheScan, expireCached } from "./cache"
import { SCAN_BUDGET_MS, STALE_TICK_MS, SLOW_SCAN_HINT, SOURCE_GAP_GIVE_UP_MS, SOURCE_GAP_REPEAT_MS, sleep, recoveryDelayMs, scannedAgoText, scannedAgoOf, sourceGapOf, sourceGapRetryAt, sourceGapText } from "./resilience"
import { readSessionToken } from "./session-token"
import { getBox, showBox, attachClose, attachAnalysisBtn, triggerResultAnimations, applyFinalAnimationValues, buildResultNode, buildSkeletonNode, hideBox, appendScannedAgo, updateScannedAgo, appendSourceGap, updateSourceGap } from "./components"
import { scanRateLimiter } from "../../shared/rate-limit"
import { logger } from "../../shared/logger"
import { getInstallId } from "../../shared/install-id"
import { reportScanResult } from "./scan-report"
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
// a few times so the overlay reflects the post-crash state as it settles
// (e.g. a CAUTION token that flips to DANGER once the crash is priced in).
//
// TWO failure modes this guards against, both reported as "the overlay
// refreshes itself non-stop":
//
//  1. INFINITE LOOP. A crashed/rugged token stays below -30%/1h forever,
//     so the timer re-armed on every scan() completion with no stop
//     condition — an endless 5s refresh. Fixed with a hard cap
//     (MAX_PRICE_CRASH_RESCANS): the feature only needs to catch the
//     verdict settling in the first ~15s after a crash, not poll for the
//     lifetime of the tab.
//
//  2. VISIBLE RELOAD. The rescan used a non-silent scan(), which reset
//     the box to a skeleton and replayed the score count-up animation on
//     every tick. Now it uses silent mode — the existing "update in place
//     without a visible reload" path (keeps the overlay on screen, no
//     skeleton, no re-animation, just a subtle topbar flash on swap).
//
// Side effect still handled: scan() replaces the box subtree and wipes any
// open disclosure panel. If a panel is open when the timer fires we skip
// the rescan and re-arm (without consuming budget) so the overlay stays
// stable while the user is reading.
const MAX_PRICE_CRASH_RESCANS = 3

export function scheduleRescanIfPriceCrash(data: ScanResponseData, ca: string) {
  if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null }

  // Reset the rescan budget when the active token changes.
  if (state.rescanCountCA !== ca) {
    state.rescanCountCA = ca
    state.rescanCount = 0
  }

  const pc1h = typeof data.priceChange1h === "number" ? data.priceChange1h : null
  if (pc1h === null || pc1h >= -30) return

  // Budget exhausted: stop re-arming. This is what breaks the infinite
  // loop for a token that never climbs back above -30%/1h.
  if (state.rescanCount >= MAX_PRICE_CRASH_RESCANS) return

  state.rescanTimer = setTimeout(() => {
    state.rescanTimer = null
    // Postpone (don't consume budget) if the user has a disclosure panel
    // open — re-rendering underneath them would close it and feel like a
    // refresh bug.
    const aiOpen = state.shadow?.querySelector("#ant-ai-summary.open")
    const cfOpen = state.shadow?.querySelector("#ant-critical-flags.open")
    if (aiOpen || cfOpen) {
      scheduleRescanIfPriceCrash(data, ca)
      return
    }
    state.rescanCount++
    // Stop serving it as fresh, in memory AND in the extension-private storage mirror, but keep it for as long as it may be shown stale:
    // if this rescan fails because the scanner is down, the old verdict of a token that crashed must not be lost with it.
    void expireCached(ca)
    state.lastCA = ""
    state.manuallyDismissed = false
    // silent: keep the overlay on screen, no skeleton flash, no score
    // count-up replay — just refresh the data in place.
    void scan(ca, { silent: true })
  }, 5_000)
}

const MAX_RETRIES = 3
const BASE_RETRY_DELAY = 1500

/** The server refused the request itself (a 4xx that is not "too many requests" or "timeout"): trying again cannot change the answer. */
function isClientRefusal(e: unknown): boolean {
  if (!(e instanceof Error) || !/^\d{3}$/.test(e.message)) return false
  const status = parseInt(e.message, 10)
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

function isRetryable(e: unknown): boolean {
  if (e instanceof Error) {
    const status = parseInt(e.message, 10)
    if (status === 429) return true
    if (status >= 500) return true
    if (isClientRefusal(e)) return false
    if (e.name === "AbortError") return false
    if (e.message === "Failed to fetch") return true
  }
  return true
}

export async function fetchWithRetry(
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
          await sleep(delay, signal)
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
      await sleep(delay, signal)
    }
  }
  throw lastError
}

// ─── When the scanner cannot be reached ────────────────────────────────────────
//
// The overlay shows the last known verdict, with when it was scanned, if the server allowed it for that verdict (cache.ts getStale, the rule
// is in api/_lib/helpers.ts); otherwise the loading screen stays. There is never an error screen. Either way it tries again by itself
// (resilience.ts RECOVERY_DELAYS_MS) and swaps the answer in as soon as the scanner is back; the user never has to click, and a verdict that
// is too old to be shown is not.

/** The class of the card an answer draws: the verdict's, or "limited" when a source did not answer (no verdict is shown then). */
function cardClassOf(data: ScanResponseData): string {
  return sourceGapOf(data) ? "limited" : (RISK_CLASS[data.risk] ?? "")
}

/**
 * What the panels (AI summary, Critical Flags) are given. A scan with a silent source has no verdict, so no summary of one (the AI text talks about
 * the verdict it reached) and no verdict for the flags panel; the flags themselves, which name the silent source for a Pro caller, stay.
 */
function panelArgs(data: ScanResponseData): [string | null, ScanResponseData["flags"] | null, string | null] {
  return sourceGapOf(data) ? [null, data.flags ?? null, null] : [data.aiSummary ?? null, data.flags ?? null, data.risk ?? null]
}

function clearRecovery() {
  if (state.recoveryTimer) { clearTimeout(state.recoveryTimer); state.recoveryTimer = null }
  if (state.staleExpiryTimer) { clearTimeout(state.staleExpiryTimer); state.staleExpiryTimer = null }
  state.recoveryCa = ""
  state.recoveryAttempt = 0
  state.recoveryStartedAt = 0
}

function scheduleRecovery(ca: string) {
  if (state.recoveryCa !== ca) {
    if (state.recoveryTimer) clearTimeout(state.recoveryTimer)
    state.recoveryCa = ca
    state.recoveryAttempt = 0
    state.recoveryStartedAt = Date.now()
  }
  if (state.recoveryTimer) { clearTimeout(state.recoveryTimer); state.recoveryTimer = null }
  const delay = recoveryDelayMs(state.recoveryAttempt, Date.now() - state.recoveryStartedAt)
  if (delay === null) return // given up: what is on screen stays
  state.recoveryAttempt++
  state.recoveryTimer = setTimeout(() => {
    state.recoveryTimer = null
    // The user moved on, closed the box, or the scanner already answered: nothing to recover.
    if (state.lastCA !== ca || state.manuallyDismissed || !state.failureView) { clearRecovery(); return }
    // A hidden tab does not need the answer now (visibilitychange asks again as soon as it is visible).
    if (typeof document !== "undefined" && document.hidden) { scheduleRecovery(ca); return }
    void scan(ca, { silent: true, refresh: true })
  }, delay)
}

/** While the old verdict is on screen: keep its age honest, and take it off at the moment the server's window for it is over. */
function armStaleTick(ca: string, madeAt: number, staleUntil: number) {
  if (state.staleExpiryTimer) clearTimeout(state.staleExpiryTimer)
  state.staleExpiryTimer = setTimeout(() => {
    state.staleExpiryTimer = null
    if (state.lastCA !== ca || state.failureView !== "stale") return
    if (Date.now() >= staleUntil) { showWaitingView(getBox()); return }
    updateScannedAgo(getBox(), scannedAgoText(Date.now() - madeAt))
    armStaleTick(ca, madeAt, staleUntil)
  }, Math.max(0, Math.min(STALE_TICK_MS, staleUntil - Date.now())))
}

/**
 * The SERVER served the verdict of the last time a data source could be read (an issuer-backed token while DexScreener is down: `scannedAgoSec`).
 * The card is an old verdict, so the same line says how old it is, the age keeps being refreshed, and the overlay keeps asking, like for an old
 * verdict it could not refresh itself, until the data source answers again and the fresh verdict replaces it.
 */
function showServedFromMemory(ca: string, el: HTMLDivElement, ageSec: number) {
  const madeAt = Date.now() - ageSec * 1000
  if (el.querySelector(".scanned-ago")) updateScannedAgo(el, scannedAgoText(Date.now() - madeAt))
  else appendScannedAgo(el, scannedAgoText(Date.now() - madeAt))
  state.failureView = "stale"
  armStaleTick(ca, madeAt, Infinity)
  scheduleRecovery(ca)
}

// ─── When a data source did not answer ─────────────────────────────────────────────────────────────────────────
//
// The server marks a SAFE or CAUTION reached while Helius, RugCheck, GoPlus or the chart did not answer (`sourceGap`, sent to Free callers too).
// The card is complete and stays on screen; its foot line says so and counts down to the next try (resilience.ts sourceGapRetryAt), which
// the overlay makes by itself and swaps in when the source is back, with no click. A try that cannot reach the scanner is tried again later.

/** The words of the line right now: the time left to the next try, "rescanning…" while it is under way, the bare label when the overlay has given up. */
function sourceGapNow(): string {
  if (Date.now() - state.gapStartedAt >= SOURCE_GAP_GIVE_UP_MS) return sourceGapText(null)
  return sourceGapText(state.gapRetryAt - Date.now())
}

/** Keep the number in the line true, second by second, until the try is made. */
function armSourceGapTick(ca: string) {
  if (state.gapTickTimer) clearTimeout(state.gapTickTimer)
  state.gapTickTimer = setTimeout(() => {
    state.gapTickTimer = null
    if (state.gapCa !== ca || state.lastCA !== ca) return
    if (!updateSourceGap(getBox(), sourceGapNow())) return
    if (state.gapRetryAt - Date.now() > 0) armSourceGapTick(ca)
  }, 1000)
}

/** Put the line on the card (or change its words) and plan the next try for `retryAt`. */
function armSourceGap(ca: string, el: HTMLDivElement, retryAt: number) {
  if (state.gapRetryTimer) { clearTimeout(state.gapRetryTimer); state.gapRetryTimer = null }
  if (state.gapTickTimer) { clearTimeout(state.gapTickTimer); state.gapTickTimer = null }
  state.gapRetryAt = retryAt
  const gaveUp = Date.now() - state.gapStartedAt >= SOURCE_GAP_GIVE_UP_MS
  if (!updateSourceGap(el, sourceGapNow())) appendSourceGap(el, sourceGapNow())
  if (gaveUp) return // the line stays, bare; a new scan (navigation, reload) starts over
  armSourceGapTick(ca)
  state.gapRetryTimer = setTimeout(() => {
    state.gapRetryTimer = null
    // The user moved on or closed the box: nothing to retry.
    if (state.gapCa !== ca || state.lastCA !== ca || state.manuallyDismissed) { resetSourceGap(); return }
    // A hidden tab does not need the answer now (visibilitychange asks again as soon as it is visible): look again in a moment.
    if (typeof document !== "undefined" && document.hidden) { armSourceGap(ca, getBox(), Date.now() + 10_000); return }
    state.gapAttempt++
    void scan(ca, { silent: true, refresh: true })
  }, Math.max(0, retryAt - Date.now()))
}

/** A fresh SAFE or CAUTION with `sourceGap`: the line and the countdown. A first gap for this token starts the count of tries. */
function showSourceGap(ca: string, el: HTMLDivElement, data: ScanResponseData, receivedAt: number) {
  if (state.gapCa !== ca) {
    resetSourceGap()
    state.gapCa = ca
    state.gapStartedAt = Date.now()
  }
  state.gapScore = data.score
  armSourceGap(ca, el, sourceGapRetryAt(data, receivedAt, state.gapAttempt, Date.now()))
}

/** The loading screen, kept while the scanner cannot be reached: it is already on screen when the first scan fails, and comes back when an old verdict is taken off. */
function showWaitingView(el: HTMLDivElement) {
  if (state.staleExpiryTimer) { clearTimeout(state.staleExpiryTimer); state.staleExpiryTimer = null }
  if (!el.querySelector(".skel")) {
    if (state.boxEl) state.boxEl.className = "box"
    el.replaceChildren(buildSkeletonNode())
    showBox()
    attachClose(null)
  }
  // The scan is past its limit: the foot of the loading screen says why it stays, at once, not after the usual 3 s. (Within its normal time
  // the loading screen says "Still loading…".)
  const hint = el.querySelector(".skel-slow-hint")
  if (hint) {
    hint.textContent = SLOW_SCAN_HINT
    hint.classList.add("now")
  }
  state.failureView = "waiting"
}

async function showFailure(ca: string, installId: string | null, el: HTMLDivElement): Promise<void> {
  if (state.failureView === "waiting") { scheduleRecovery(ca); return }

  const stale = await getStale(ca)
  if (state.lastCA !== ca) return // the user moved on while the cache was read

  if (!stale) {
    showWaitingView(el)
    scheduleRecovery(ca)
    return
  }

  const scannedAgo = scannedAgoText(Date.now() - stale.madeAt)
  if (state.failureView === "stale") {
    // Already showing it: only the age changes (rebuilding the card would close a panel the user is reading).
    updateScannedAgo(el, scannedAgo)
  } else {
    el.replaceChildren(buildResultNode(stale.data, ca, installId))
    appendScannedAgo(el, scannedAgo)
    showBox()
    applyFinalAnimationValues(el)
    attachClose(...panelArgs(stale.data))
    attachAnalysisBtn(ca)
    state.failureView = "stale"
  }
  // The moment the server allows it no longer, the old verdict goes: the loading screen, not a stale SAFE kept on screen.
  armStaleTick(ca, stale.madeAt, stale.staleUntil)
  scheduleRecovery(ca)
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
  /** Ask the server even when the overlay's own memory holds a fresh answer (a background attempt of the recovery: the answer it holds is the one it is trying to replace). */
  refresh?: boolean
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
  const cached = opts.refresh ? null : await getCached(ca)
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
  // A scan the user (or a navigation) started begins a new cycle; a background attempt of the recovery (silent) continues the current one.
  if (!opts.silent || state.recoveryCa !== ca) clearRecovery()
  if (!opts.silent || state.gapCa !== ca) resetSourceGap()
  if (!opts.silent) state.failureView = null

  // Snapshot whether the overlay was already showing rendered content at
  // the START of this call. Silent mode only suppresses the skeleton +
  // animations when there's something worth preserving — if the box is
  // hidden (first scan, prior error, user-dismissed) silent has nothing
  // to do and we render normally.
  const wasOverlayVisible =
    el.style.display !== "none" &&
    (state.boxEl?.style.display ?? "") !== "none"
  // The overlay was waiting for the scanner (the loading screen is on screen): an attempt of the recovery keeps that screen, and the verdict
  // comes in with the normal entrance, as for a first scan.
  const wasWaiting = state.failureView === "waiting"
  const skipFlashUI = !!opts.silent && wasOverlayVisible && !wasWaiting

  // Resolve install_id once up-front so every render path (cached,
  // loading skeleton, result) can bake it into
  // upgrade-CTA hrefs synchronously. Async window.open in click
  // handlers gets popup-blocked, so the install_id must be present at
  // the moment the <a> is constructed, not awaited inside a click.
  const installId = await getInstallId()

  // ── Cached path ──────────────────────────────────────────────────────────────
  if (cached) {
    // The user moved on while the install id was read: a newer scan owns the overlay, this answer is not for the page on screen.
    if (state.lastCA !== ca) return
    // A fresh answer is in hand: whatever the overlay was showing because the scanner could not be reached is over. (Unless the answer is itself
    // a verdict the server served from memory, see showServedFromMemory.)
    const cachedMemoryAge = scannedAgoOf(cached)
    if (cachedMemoryAge === null) {
      clearRecovery()
      state.failureView = null
    }
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
    attachClose(...panelArgs(cached))
    attachAnalysisBtn(ca)
    // Badge / alert / history follow what the overlay shows, cached or not.
    reportScanResult(ca, cached)
    if (cachedMemoryAge !== null) showServedFromMemory(ca, el, cachedMemoryAge)
    else if (sourceGapOf(cached)) showSourceGap(ca, el, cached, Date.now())
    else resetSourceGap()
    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(cached, ca)
    })
    return
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────────
  const controller = new AbortController()
  state.currentScanController = controller
  // The scan waits at most SCAN_BUDGET_MS. The same controller ends the request, the reading of the body and the waits between attempts; a
  // scan that the user or a navigation cancelled is told apart from one that ran out of time (the first is silent, the second is a failure).
  let timedOut = false
  const budgetTimer = setTimeout(() => { timedOut = true; controller.abort() }, SCAN_BUDGET_MS)
  const cancelled = () => controller.signal.aborted && !timedOut

  if (!skipFlashUI) {
    // Normal first-load / nav path: show the skeleton while we fetch.
    // Reset className to neutral here — the skeleton predates the actual
    // verdict result, so we don't want a leftover verdict colour bleeding
    // through. buildResultNode will set the correct verdict class when
    // the fetch returns.
    if (!wasWaiting) {
      if (state.boxEl) state.boxEl.className = "box"
      el.replaceChildren(buildSkeletonNode())
      showBox()
      attachClose(null)
    }
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
    if (cancelled()) return
    const quota = extractQuotaFromHeaders(res.headers)
    const raw: unknown = await res.json()
    if (cancelled()) return
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
    // Tag the entry with a fingerprint of the session used for this fetch
    // (never the token itself) so getCached() can later detect login/logout
    // drift and force a re-fetch instead of serving the stale tier. The
    // persistent mirror lives in chrome.storage.local — NOT the host page's
    // localStorage, which any script on the site can read and forge.
    await cacheScan(ca, data, sessionToken ?? null)
    // Cancelled while the answer was being cached (it hashes the session first): kept in the cache, never drawn over the newer scan.
    if (cancelled()) return
    // Hold the shimmer for the minimum visible duration before swapping
    // in the result. Only matters on silent rescans (where the shimmer
    // is the loading affordance) — non-silent paths show a skeleton
    // which has its own pulse animation and doesn't need this gate.
    if (skipFlashUI) {
      const elapsed = Date.now() - shimmerStartedAt
      if (elapsed < MIN_SHIMMER_MS) {
        await new Promise<void>((r) => setTimeout(r, MIN_SHIMMER_MS - elapsed))
      }
      if (cancelled()) return
    }
    // The scanner answered: whatever the overlay was showing because it could not (the old verdict, the loading screen) is over. Unless the
    // answer is itself a verdict the server served from memory because a data source is down (showServedFromMemory): then the overlay keeps asking.
    const memoryAge = scannedAgoOf(data)
    if (memoryAge === null) {
      clearRecovery()
      state.failureView = null
    } else if (state.failureView === "stale" && el.querySelector(".scanned-ago") && state.boxEl?.classList.contains(cardClassOf(data))) {
      // The same old verdict again (the data source is still down): only its age changes, nothing is redrawn (no flash every minute).
      showServedFromMemory(ca, el, memoryAge)
      return
    }
    const gap = sourceGapOf(data)
    if (!gap) resetSourceGap()
    // The Limited data card again (the source is still down): only the line changes, nothing is redrawn (no flash, a panel the user has open stays open).
    if (gap && state.gapCa === ca && el.querySelector(".source-gap") && state.boxEl?.classList.contains("limited")) {
      showSourceGap(ca, el, data, Date.now())
      return
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
    attachClose(...panelArgs(data))
    attachAnalysisBtn(ca)
    if (memoryAge !== null) showServedFromMemory(ca, el, memoryAge)
    else if (gap) showSourceGap(ca, el, data, Date.now())
    // Badge / alert / history follow what the overlay shows, cached or not.
    reportScanResult(ca, data)
    chrome.storage.local.get(["autoRescan"], (prefs) => {
      if (prefs.autoRescan !== false) scheduleRescanIfPriceCrash(data, ca)
    })
  } catch (e: unknown) {
    if (cancelled()) return
    logger.warn("scanner", timedOut ? "scan timed out" : "scan failed after retries", e)
    chrome.runtime.sendMessage({ type: "LOG_ERROR", message: (e as Error).message, stack: (e as Error).stack }).catch(() => {})
    // Don't tear down a visible overlay on a silent-fetch failure —
    // a transient network blip during a session-change refresh shouldn't
    // make the user's working overlay disappear. Preserve what they had
    // and let the next legitimate scan trigger retry.
    //
    // For non-silent failures (initial load / nav) we used to hide the
    // box outright (`display: none`), which made the extension look
    // broken. Then: an error screen with a Retry button. Now showFailure: the last known verdict when the server allows showing it
    // (with when it was scanned), else the loading screen, which stays; and the overlay tries again by itself. A background attempt of that recovery (silent, with
    // a failure view already on screen) is handled there too, so the screen does not flip back to a loading state or lose a panel the
    // user has open.
    // The server refused the request itself (an invalid address, say): nothing can be scanned here and retrying cannot help, so the overlay
    // goes away quietly, as it does for a page with no token.
    if (isClientRefusal(e)) {
      clearRecovery()
      state.failureView = null
      if (state.lastCA === ca) hideBox()
      return
    }
    // A try of the source-gap countdown that could not reach the scanner: the card and its line stay, the next try is a minute away.
    if (state.gapCa === ca && state.lastCA === ca && el.querySelector(".source-gap")) {
      armSourceGap(ca, el, Date.now() + SOURCE_GAP_REPEAT_MS)
      return
    }
    if (state.lastCA === ca && (!skipFlashUI || state.failureView)) {
      try {
        await showFailure(ca, installId, el)
      } catch (err: unknown) {
        // Whatever goes wrong while drawing the old verdict, the overlay still answers: the loading screen, and it keeps trying.
        logger.warn("scanner", "could not show the last known verdict", err)
        showWaitingView(el)
        scheduleRecovery(ca)
      }
    }
  } finally {
    clearTimeout(budgetTimer)
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
