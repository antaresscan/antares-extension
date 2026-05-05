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
  { data: ScanResponseData; ts: number; session: string | null }
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
  isInjecting: false,
  rescanTimer: null as ReturnType<typeof setTimeout> | null,
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
