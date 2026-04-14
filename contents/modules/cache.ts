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
