// __tests__/audit-lot47.test.ts — Lot 47 of the file-by-file audit (2026-10-17): the Chrome Web Store documents. Fails on the previous code.
//
// The built manifest gives the extension access to the eight trading platforms (host_permissions) AND to Antares' own website (the matches
// of the bridge content script). The dashboard lists all of them; the canonical justification text only covered the first eight, so a
// reviewer saw three sites with no reason given. Every site any content script matches must now be justified.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const root = process.cwd()
const read = (f: string) => readFileSync(resolve(root, f), "utf8")

/** The `matches` of every content script, read from the sources (what Plasmo writes into the built manifest). */
function contentScriptMatches(): string[] {
  const files = readdirSync(resolve(root, "contents")).filter((f) => f.endsWith(".ts")).map((f) => join("contents", f))
  return files.flatMap((f) => {
    const block = read(f).match(/matches:\s*\[([\s\S]*?)\]/)
    return block ? [...block[1].matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]) : []
  })
}

describe("CWS permission justifications — every site the extension can access is justified", () => {
  it("finds the content scripts' sites (the check is not blind)", () => {
    const sites = contentScriptMatches()
    expect(sites).toContain("https://dexscreener.com/*")
    expect(sites).toContain("https://antaresscan.com/*")
  })

  it("each site matched by a content script appears in the justifications (antaresscan.com and the two others did not)", () => {
    const doc = read("docs/cws/permission-justifications.md")
    const missing = contentScriptMatches().filter((s) => !doc.includes("`" + s + "`"))
    expect(missing).toEqual([])
  })

  it("the host_permissions of package.json are all justified too (non-regression)", () => {
    const doc = read("docs/cws/permission-justifications.md")
    const hosts = (JSON.parse(read("package.json")) as { manifest: { host_permissions: string[] } }).manifest.host_permissions
    expect(hosts.filter((h) => !doc.includes("`" + h + "`"))).toEqual([])
  })
})
