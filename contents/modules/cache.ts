import type { ScanResponseData } from "../../shared/types"
import { LS_PREFIX, CACHE_TTL, SCAN_CACHE_PREFIX, SCAN_CACHE_MAX_ENTRIES } from "./constants"
import { scanCache } from "./state"
import { readSessionToken } from "./session-token"
import { logger } from "../../shared/logger"

// ─── Where scan results are cached, and why ─────────────────────────────────
//
// Content scripts share the *storage* of the host page (dexscreener.com,
// pump.fun, axiom.trade…): `localStorage` inside a content script IS the
// site's localStorage. Anything written there can be read — and forged — by
// every script the site loads (ads, analytics, a compromised dependency, a
// malicious extension). The previous implementation mirrored each scan
// into `localStorage["antares_scan_<CA>"]` together with the raw 30-day
// session JWT, which (1) leaked the JWT and (2) let the page plant a fake
// "SAFE" verdict for its own token.
//
// The mirror now lives in `chrome.storage.local`, which host pages cannot
// reach, and entries are tagged with a one-way fingerprint of the session
// (never the token itself).

type ScanCacheEntry = NonNullable<ReturnType<typeof scanCache.get>>
type StorageItems = Record<string, unknown>

/** Run a sweep after this many writes so a long-lived tab can't grow the
 *  cache past the extension's shared 10 MB `chrome.storage.local` quota —
 *  a full quota would also make the session-token write fail (login break). */
const SWEEP_EVERY_WRITES = 25
let writesSinceSweep = 0

// ─── chrome.storage.local helpers (callback form, lastError checked) ───────

function storageGet(keys: string | string[] | null): Promise<StorageItems> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (items) => {
        if (chrome.runtime.lastError) {
          logger.warn("cache", "storage.get failed", chrome.runtime.lastError.message)
          resolve({})
          return
        }
        resolve((items ?? {}) as StorageItems)
      })
    } catch (e: unknown) {
      logger.warn(e)
      resolve({})
    }
  })
}

function storageSet(items: StorageItems): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          logger.warn("cache", "storage.set failed", chrome.runtime.lastError.message)
          resolve(false)
          return
        }
        resolve(true)
      })
    } catch (e: unknown) {
      logger.warn(e)
      resolve(false)
    }
  })
}

function storageRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          logger.warn("cache", "storage.remove failed", chrome.runtime.lastError.message)
        }
        resolve()
      })
    } catch (e: unknown) {
      logger.warn(e)
      resolve()
    }
  })
}

// ─── Session fingerprint ────────────────────────────────────────────────────

/**
 * One-way tag identifying the session a cache entry was fetched under.
 * `null` = anonymous (signed out). The raw token is never stored in the
 * cache: the fingerprint only needs to answer "same session as now?".
 *
 * Fails CLOSED: if hashing is unavailable we return a unique throw-away
 * value that matches nothing, so the entry is simply never reused —
 * returning `null` here would make a signed-in entry look anonymous and
 * resurrect a Pro overlay after logout.
 */
export async function sessionFingerprint(token: string | null): Promise<string | null> {
  if (!token) return null
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    return Array.from(new Uint8Array(digest).subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")
  } catch {
    return `!${Math.random().toString(36).slice(2)}`
  }
}

// ─── Legacy cleanup ─────────────────────────────────────────────────────────

/**
 * Remove the `antares_scan_*` entries earlier versions left in the HOST
 * PAGE's localStorage (each one embedded the session JWT). Runs on every
 * injection before anything else — cheap (key scan, no JSON parsing) and
 * idempotent. Safe to delete once no pre-fix version is in use.
 */
