// api/_lib/settle.ts — wait for some writes, but never for long and never with an error.

/**
 * Wait until every promise of `work` has settled, or `ms` has passed, whichever comes first. It never rejects (a failed write is the
 * writer's business: recordRug and condemn already swallow their errors) and it never waits longer than `ms`, so a slow or dead Redis
 * cannot hold an answer that is ready. An empty list returns at once. Entries need not be promises (a mocked writer returns nothing).
 */
export async function settleWithin(work: ReadonlyArray<unknown>, ms: number): Promise<void> {
  if (work.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([Promise.allSettled(work).then(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
