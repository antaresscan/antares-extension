// contents/modules/resilience.ts — what the overlay does when the scanner is slow or cannot be reached.
//
// The rules are small and pure on purpose (tested in __tests__/resilience.test.ts); scanner.ts only wires them.
//
//   1. A scan waits at most SCAN_BUDGET_MS, retries included. Before, a server that hung could keep the loading screen up for almost two
//      minutes (4 attempts of ~25 s, the server's own limit, plus 10.5 s of waiting between them).
//   2. How long an answer may be reused, and how long it may still be SHOWN, marked as old, when the scanner cannot be reached, is decided by
//      the SERVER (`freshForSec`, `staleLeftSec`, see api/_lib/helpers.ts serveWindows): a stale bad verdict is safe, a stale SAFE is not, so
//      the window depends on the verdict and on the age and agitation of the token. A server that sends neither (an older one) gets the old
//      behaviour exactly: 5 minutes, and no stale display.
//   3. When the scan failed, the overlay does not wait for a click and never shows an error: the loading screen stays (or the last known
//      verdict, with when it was scanned), it tries again by itself, quickly at first, then every minute, and swaps the answer in as soon as
//      the scanner is back.

/** The longest a scan waits for the scanner, retries included. A cold scan of even a very large token now takes 5 to 8 s. */
export const SCAN_BUDGET_MS = 15_000

/** What the loading screen says, at its foot, once a scan takes longer than expected (and it is what stays on screen while the overlay retries). */
export const SLOW_SCAN_HINT = "This scan might take longer, stay patient"

/** Waits between two background attempts after a failure; the last one repeats. The first is short: a server that was only slow has usually cached the answer by then. */
export const RECOVERY_DELAYS_MS = [3_000, 8_000, 15_000, 30_000, 60_000] as const

/** While a verdict is shown from memory, the age in its line is refreshed this often (and the verdict leaves the moment its window is over). */
export const STALE_TICK_MS = 20_000

/** After this long since the first failure the overlay stops trying by itself (a tab left open for a day on a dead scanner). */
export const RECOVERY_GIVE_UP_MS = 24 * 60 * 60_000

/** The longest an answer is ever kept, whatever the server says: a confirmed RUG may be shown for 24 h. */
const MAX_WINDOW_SEC = 24 * 3600

/** Resolves after `ms`, or at once when `signal` aborts (a wait between two attempts must not outlive the scan it belongs to). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}

/** The wait before the next background attempt, or null when it is time to stop trying. */
export function recoveryDelayMs(attempt: number, sinceFirstFailureMs: number): number | null {
  if (sinceFirstFailureMs >= RECOVERY_GIVE_UP_MS) return null
  const i = Math.max(0, Math.min(Math.floor(attempt), RECOVERY_DELAYS_MS.length - 1))
  return RECOVERY_DELAYS_MS[i]
}

const secToMs = (v: unknown, cap: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, cap) * 1000 : null

/**
 * The two moments, on THIS device's clock, that an answer received at `receivedAt` is good until:
 *   freshUntil — it may be shown without asking again (never longer than `defaultFreshMs`, whatever the server says);
 *   staleUntil — it may still be shown, marked as old, if the scanner cannot be reached (never before freshUntil).
 * The server sends durations, not dates, so a device whose clock is wrong cannot stretch them.
 */
export function windowsOf(
  data: object,
  receivedAt: number,
  defaultFreshMs: number,
): { freshUntil: number; staleUntil: number } {
  // Read as unknown: an older server sends neither field, and a value that is not a non-negative number counts as absent.
  const d = data as { freshForSec?: unknown; staleLeftSec?: unknown }
  const fresh = secToMs(d.freshForSec, defaultFreshMs / 1000) ?? defaultFreshMs
  const freshUntil = receivedAt + fresh
  const stale = secToMs(d.staleLeftSec, MAX_WINDOW_SEC)
  return { freshUntil, staleUntil: stale === null ? freshUntil : Math.max(freshUntil, receivedAt + stale) }
}

/**
 * When the verdict was MADE, as best the device can tell: the server's `fetchedAt` when it is consistent with the moment the answer was
 * received (a server cache may have held it for a while), else the moment it was received. A device clock that is far off ignores the server's date.
 */
export function madeAtOf(data: { fetchedAt?: unknown }, receivedAt: number): number {
  const f = data.fetchedAt
  if (typeof f === "number" && Number.isFinite(f) && f <= receivedAt + 60_000 && f >= receivedAt - 60 * 60_000) return Math.min(f, receivedAt)
  return receivedAt
}

/** "less than a minute ago", "5 min ago", "2 h 10 min ago", "3 d ago". */
export function staleAgeLabel(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000))
  if (s < 60) return "less than a minute ago"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

/** The line at the foot of a verdict shown from memory. */
export function scannedAgoText(ageMs: number): string {
  return `Scanned ${staleAgeLabel(ageMs)}`
}