export function purgeLegacyPageStorage(): void {
  try {
    // Collect first: removing while iterating by index would skip keys.
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LS_PREFIX)) stale.push(key)
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch (e: unknown) {
    // Sandboxed iframes / blocked storage throw on access — nothing to purge.
    logger.warn(e)
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

async function loadEntry(ca: string): Promise<ScanCacheEntry | null> {
  const key = SCAN_CACHE_PREFIX + ca
  const raw = (await storageGet(key))[key] as Partial<ScanCacheEntry> | undefined
  if (!raw || !raw.data || typeof raw.ts !== "number") return null
  return { data: raw.data, ts: raw.ts, session: typeof raw.session === "string" ? raw.session : null }
}

async function persistEntry(ca: string, entry: ScanCacheEntry): Promise<void> {
  const ok = await storageSet({ [SCAN_CACHE_PREFIX + ca]: entry })
  writesSinceSweep++
  // A failed write is most likely quota — make room instead of retrying.
  if (!ok || writesSinceSweep >= SWEEP_EVERY_WRITES) {
    writesSinceSweep = 0
    await sweepScanCache()
  }
}

/**
 * Drop expired entries and cap the cache at SCAN_CACHE_MAX_ENTRIES
 * (oldest first). Only keys under SCAN_CACHE_PREFIX are touched — never
 * the session token, the scan history or any other extension state.
 */
export async function sweepScanCache(now: number = Date.now()): Promise<void> {
  const all = await storageGet(null)
  const live: Array<[string, number]> = []
  const drop: string[] = []
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SCAN_CACHE_PREFIX)) continue
    const ts = (value as { ts?: unknown } | null)?.ts
    if (typeof ts !== "number" || now - ts > CACHE_TTL) drop.push(key)
    else live.push([key, ts])
  }
  if (live.length > SCAN_CACHE_MAX_ENTRIES) {
    live.sort((a, b) => a[1] - b[1])
    for (const [key] of live.slice(0, live.length - SCAN_CACHE_MAX_ENTRIES)) drop.push(key)
  }
  if (drop.length > 0) await storageRemove(drop)
}

/**
 * Record a fresh scan: in-memory immediately, extension storage in the
 * background (the overlay never waits on a disk write).
 */
export async function cacheScan(ca: string, data: ScanResponseData, sessionToken: string | null): Promise<void> {
  const entry: ScanCacheEntry = { data, ts: Date.now(), session: await sessionFingerprint(sessionToken) }
  scanCache.set(ca, entry)
  void persistEntry(ca, entry)
}

/**
 * Return the cached scan for `ca` only when:
 *   1. The entry exists (in memory, else in extension storage) and isn't
 *      past CACHE_TTL.
 *   2. Its session fingerprint matches the CURRENT session.
 *
 * Rule (2) is the load-bearing one. Without it, a Pro user's cached
 * scan survives a logout and the overlay shows "Pro" forever even
 * though the server would now return Free. On mismatch we evict from
 * BOTH tiers so the next read goes through the API cleanly. This also
 * covers a tab Chrome discarded and re-injected (the onChanged listener
 * never fired): the cache self-corrects on the very next read.
 */
export async function getCached(ca: string): Promise<ScanResponseData | null> {
  const entry = scanCache.get(ca) ?? (await loadEntry(ca))
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    await evictCached(ca)
    return null
  }
  const currentSession = await sessionFingerprint(await readSessionToken())
  if (entry.session !== currentSession) {
    // Session changed since this scan ran — evict so we re-fetch with the
    // correct (now-current) tier resolution. Eviction wipes BOTH tiers,
    // otherwise the stored entry would resurrect on the next inject.
    await evictCached(ca)
    return null
  }
  scanCache.set(ca, entry)
  return entry.data
}

/**
 * Evict a single CA from both the in-memory Map and the extension-storage
 * mirror, so the overlay re-fetches instead of serving a stale verdict.
 */
export async function evictCached(ca: string): Promise<void> {
  scanCache.delete(ca)
  await storageRemove([SCAN_CACHE_PREFIX + ca])
}

/**
 * Wipe every cached scan, in memory and in extension storage. Called on
 * session-token changes so that signing in/out from the website forces a
 * fresh API call instead of showing whatever tier was cached before.
 *
 * Defense-in-depth alongside session-fingerprinted entries: the tag handles
 * the case where the listener didn't fire (suspended tab → re-inject).
 * The in-memory clear is synchronous (it happens before the first await),
 * so a scan started right after this call can never read a stale entry.
 */
export async function clearAllScanCache(): Promise<void> {
  scanCache.clear()
  const all = await storageGet(null)
  const keys = Object.keys(all).filter((key) => key.startsWith(SCAN_CACHE_PREFIX))
  if (keys.length > 0) await storageRemove(keys)
}
