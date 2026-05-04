import type { ScanResponseData } from "../../shared/types"
import { LS_PREFIX, CACHE_TTL } from "./constants"
import { scanCache } from "./state"
import { logger } from "../../shared/logger"

export function hydrateCacheFromLS() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(LS_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as { data?: ScanResponseData; ts?: number }
      if (!parsed?.data || !parsed?.ts) continue
      if (Date.now() - parsed.ts > CACHE_TTL) { localStorage.removeItem(key); continue }
      scanCache.set(key.slice(LS_PREFIX.length), { data: parsed.data, ts: parsed.ts })
    }
  } catch (e: unknown) { logger.warn(e) }
}

export function getCached(ca: string): ScanResponseData | null {
  const e = scanCache.get(ca)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL) { scanCache.delete(ca); return null }
  return e.data
}

export function saveToLS(ca: string, data: ScanResponseData) {
  try { localStorage.setItem(LS_PREFIX + ca, JSON.stringify({ data, ts: Date.now() })) } catch (e: unknown) { logger.warn(e) }
}

/**
 * Wipe every cached scan, both the in-memory Map and the localStorage
 * mirror. Called on session-token changes so that signing in/out from
 * the website forces a fresh API call on the next scan instead of
 * showing whatever tier was cached at the previous session state.
 *
 * Without this the user-reported bug fires: log in → scan TOKEN_A
 * (overlay shows Pro, cached) → log out → re-open TOKEN_A → still
 * shows Pro because we hit the cached entry. New tokens scan correctly
 * because they have no cache entry yet.
 */
export function clearAllScanCache() {
  scanCache.clear()
  try {
    // Iterate the keys defensively — removing entries while iterating
    // localStorage by index would skip items.
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LS_PREFIX)) toRemove.push(key)
    }
    for (const key of toRemove) localStorage.removeItem(key)
  } catch (e: unknown) {
    logger.warn(e)
  }
}
