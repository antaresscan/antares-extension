// __tests__/audit-lot72.test.ts — Lot 72 of the file-by-file audit (2026-10-17): no file of the repo says the root goes to the old host. Fails on the previous code.
//
// Five e2e specs (and robots.txt, fixed in lot 67) said the root of this deployment is "a 301 to antares-website.vercel.app". vercel.json sends
// it, permanently, to antaresscan.com. A reader who trusts the comment looks for the wrong site; this keeps every comment on vercel.json's host.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const root = process.cwd()
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? (n === "replay" || n === "fixtures" ? [] : files(join(dir, n))) : [join(dir, n)]))
/** The audit's own notes quote the old wording on purpose, and the CHANGELOG tells what a past release did (#287 redirected / there then). */
const AUDIT_NOTES = /audit-lot(67|72)\.test\.ts$|CHANGELOG\.md$/
const OLD_CLAIM = /(30[18]|redirect)[\s\S]{0,40}antares-website\.vercel\.app/i

describe("the root of the deployment, as the repo describes it", () => {
  it("vercel.json redirects / to antaresscan.com", () => {
    const config = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")) as { redirects?: Array<{ source: string; destination: string }> }
    expect(new URL(config.redirects!.find((r) => r.source === "/")!.destination).hostname).toBe("antaresscan.com")
  })

  it("no spec, test, doc or robots.txt still says it goes to antares-website.vercel.app", () => {
    const candidates = [
      ...files(resolve(root, "e2e")),
      ...files(resolve(root, "__tests__")),
      ...readdirSync(root).filter((n) => /\.(md|txt)$/.test(n)).map((n) => resolve(root, n)),
    ].filter((f) => /\.(ts|md|txt)$/.test(f) && !AUDIT_NOTES.test(f))
    expect(candidates.length, "the check reads the specs (it is not blind)").toBeGreaterThan(50)
    const stale = candidates.filter((f) => OLD_CLAIM.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1))
    expect(stale).toEqual([])
  })
})
