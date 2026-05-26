// api/_lib/concurrency.ts — Bounded-parallel async iteration helper.
//
// Why this exists: `insider-graph.ts` and `insider-activity.ts` both fan
// out N concurrent Helius `getSignaturesForAddress` calls when building
// the graph for a fresh mint. With MAX_HOLDERS = 20 (constants.ts:265),
// a cold-cache scan fired 20 simultaneous RPC requests at Helius and
// hit a 429 rate-limit ceiling under burst load. Helius free tier allows
// 10 req/s sustained; bursting 20 in the same tick reliably tripped it.
//
// `runWithConcurrency` runs `fn` over `items` with at most `limit`
// promises in flight at any moment, preserving input order in the
// returned array. It does NOT short-circuit on rejection — if one
// item's fn throws, the promise rejects after the workers drain, and
// the caller decides what to do. (Helius wrapper functions already
// `try/catch` and return [], so this is a no-op for the current
// callers but kept for predictability.)

export async function runWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  fn: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return [];
  // Avoid spawning more workers than items — saves a tiny bit of
  // Promise machinery when limit > items.length.
  const effective = Math.min(Math.max(1, limit), items.length);
  const results = new Array<TResult>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: effective }, worker));
  return results;
}
