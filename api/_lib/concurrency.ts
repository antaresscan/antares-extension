// api/_lib/concurrency.ts — Bounded-parallel async iteration helper.
//
// Why this exists: `insider-graph.ts` and `insider-activity.ts` both fan out one Helius `getSignaturesForAddress` call per top
// holder (up to 20) when building the graph for a fresh mint. Fired all at once, they hit Helius' requests-per-second ceiling
// under burst load (429). HELIUS_SIG_CONCURRENCY keeps at most a handful in flight.
//
// `runWithConcurrency` runs `fn` over `items` with at most `limit` calls in flight at any moment, and returns the results in input
// order. If one call throws, the returned promise rejects with that error at once, and no NEW item is started after it: the calls
// already in flight finish in the background and their results are dropped. (The current callers never throw: their `fn` catches
// and returns [], so this only matters for a future caller.)

/**
 * @param limit Maximum calls in flight. Read as an integer, at least 1 and at most `items.length`; NaN reads as 1 (it used to give
 *              zero workers and an array of holes). Infinity means "all at once".
 */
export async function runWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  fn: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const n = items.length;
  if (n === 0) return [];
  const width = Number.isNaN(limit) ? 1 : Math.min(n, Math.max(1, Math.floor(limit)));
  const results = new Array<TResult>(n);
  let cursor = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed) {
      const i = cursor++;
      if (i >= n) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failed = true; // the other workers stop taking new items
        throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
