import type { ScanResponseData } from "../../shared/types"

/**
 * Cache entries carry the session token that was active at scan time.
 * On read, getCached() compares the entry's session to the CURRENT
 * session and invalidates on mismatch — so a Pro overlay can never
 * survive a logout, and a Free overlay can never survive a Pro login,
 * even when the chrome.storage.onChanged listener missed the change
 * (e.g. tab was discarded by Chrome and re-injected fresh from LS).
 *
 * `session: null` represents "anonymous at scan time" (signed-out user).
 * That entry is valid only while the user remains signed out.
 */
export const scanCache = new Map<
  string,
  {
    data: ScanResponseData
    ts: number
    session: string | null
    /** Until when the answer may be shown without asking again (device clock). Absent on an entry written by an older version: ts + CACHE_TTL. */
    freshUntil?: number
    /** Until when it may still be shown, marked as old, if the scanner cannot be reached (device clock). Absent: freshUntil. */
    staleUntil?: number
  }
>()

export const state = {
    enabled: true,
  host: null as HTMLElement | null,
  shadow: null as ShadowRoot | null,
  boxEl: null as HTMLDivElement | null,
  hideTimeout: null as ReturnType<typeof setTimeout> | null,
  lastCA: "",
  manuallyDismissed: false,
  currentScanController: null as AbortController | null,
  // Why the overlay is not showing a fresh verdict: "stale" = the last known verdict, with when it was scanned; "waiting" = the loading screen,
  // kept while the scanner cannot be reached (there is never an error screen). null = a fresh verdict, or a scan in progress.
  // While it is set the overlay tries again by itself (scanner.ts scheduleRecovery).
  failureView: null as "stale" | "waiting" | null,
  recoveryTimer: null as ReturnType<typeof setTimeout> | null,
  recoveryCa: "",
  recoveryAttempt: 0,
  recoveryStartedAt: 0,
  staleExpiryTimer: null as ReturnType<typeof setTimeout> | null,
  isInjecting: false,
  rescanTimer: null as ReturnType<typeof setTimeout> | null,
  // Budget for the post-price-crash auto-rescan (scheduleRescanIfPriceCrash).
  // A crashed token stays below the -30%/1h trigger indefinitely, so without
  // a cap the 5s rescan re-arms forever — the "overlay refreshes non-stop"
  // bug. rescanCount tracks how many rescans we've fired for rescanCountCA;
  // it resets when the active token changes.
  rescanCount: 0,
  rescanCountCA: "",
  // Reference to the host-reinjection MutationObserver so we can disconnect
  // it on extension disable. Audit flagged the previous unreferenced
  // observer as a permanent listener leaking on every DOM mutation.
  hostObserver: null as MutationObserver | null,
  // drag state
  dragOX: 0,
  dragOY: 0,
  posX: 0,
  posY: 0,
  pendingX: 0,
  pendingY: 0,
  rafId: null as number | null,
  activePointerId: null as number | null,
  // nav state
  navDebounce: null as ReturnType<typeof setTimeout> | null,
  lastNavPath: "",
  lastUrl: "",
}
