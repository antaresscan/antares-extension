// __tests__/audit-lot45.test.ts — Lot 45 of the file-by-file audit (2026-10-17): the repository's documentation. Fails on the previous code.
//
// What the docs say about the repository itself is checked against the repository: the files they name exist, the variables they
// tell an operator to set are read by the code, the npm scripts they run are in package.json, and the API they describe is the API.

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const root = process.cwd()
const read = (f: string) => readFileSync(resolve(root, f), "utf8")
const DOCS = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "OPERATIONS.md"]

describe("docs — the repository they describe is this one", () => {
  it("no doc names popup.tsx or privacy.ts: neither file exists", () => {
    expect(existsSync(resolve(root, "popup.tsx"))).toBe(false)
    expect(existsSync(resolve(root, "api/privacy.ts"))).toBe(false)
    for (const d of DOCS) {
      expect(read(d), d).not.toMatch(/popup\.tsx|privacy\.ts\b|popup \/ options UI/)
    }
  })

  it("every NAME=... the README tells an operator to set is read by the code (ANTARES_API_KEY and CHROME_TEST_HOST were not)", () => {
    const readme = read("README.md")
    const names = [...new Set([...readme.matchAll(/^\s*([A-Z][A-Z0-9_]{3,})=/gm)].map((m) => m[1]))]
    expect(names.length, "the README lists its variables (the check is not blind)").toBeGreaterThan(5)
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? sources(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []))
    const code = [...sources(resolve(root, "api")), ...sources(resolve(root, "shared")), resolve(root, "playwright.config.ts")]
      .map((f) => readFileSync(f, "utf8")).join("\n")
    expect(names.filter((n) => !code.includes(`process.env.${n}`))).toEqual([])
    expect(readme).not.toMatch(/CHROME_TEST_HOST/)
    expect(readme).toMatch(/^CRON_SECRET=/m)
  })

  it("the README describes /api/history as what it is: per install, the same for every tier (it said Pro-only, auth required)", () => {
    const readme = read("README.md")
    expect(readme).not.toMatch(/Pro-tier scan history/)
    expect(read("api/history.ts")).toMatch(/The same for everyone/)
  })

  it("the README names the bridge: the extension runs one content script on Antares' own website", () => {
    expect(read("README.md")).toMatch(/antares-website-bridge\.ts/)
    expect(read("contents/antares-website-bridge.ts")).toMatch(/"https:\/\/antaresscan\.com\/\*"/)
  })

  it("every `npm run X` of the docs is a script of package.json", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts
    for (const d of DOCS) {
      for (const m of read(d).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) expect(scripts[m[1]], `${d}: npm run ${m[1]}`).toBeDefined()
    }
  })
})
