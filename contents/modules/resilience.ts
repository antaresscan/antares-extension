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

/** What the loading screen says at its foot while a scan is within its normal time (it fades in after 3 s). */
export const LOADING_HINT = "Still loading…"

/** What it says instead once the scan is past its limit (SCAN_BUDGET_MS, or the request failed): it stays on screen while the overlay retries. */
export const SLOW_SCAN_HINT = "Taking longer than usual, still on it"

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

/**
 * How old the verdict is when the SERVER itself served the verdict of the last time a data source could be read (`scannedAgoSec`, sent only
 * in that case: an issuer-backed token while DexScreener is down), in seconds; null for an ordinary answer or a value that is not a
 * non-negative number. The overlay says "Scanned 6 min ago" and keeps asking until the market is readable again.
 */
export function scannedAgoOf(data: object): number | null {
  const v = (data as { scannedAgoSec?: unknown }).scannedAgoSec
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

/** The line at the foot of a verdict shown from memory. */
export function scannedAgoText(ageMs: number): string {
  return `Scanned ${staleAgeLabel(ageMs)}`
}

// ─── A verdict reached while a data source did not answer ──────────────────────────────────────────────────────────────
//
// The server marks a scan made while Helius, RugCheck or GoPlus (or the chart of an old token, or the whole scan out of time) did not answer
// `sourceGap`, Free callers included: the flags that say which source are Pro, the fact that one is missing is not. Such a scan has NO verdict for
// the user (replayed on the corpus with one source silent, a SAFE reads CAUTION, a DANGER reads SAFE, a RUG reads DANGER): the overlay shows the
// Limited data card, in the design of the others and in the four colours of the verdicts mixed; one line at its foot says what is going on and
// counts down to the next try, which the overlay makes by itself. When every source answers again the real verdict takes its place.
//
// The countdown is not a guess and not random. The server keeps such an answer 30 s (`freshForSec`, counted from `fetchedAt`), and asking
// again before that only gets the same answer back: so the first tries are made when the server's own copy is over, and the number on
// screen is the time left to it. Later tries are a minute apart (a source that is down for long is not hammered by every open tab), and
// after SOURCE_GAP_GIVE_UP_MS the line stays but stops counting.

/** The word of the card while a source is silent (it takes the place of the verdict, in the same type). */
export const LIMITED_DATA_LABEL = "LIMITED DATA"

/**
 * What the card says under it. It says why nothing is shown in the voice of a product that refuses to guess (the line at the foot says the cause and counts
 * down): a user in a hurry reads "the tool is broken" in "no verdict", and "the tool is protecting my decision" here. Chosen by the product owner, 2026-10-14.
 */
export const LIMITED_DATA_SUMMARY = "We would rather wait than mislead you"

/** The line under the Limited data card for a token whose last FULL scan said DANGER or RUG, on this device: "Last full scan: RUG, 12 min ago". */
export function lastFullScanText(risk: "DANGER" | "RUG", ageMs: number): string {
  return `Last full scan: ${risk}, ${staleAgeLabel(ageMs)}`
}

/** What the line says when the overlay has stopped trying. */
export const SOURCE_GAP_LABEL = "Source unavailable"

/** Shown when the pointer rests on the line. Plain text: nothing from the server goes in it. */
export const SOURCE_GAP_TITLE = "A data source did not answer, so this verdict may change. The scan refreshes by itself."

/** After the server's copy is over, a short margin so that the try finds the copy gone and not the very last millisecond of it. */
export const SOURCE_GAP_MARGIN_MS = 1_000

/** The first tries (the server's copy is the clock); from this one on they are SOURCE_GAP_REPEAT_MS apart. */
export const SOURCE_GAP_QUICK_TRIES = 2

/** The wait between two tries once the quick ones are used. */
export const SOURCE_GAP_REPEAT_MS = 60_000

/** After this long since the first gap seen the overlay stops trying by itself (the line stays, without a countdown). */
export const SOURCE_GAP_GIVE_UP_MS = 15 * 60_000

/** How long an answer with a gap is kept when the server does not say (an older server): what it does today for a degraded answer. */
const SOURCE_GAP_DEFAULT_FRESH_MS = 30_000

/**
 * True when the server says a data source did not answer for this scan: the overlay shows no verdict (the Limited data card). Not for a verdict
 * served from memory (its own line, "Scanned 6 min ago", already says it), and read as unknown: an older server sends nothing.
 */
export function sourceGapOf(data: object): boolean {
  return (data as { sourceGap?: unknown }).sourceGap === true && scannedAgoOf(data) === null
}

/**
 * The moment (device clock) of the next try for an answer received at `receivedAt`, `attempt` tries having been made already. The first
 * ones wait for the end of the server's copy of the answer, never less than a second from `now`; the following ones a minute.
 */
export function sourceGapRetryAt(data: object, receivedAt: number, attempt: number, now: number): number {
  const fresh = secToMs((data as { freshForSec?: unknown }).freshForSec, 3600) ?? SOURCE_GAP_DEFAULT_FRESH_MS
  const serverCopyOver = madeAtOf(data as { fetchedAt?: unknown }, receivedAt) + fresh + SOURCE_GAP_MARGIN_MS
  const earliest = now + (attempt >= SOURCE_GAP_QUICK_TRIES ? SOURCE_GAP_REPEAT_MS : 1_000)
  return Math.max(serverCopyOver, earliest)
}

/** The line: the countdown to the next try, "rescanning…" while it is under way, or the bare label once the overlay has given up (`msLeft` null). */
export function sourceGapText(msLeft: number | null): string {
  if (msLeft === null) return SOURCE_GAP_LABEL
  if (msLeft <= 0) return `${SOURCE_GAP_LABEL}, rescanning…`
  return `${SOURCE_GAP_LABEL}, rescanning in ${Math.ceil(msLeft / 1000)}s`
}
