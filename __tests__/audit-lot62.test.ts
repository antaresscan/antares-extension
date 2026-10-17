// __tests__/audit-lot62.test.ts — Lot 62 of the file-by-file audit (2026-10-17): the emergency switch of "Limited data" is documented. Fails on the previous code.
//
// LIMITED_DATA=off is the switch to pull the day "Limited data" shows where it should not (api/_lib/helpers.ts limitedDataEnabled). It was written down
// only in the code: neither .env.example nor OPERATIONS.md named it, so whoever is on call had to know it existed. The values the docs give must really
// turn it off, and the scan metric the docs describe must carry the fields the route writes.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { limitedDataEnabled } from "../api/_lib/helpers"

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8")

describe("the emergency switch of Limited data is documented where an operator looks", () => {
  it(".env.example lists LIMITED_DATA", () => {
    expect(read(".env.example")).toMatch(/^# LIMITED_DATA=/m)
  })

  it("OPERATIONS.md tells how to pull it, and every value it gives really switches Limited data off", () => {
    const ops = read("OPERATIONS.md")
    const section = ops.split(/^## /m).find((s) => s.startsWith("4. Emergency switch"))
    expect(section, "OPERATIONS.md has the section").toBeDefined()
    expect(section).toMatch(/LIMITED_DATA=off/)
    expect(section).toMatch(/redeploy/)
    const values = [...section!.matchAll(/`(?:LIMITED_DATA=)?(off|0|false|no)`/g)].map((m) => m[1])
    expect(values.length, "the section names its values (the check is not blind)").toBeGreaterThanOrEqual(4)
    for (const v of values) expect(limitedDataEnabled({ LIMITED_DATA: v }), v).toBe(false)
    expect(limitedDataEnabled({}), "unset: on").toBe(true)
  })

  it("the scan.outcome row of OPERATIONS.md names the fields the route writes for a Limited data scan", () => {
    const row = read("OPERATIONS.md").split(/\r?\n/).find((l) => l.startsWith("| `scan.outcome`"))
    expect(row).toBeDefined()
    const route = read("api/scan.ts")
    for (const field of ["limited", "limitedCauses", "degraded"]) {
      expect(route, "the route writes " + field).toMatch(new RegExp("\\b" + field + "\\b"))
      expect(row, "the doc names " + field).toContain("`" + field + "`")
    }
  })
})
