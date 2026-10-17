// __tests__/audit-lot43.test.ts — Lot 43 of the file-by-file audit (2026-10-17): the smoke and replay scripts. Fails on the previous code.
//
// The recorder replaces globalThis.fetch for the whole instance while a scan runs, so two requests at once to the preview mix their
// exchanges into one recording (a lesson learnt the hard way on 2026-10-10, written down nowhere in the repository). The rule is now
// in the README and in the recorder, next to the code that makes it necessary, and the capture itself stays sequential.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8")

describe("replay recorder — one request at a time", () => {
  it("the recorder still swaps the global fetch for the whole instance (the reason for the rule)", () => {
    const rec = read("scripts/replay/record-function.ts.txt")
    expect(rec).toContain("globalThis.fetch = (async")
    expect(rec).toContain("globalThis.fetch = realFetch")
  })

  it("the README and the recorder say: one request to the preview at a time, never two (they said nothing)", () => {
    expect(read("scripts/replay/README.md")).toMatch(/One request to the preview at a time, never two/)
    expect(read("scripts/replay/record-function.ts.txt")).toMatch(/ONE REQUEST AT A TIME/)
  })

  it("capture.ts asks one token after the other: an awaited loop, no Promise.all", () => {
    const cap = read("scripts/replay/capture.ts")
    expect(cap).not.toMatch(/Promise\.(all|allSettled|any|race)\(/)
    expect(cap).toMatch(/for \(const t of todo\) \{/)
    expect(cap).toMatch(/const rec = await recordOnce\(t\.mint\)/)
  })
})
