// __tests__/audit-lot46.test.ts — Lot 46 of the file-by-file audit (2026-10-17): the changelog. Fails on the previous code.
//
// privacy.html, section 13: "If we materially change how the Extension processes data, we will update the date at the top of this page
// and publish a note in the repository's CHANGELOG.md." The policy was updated on 2026-10-16 (three pull requests) and the changelog,
// stopped at 1.3.7 (2026-05-28), said nothing. The date of the policy must now be found in the changelog.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8")
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

describe("changelog — it carries the note the privacy policy promises", () => {
  it("the policy still makes the promise (the reason for this check)", () => {
    expect(read("privacy.html")).toMatch(/publish a note in the repository's <code>CHANGELOG\.md<\/code>/)
  })

  it("the date of the policy's last update is in the changelog, with the pull requests of that update (it was not)", () => {
    const m = read("privacy.html").match(/Last updated: ([A-Z][a-z]+) (\d{1,2}), (\d{4})/)
    expect(m, "the policy carries its date").not.toBeNull()
    const iso = `${m![3]}-${String(MONTHS.indexOf(m![1]) + 1).padStart(2, "0")}-${m![2].padStart(2, "0")}`
    const changelog = read("CHANGELOG.md")
    expect(changelog).toContain(`Privacy policy — updated ${iso}`)
    for (const pr of ["#918", "#920", "#921"]) expect(changelog).toContain(pr)
  })

  // 1.3.22 is the last version that was published without a note here. From the next one on, each version of package.json has its own section: a version raised
  // without a note fails here, so the changelog cannot fall behind again (it stood at 1.3.7 while the Web Store had 1.3.22).
  it("the changelog says plainly that 1.3.8 to 1.3.22 are not documented in it, and it has a section for the version of package.json", () => {
    const version = (JSON.parse(read("package.json")) as { version: string }).version
    const changelog = read("CHANGELOG.md")
    expect(changelog).toContain("between 1.3.7 and 1.3.22")
    expect(changelog).toMatch(new RegExp(`^### ${version.replace(/\./g, "\\.")} `, "m"))
  })
})
