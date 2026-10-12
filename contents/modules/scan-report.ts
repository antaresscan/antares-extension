import type { ScanResponseData, ScanResultMessage } from "../../shared/types"
import { logger } from "../../shared/logger"

// The service worker (background.ts) owns the toolbar badge, the
// risk-escalation notification and the local scan history. It does not fetch
// scans itself any more: the overlay already did, with the session headers.
// So every verdict the overlay shows is reported to it with this message.
//
// Content-script rule (incident PR #510): this module imports types and the
// logger only. Never import the Zod schemas here.

const RISKS = new Set(["SAFE", "CAUTION", "DANGER", "RUG"])

// A symbol only labels the notification / history row; cap it so a hostile
// upstream name cannot flood either.
const MAX_SYMBOL_LENGTH = 24

/**
 * The SCAN_RESULT message for a scan payload, or null when the payload has no
 * verdict the worker could show (unknown risk label, missing risk).
 */
export function buildScanResultMessage(ca: string, data: ScanResponseData): ScanResultMessage | null {
  if (typeof data.risk !== "string" || !RISKS.has(data.risk)) return null
  const rawSymbol = data.tokenSymbol || data.pair?.baseToken?.symbol || ""
  return {
    type: "SCAN_RESULT",
    ca,
    risk: data.risk,
    score: typeof data.score === "number" && Number.isFinite(data.score) ? data.score : 0,
    symbol: typeof rawSymbol === "string" ? rawSymbol.slice(0, MAX_SYMBOL_LENGTH) : "",
  }
}

/**
 * Tell the service worker which verdict the overlay is showing. Fire and
 * forget: the badge / alert / history are a convenience and must never break
 * or slow the overlay, whatever happens on the other side (worker asleep,
 * extension reloaded and this content script orphaned, ...).
 */
export function reportScanResult(ca: string, data: ScanResponseData): void {
  const message = buildScanResultMessage(ca, data)
  if (!message) return
  try {
    const sent = chrome.runtime.sendMessage(message) as Promise<unknown> | undefined
    void sent?.catch(() => { /* worker unreachable: nothing to do */ })
  } catch (e: unknown) {
    logger.debug("scanner", "SCAN_RESULT not sent", String(e))
  }
}
