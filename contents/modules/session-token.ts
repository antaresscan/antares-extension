/**
 * Read the website-issued session JWT from chrome.storage.local.
 *
 * Returns the raw token string when the user is signed in, or null when
 * signed out / never signed in / storage error. Used by:
 *
 *   - scanner.ts → forwards as `X-Antares-Session` on every /api/scan call
 *     so the API can resolve the caller's tier from their email.
 *   - cache.ts   → stamps every cache entry with the token at scan time so
 *     stale entries auto-invalidate on session change (login/logout)
 *     even when the chrome.storage.onChanged listener missed (e.g. tab
 *     was discarded by Chrome's memory manager and re-injected fresh).
 *
 * Lives at module scope (not inlined per-caller) so the scanner and the
 * cache compare against the SAME source-of-truth — otherwise a small
 * read drift between them would defeat the session-tag check.
 */
export async function readSessionToken(): Promise<string | null> {
  try {
    const data = await new Promise<{ antares_session_token?: string }>((resolve) =>
      chrome.storage.local.get(["antares_session_token"], (v) =>
        resolve(v as { antares_session_token?: string }),
      ),
    )
    const t = data.antares_session_token
    return typeof t === "string" && t.length > 0 ? t : null
  } catch {
    return null
  }
}
