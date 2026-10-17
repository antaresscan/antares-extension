// __tests__/audit-lot42.test.ts — Lot 42 of the file-by-file audit (2026-10-17): the GitHub workflows. Fails on the previous code.
//
// Three jobs (ci.yml build, secret-scan.yml, submit.yml) declared no permissions, so they ran with the repository's DEFAULT token,
// which can be read-write, while running `npm ci` (the install scripts of every dependency). Every job now says what it needs.
// Read as text on purpose: the check must not depend on a YAML library that is only a transitive dev dependency.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const dir = resolve(process.cwd(), ".github/workflows")
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))

/** The jobs of a workflow, each with the text of its block (two-space keys under the top-level `jobs:`). */
function jobsOf(text: string): Array<{ name: string; block: string }> {
  const src = text.split("\r").join("")
  const start = src.search(/^jobs:\s*$/m)
  if (start < 0) return []
  const body = src.slice(start).split("\n").slice(1)
  const jobs: Array<{ name: string; lines: string[] }> = []
  for (const line of body) {
    if (/^\S/.test(line)) break // next top-level key
    const head = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (head) jobs.push({ name: head[1], lines: [] })
    else jobs[jobs.length - 1]?.lines.push(line)
  }
  return jobs.map((j) => ({ name: j.name, block: j.lines.join("\n") }))
}

describe("GitHub workflows — every job says which token permissions it needs", () => {
  it("finds the workflows and their jobs (the check is not blind)", () => {
    expect(workflows.length).toBeGreaterThanOrEqual(7)
    expect(jobsOf(readFileSync(join(dir, "ci.yml"), "utf8")).map((j) => j.name)).toEqual(["build", "replay", "e2e"])
  })

  it.each(workflows)("%s: each job has a permissions block, or the workflow has one at the top", (file) => {
    const text = readFileSync(join(dir, file), "utf8")
    if (/^permissions:/m.test(text)) return
    const missing = jobsOf(text).filter((j) => !/^ {4}permissions:/m.test(j.block)).map((j) => j.name)
    expect(missing, `${file}: jobs without permissions`).toEqual([])
  })

  it("only the release job may write the code (it attaches the zip to the release); the watches may write issues, nothing else", () => {
    for (const file of workflows) {
      const text = readFileSync(join(dir, file), "utf8")
      for (const j of jobsOf(text)) {
        const writes = [...j.block.matchAll(/^ {6}([a-z-]+):\s*write\s*$/gm)].map((m) => m[1])
        const allowed = file === "release.yml" ? ["contents"] : /watch/.test(file) ? ["issues"] : []
        expect(writes.filter((w) => !allowed.includes(w)), `${file} ${j.name}`).toEqual([])
      }
    }
  })
})
