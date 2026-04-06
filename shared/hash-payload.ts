/**
 * Encode a scan result payload as a base64url string safe for URL hash fragments.
 * Usage: token.html?ca=<MINT>#data=<encodeHashPayload(data)>
 *
 * We use btoa + URI encode instead of TextEncoder so the code runs
 * in both service workers (background.ts) and content scripts.
 */
export function encodeHashPayload(data: Record<string, unknown>): string {
  try {
    // JSON → UTF-8 string → percent-encode non-ASCII → atob-safe string → base64url
    const json = JSON.stringify(data)
    const b64 = btoa(unescape(encodeURIComponent(json)))
    // base64url: replace + → - and / → _  (no padding strip needed for hash usage)
    return b64.replace(/\+/g, "-").replace(/\//g, "_")
  } catch (e) {
    console.warn("[antares] encodeHashPayload failed", e)
    return ""
  }
}
