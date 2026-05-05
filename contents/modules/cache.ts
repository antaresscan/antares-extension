import type { ScanResponseData } from "../../shared/types"
import { LS_PREFIX, CACHE_TTL } from "./constants"
import { scanCache } from "./state"
import { readSessionToken } from "./session-token"
import { logger } from "../../shared/logger"

/**
 * Hydrate the in-memory scanCache from localStorage on content-script
 * inject. Reads every `LS_PREFIX*` entry, drops anything past CACHE_TTL,
 * and stamps each entry with the session token used at scan time so
 * getCached() can later detect login/logout drift.
 *
 * Backwards-compat: legacy entries written before session-tagging existed
 * have no `session` field — we treat them as `null` (anonymous). After
 * the upgrade, the first scan rewrites them with a real session tag.
 */
export function hydrateCacheFromLS() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(LS_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as { data?: ScanResponseData; ts?: number; session?: string | null }
      if (!parsed?.data || !parsed?.ts) continue
      if (Date.now() - parsed.ts > CACHE_TTL) { localStorage.removeItem(key); continue }
      const session = typeof parsed.session === "string" ? parsed.session : null
      scanCache.set(key.slice(LS_PREFIX.length), { data: parsed.data, ts: parsed.ts, session })
    }
  } catch (e: unknown) { logger.warn(e) }
}

/**
 * Return the cached scan for `ca` only when:
 *   1. The entry exists and isn't past CACHE_TTL.
 *   2. The session token at scan time matches the CURRENT session token.
 *
 * Rule (2) is the load-bearing one. Without it, a Pro user's cached
 * scan survives a logout and the overlay shows "Pro" forever even
 * though the server would now return Free. On mismatch we evict from
 * BOTH the in-memory Map and the LS mirror so the next read goes
 * through the API cleanly. This also handles the case where
 * chrome.storage.onChanged didn't fire (e.g. tab was discarded by
 * Chrome and re-injected fresh from LS) — the cache self-corrects on
 * the very next read.
 */
export async function getCached(ca: string): Promise<ScanResponseData | null> {
  const e = scanCache.get(ca)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL) {
    scanCache.delete(ca)
    try { localStorage.removeItem(LS_PREFIX + ca) } catch { /* LS write may fail in private mode */ }
    return null
  }
  const currentSession = await readSessionToken()
  if (e.session !== currentSession) {
    // Session changed since this scan ran — evict so we re-fetch with
    // the correct (now-current) tier resolution. Eviction wipes BOTH
    // tiers, otherwise the LS-hydrated entry would resurrect on the
    // next content-script inject.
    scanCache.delete(ca)
    try { localStorage.removeItem(LS_PREFIX + ca) } catch { /* LS write may fail in private mode */ }
    return null
  }
  return e.data
}

/**
 * Persist a scan result to localStorage with the session token used to
 * fetch it. The session is stamped so getCached() can later detect when
 * it no longer matches the live session and force a re-scan.
 */
export function saveToLS(ca: string, data: ScanResponseData, session: string | null) {
  try { localStorage.setItem(LS_PREFIX + ca, JSON.stringify({ data, ts: Date.now(), session })) } catch (e: unknown) { logger.warn(e) }
}

/**
 * Wipe every cached scan, both the in-memory Map and the localStorage
 * mirror. Called on session-token changes so that signing in/out from
 * the website forces a fresh API call on the next scan instead of
 * showing whatever tier was cached at the previous session state.
 *
 * Defense-in-depth alongside session-tagged entries: the tag handles the
 * case where this listener didn't fire (suspended tab → re-inject), and
 * this wipe keeps the LS footprint small for active tabs.
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
