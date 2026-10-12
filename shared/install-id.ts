// shared/install-id.ts
//
// Returns an opaque per-installation identifier the extension sends to the
// API as X-Antares-Install. The server (api/_lib/middleware.ts after #278)
// uses it alongside the IP for rate-limit keying so multiple users sharing
// a corporate NAT each get a fair quota and a single abusive install can
// be limited without punishing the whole IP.
//
// The identifier is opaque (UUIDv4) and stored in chrome.storage.local —
// no personal data, no derivable identity. It is generated once and reused
// for the lifetime of the install.
//
// Who generates it: background.ts calls getInstallId() from chrome.runtime.onInstalled, so the id exists before
// the first scan, the first content script or the first Options page ask for it. The lazy path below stays as the
// fallback (an install that predates this, a cleared storage), and is written to be safe when several extension
// contexts (service worker, content scripts in every tab, Options page) reach it at the same moment.

const STORAGE_KEY = "antaresInstallId"

// Module-level cache. We resolve chrome.storage at most once per
// service-worker / content-script lifetime to keep the hot scan path cheap.
// `undefined` = not loaded yet, `null` = chrome.storage failed (we'll skip
// the header), `string` = the resolved id.
let cached: string | null | undefined = undefined
// The resolution in progress, shared by every caller of THIS context until it settles. Without it, two calls that arrive
// before `cached` is set (the first scan and the Options page, say) each read an empty storage, each generate their own
// id and each write it: one overwrites the other, and the loser keeps using an id that is no longer the stored one.
let inflight: Promise<string | null> | null = null

// Matches what middleware INSTALL_ID_RE expects after #278: alphanumerics
// plus dash/underscore, 8–128 chars. Defensive — guards against a corrupted
// value being read back from storage.
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/

export function getInstallId(): Promise<string | null> {
  if (cached !== undefined) return Promise.resolve(cached)
  if (!inflight) {
    inflight = resolveInstallId()
      .then((id) => {
        cached = id
        return id
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

async function readStoredId(): Promise<string | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const existing = stored?.[STORAGE_KEY]
  return typeof existing === "string" && INSTALL_ID_RE.test(existing) ? existing : null
}

async function resolveInstallId(): Promise<string | null> {
  try {
    const existing = await readStoredId()
    if (existing) return existing
    const fresh = generateUuid()
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh })
    // Another context may have written its own id between our read and our write (chrome.storage has no compare-and-set):
    // read back and adopt what is REALLY stored, so every context settles on the same id. `?? fresh` only if the read-back
    // finds nothing usable.
    return (await readStoredId()) ?? fresh
  } catch {
    // chrome.storage unavailable (test env without mock, permission denied,
    // quota error). Caching `null` ensures we don't re-attempt every fetch.
    return null
  }
}

function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // Defensive fallback — modern Plasmo targets ship crypto.randomUUID, but
  // never assume. Format mirrors UUIDv4 shape so it passes INSTALL_ID_RE.
  const segments = [8, 4, 4, 4, 12].map(len => {
    let out = ""
    for (let i = 0; i < len; i++) {
      out += Math.floor(Math.random() * 16).toString(16)
    }
    return out
  })
  return segments.join("-")
}

// Test-only helper. Production callers should never reach the cache.
export function _resetInstallIdCacheForTests(): void {
  cached = undefined
  inflight = null
}
