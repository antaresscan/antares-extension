// shared/install-id.ts
//
// Returns an opaque per-installation identifier the extension sends to the
// API as X-Antares-Install. The server (api/_lib/middleware.ts after #278)
// uses it alongside the IP for rate-limit keying so multiple users sharing
// a corporate NAT each get a fair quota and a single abusive install can
// be limited without punishing the whole IP.
//
// The identifier is opaque (UUIDv4) and stored in chrome.storage.local —
// no personal data, no derivable identity. It is generated on first call
// and reused for the lifetime of the install.

const STORAGE_KEY = "antaresInstallId"

// Module-level cache. We resolve chrome.storage at most once per
// service-worker / content-script lifetime to keep the hot scan path cheap.
// `undefined` = not loaded yet, `null` = chrome.storage failed (we'll skip
// the header), `string` = the resolved id.
let cached: string | null | undefined = undefined

// Matches what middleware INSTALL_ID_RE expects after #278: alphanumerics
// plus dash/underscore, 8–128 chars. Defensive — guards against a corrupted
// value being read back from storage.
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/

export async function getInstallId(): Promise<string | null> {
  if (cached !== undefined) return cached

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    const existing = stored?.[STORAGE_KEY]
    if (typeof existing === "string" && INSTALL_ID_RE.test(existing)) {
      cached = existing
      return cached
    }
    const fresh = generateUuid()
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh })
    cached = fresh
    return cached
  } catch {
    // chrome.storage unavailable (test env without mock, permission denied,
    // quota error). Caching `null` ensures we don't re-attempt every fetch.
    cached = null
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
}
