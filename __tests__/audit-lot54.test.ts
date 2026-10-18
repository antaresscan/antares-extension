// __tests__/audit-lot54.test.ts — Lot 54 of the file-by-file audit (2026-10-17): the data-collection tests.
//
// api/_lib/concurrency.ts promises: "If one call throws, the returned promise rejects with that error at once, and no NEW item is started
// after it." A mutation probe removed the line that keeps that promise (`failed = true`) and the whole suite stayed green: nothing checked
// it. Without it, a caller whose calls fail (a Helius page that answers 429) would keep firing paid calls whose results are thrown away.
// This pins it; it fails on runWithConcurrency without the line (checked with audit-lots/mutate.cjs, then restored).

import { describe, it, expect } from "vitest"
import { runWithConcurrency } from "../api/_lib/concurrency"

describe("runWithConcurrency — no new call after a failure", () => {
  it("the first call throws: the promise rejects, and the workers start no new item after it", async () => {
    const started: number[] = []
    const items = Array.from({ length: 20 }, (_, i) => i)
    const run = runWithConcurrency(items, 3, async (i) => {
      started.push(i)
      await new Promise((r) => setTimeout(r, 5))
      if (i === 0) throw new Error("upstream refused")
      return i
    })
    await expect(run).rejects.toThrow("upstream refused")
    await new Promise((r) => setTimeout(r, 60)) // let any worker that would go on do so
    // Items 0, 1 and 2 were in flight together; item 0 failed: at most the ones already started (plus none taken after) may have run.
    expect(started.length).toBeLessThan(items.length)
    expect(started.length).toBeLessThanOrEqual(5)
  })

  it("no failure: every item runs once, results in input order (non-regression)", async () => {
    const out = await runWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20])
  })
})
