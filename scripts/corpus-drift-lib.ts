// scripts/corpus-drift-check.ts helpers, kept free of I/O so they can be unit tested.

/** Exit codes of the drift check. The workflow tells them apart: a drift is a
 *  finding to triage, a broken check is a failure of the check itself. */
export const EXIT_OK = 0
export const EXIT_DRIFT = 1
export const EXIT_UNRELIABLE = 2

/** If more than this share of the live captures fails, the check measured
 *  nothing: production or the network was down, not the corpus drifting. */
export const MAX_CAPTURE_FAILURE_RATE = 0.2

/**
 * A window of `size` entries that moves with `rotation`, wrapping around the
 * end of the list: weekly runs with a different rotation cover the whole
 * corpus over time instead of re-scanning all of it every run. Without a
 * size (or with one at least as large as the list) every entry is returned.
 */
export function pickSample<T>(entries: readonly T[], size: number | null, rotation: number): T[] {
  const n = entries.length
  if (size === null || !Number.isFinite(size) || size <= 0 || size >= n) return [...entries]
  const start = (((Math.trunc(rotation) * size) % n) + n) % n
  return Array.from({ length: size }, (_, i) => entries[(start + i) % n])
}

/** ISO 8601 week number (1-53) of a date, in UTC. Used as the default rotation. */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day) // Thursday of this ISO week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
}

export interface DriftCounts {
  stable: number
  verdictChanges: number
  scoreDrifts: number
  failures: number
  noBaseline: number
}

export interface DriftOutcome {
  /** Entries whose live scan could be compared with their fixture. */
  comparable: number
  /** Share of comparable entries that drifted (0 when nothing was comparable). */
  driftPct: number
  /** Why the check cannot be trusted, or null when it can. */
  unreliableReason: string | null
  exitCode: typeof EXIT_OK | typeof EXIT_DRIFT | typeof EXIT_UNRELIABLE
}

/**
 * Drift is measured over the entries that were actually compared. Failed
 * captures and missing baselines are not "stable": counting them in the
 * denominator made a run where most scans failed look like a calm one.
 */
export function evaluateDrift(counts: DriftCounts, threshold: number): DriftOutcome {
  const drifted = counts.verdictChanges + counts.scoreDrifts
  const comparable = counts.stable + drifted
  const attempted = comparable + counts.failures
  const driftPct = comparable > 0 ? drifted / comparable : 0

  let unreliableReason: string | null = null
  if (attempted === 0) {
    unreliableReason = "no entry had a fixture to compare against"
  } else if (comparable === 0) {
    unreliableReason = `all ${counts.failures} live captures failed`
  } else if (counts.failures / attempted > MAX_CAPTURE_FAILURE_RATE) {
    unreliableReason = `${counts.failures} of ${attempted} live captures failed (more than ${Math.round(MAX_CAPTURE_FAILURE_RATE * 100)}%)`
  }

  const exitCode = unreliableReason !== null
    ? EXIT_UNRELIABLE
    : threshold > 0 && driftPct > threshold
      ? EXIT_DRIFT
      : EXIT_OK
  return { comparable, driftPct, unreliableReason, exitCode }
}
