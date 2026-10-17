// api/_lib/settle.ts — wait for some writes, but never for long and never with an error.

/** setTimeout's ceiling (2^31 - 1 ms): above it Node fires after 1 ms instead of waiting, so "wait a lot" would become "do not wait". */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Wait until every promise of `work` has settled, or `ms` has passed, whichever comes first. It never rejects (a failed write is the
 * writer's business: recordRug and condemn already swallow their errors) and it never waits longer than `ms`, so a slow or dead Redis
 * cannot hold an answer that is ready. An empty list returns at once. Entries need not be promises (a mocked writer returns nothing).
 * `ms` is read as: not a number or not positive -> do not wait at all; above the timer ceiling -> the ceiling.
 */
export async function settleWithin(work: ReadonlyArray<unknown>, ms: number): Promise<void> {
  if (work.length === 0) return;
  const waitMs = Number.isFinite(ms) ? Math.min(Math.max(0, ms), MAX_TIMER_MS) : ms === Infinity ? MAX_TIMER_MS : 0;
  // Settle handlers are attached even when we do not wait, so a write that rejects later never becomes an unhandled rejection.
  const settled = Promise.allSettled(work).then(() => undefined);
  if (waitMs === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
  try {
    await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
