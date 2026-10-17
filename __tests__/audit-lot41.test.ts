// __tests__/audit-lot41.test.ts — Lot 41 of the file-by-file audit (2026-10-17): configuration and assets. Fails on the previous code.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const root = process.cwd()
const read = (f: string) => readFileSync(resolve(root, f), "utf8")
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]))

describe(".env.example names what the server really reads", () => {
  const example = read(".env.example")
  const named = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]))
  // Set by the platform, legacy names honoured as a fallback (api/_lib/payments.ts priceUsd), or build-time variables of the extension.
  const NOT_OPERATOR = /^(NODE_ENV|VERCEL_[A-Z_]+|SOLANA_PRICE_[A-Z_]+|PLASMO_PUBLIC_[A-Z_]+)$/
  const read_ = [...new Set(["api", "shared"].flatMap((d) => files(resolve(root, d))).filter((f) => f.endsWith(".ts"))
    .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])))]

  it("every variable an operator sets is in the file (CRON_SECRET, DEV_PRO_INSTALLS and LOG_LEVEL were missing)", () => {
    expect(read_.filter((v) => !NOT_OPERATOR.test(v) && !named.has(v)).sort()).toEqual([])
  })

  it("no variable that nothing reads (ANTARES_API_KEY was listed as required)", () => {
    const unread = [...named].filter((v) => !read_.includes(v))
    expect(unread).toEqual([])
  })

  it("the defaults it states are the code's: VERCEL_TIMEOUT 24000 (it said 9000)", () => {
    expect(read("api/scan.ts")).toMatch(/Number\(process\.env\.VERCEL_TIMEOUT\) \|\| 24000/)
    expect(example).toMatch(/default 24000/)
    expect(example).not.toMatch(/default 9000/)
  })
})

describe("assets — no font file that is in fact a web page", () => {
  it("every file of assets/ named like a font or its base64 is a real one (BebasNeue.ttf and both .woff2 were GitHub HTML pages)", () => {
    const fonts = existsSync(resolve(root, "assets")) ? files(resolve(root, "assets")).filter((f) => /\.(ttf|otf|woff2?|b64)$/i.test(f)) : []
    const html = fonts.filter((f) => /^\s*<!doctype html|^\s*<html/i.test(readFileSync(f, "latin1").slice(0, 200)))
    const htmlB64 = fonts.filter((f) => f.endsWith(".b64") && /<!doctype html/i.test(Buffer.from(readFileSync(f, "utf8").slice(0, 400), "base64").toString("latin1")))
    expect([...html, ...htmlB64]).toEqual([])
  })
})

describe("ESLint does not walk Claude Code's local folder", () => {
  it(".claude/ is ignored (agent worktrees there made `npm run lint` run out of memory)", () => {
    expect(read("eslint.config.mjs")).toContain('".claude/"')
  })
})
