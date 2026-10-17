// __tests__/audit-lot67.test.ts — Lot 67 of the file-by-file audit (2026-10-17): robots.txt says where the root goes. Fails on the previous code.
//
// robots.txt said the root of this deployment is "a 301 redirect" to antares-website.vercel.app. vercel.json sends it, permanently, to
// antaresscan.com, the canonical site since v1.3.2. The comment now names the host vercel.json redirects to, and this keeps them together.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8")

describe("robots.txt names the site the root redirects to", () => {
  it("the host of vercel.json's redirect of / is the one robots.txt names, and the old host is gone", () => {
    const config = JSON.parse(read("vercel.json")) as { redirects?: Array<{ source: string; destination: string }> }
    const root = config.redirects?.find((r) => r.source === "/")
    expect(root, "vercel.json redirects / (the check is not blind)").toBeDefined()
    const host = new URL(root!.destination).hostname
    const robots = read("robots.txt")
    expect(robots).toContain(host)
    expect(robots).not.toMatch(/antares-website\.vercel\.app|301/)
  })
})
