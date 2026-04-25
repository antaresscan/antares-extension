import type { ScanResponseData } from "../../shared/types"

export const scanCache = new Map<string, { data: ScanResponseData; ts: number }>()

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
