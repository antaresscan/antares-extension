// __tests__/audit-lot44.test.ts — Lot 44 of the file-by-file audit (2026-10-17): the load and operations scripts. Fails on the previous code.
//
// load-test.mjs and stampede-test.mjs defaulted to PRODUCTION: `node scripts/load-test.mjs` alone ramped to 800 concurrent workers on
// it. They now have the guard distinct-cold-test.mjs already had: BASE required, the production host refused unless ALLOW_PROD=1.
//
// The scripts are really started here, but with fetch replaced by a function that throws before anything leaves the machine (a
// preloaded module): whatever the script does, this test never sends a request anywhere.

import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const NO_NETWORK = "data:text/javascript," + encodeURIComponent('globalThis.fetch = () => { throw new Error("no network in this test") }')
const SCRIPTS = ["scripts/load-test.mjs", "scripts/stampede-test.mjs", "scripts/distinct-cold-test.mjs"]

function run(script: string, env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["BASE", "ALLOW_PROD"].includes(k)))
  return spawnSync(process.execPath, ["--import", NO_NETWORK, script], { env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 10_000 })
}

describe("load scripts — never production by default", () => {
  it.each(SCRIPTS)("%s has the guard: no default target, production refused unless ALLOW_PROD=1", (script) => {
    const src = readFileSync(resolve(process.cwd(), script), "utf8")
    expect(src).not.toMatch(/process\.env\.BASE \|\| "https:\/\/antares-extension\.vercel\.app"/)
    expect(src).toMatch(/process\.env\.ALLOW_PROD !== "1"/)
  })

  it.each(SCRIPTS)("%s without BASE stops at once (exit 2), before any request", (script) => {
    const r = run(script, {})
    expect(r.status, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/BASE is required/)
  })

  it.each(SCRIPTS)("%s with BASE = production and no ALLOW_PROD stops at once (exit 2)", (script) => {
    const r = run(script, { BASE: "https://antares-extension.vercel.app" })
    expect(r.status, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/Refusing to run against production/)
  })
})
