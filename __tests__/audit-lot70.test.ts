// __tests__/audit-lot70.test.ts — Lot 70 of the file-by-file audit (2026-10-17): the integrity of the test data, checked on every run.
//
// The replay corpus (1 121 brotli recordings of real scans, committed) and the upstream fixtures were checked once by the audit: valid,
// coherent, and no credential in them (what looked like one was public data: GeckoTerminal ids, the metadata addresses of tokens, a Raydium
// link to a token, an e-mail written in a token's own description). Nothing kept it so: a capture made with a weakened redaction (see
// audit-lot69) would commit a real key inside a .br file, which a reader of the diff cannot see. These checks take about two seconds.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { brotliDecompressSync } from "node:zlib"
import { resolve } from "node:path"

const root = process.cwd()
const CORPUS = resolve(root, "__tests__/replay/corpus")
const FIXTURES = resolve(root, "__tests__/fixtures/upstream-real")
const VERDICTS = ["SAFE", "CAUTION", "DANGER", "RUG"]
/** A credential carried in a query parameter, not replaced by REDACTED (keys.ts redactUrl). */
const UNREDACTED = /[?&](?:api-key|apikey|key|token|access_token)=(?!REDACTED)/i
/** The Helius key travels as ?api-key=: it must never appear with a value in an answer either. */
const HELIUS_KEY_IN_TEXT = /api-key=(?!REDACTED)[0-9a-f]{8}-[0-9a-f]{4}-/i

interface Recording { symbol?: string; mint?: string; capturedAt?: number; exchanges?: Array<{ k?: string; t?: string }>; live?: { risk?: string } }

const recordings: Array<[string, Recording]> = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".json.br"))
  .map((f) => [f, JSON.parse(brotliDecompressSync(readFileSync(resolve(CORPUS, f))).toString("utf8")) as Recording])

describe("the replay corpus", () => {
  it("has its recordings (the checks are not blind)", () => {
    expect(recordings.length).toBeGreaterThan(1000)
  })

  it("every recording is the token its file is named after, with exchanges, a recorded verdict and a capture date", () => {
    const wrong = recordings.filter(([f, r]) =>
      r.mint !== f.replace(/\.json\.br$/, "") ||
      !Array.isArray(r.exchanges) || r.exchanges.length === 0 ||
      !VERDICTS.includes(String(r.live?.risk)) ||
      !(typeof r.capturedAt === "number" && r.capturedAt > Date.UTC(2026, 0, 1) && r.capturedAt <= Date.now()),
    ).map(([f]) => f)
    expect(wrong).toEqual([])
  })

  it("no exchange key holds a credential (every one was redacted)", () => {
    const leaks = recordings.flatMap(([f, r]) => (r.exchanges ?? []).filter((e) => UNREDACTED.test(String(e.k))).map(() => f))
    expect(leaks).toEqual([])
  })

  it("no recorded answer holds a Helius-style key", () => {
    const leaks = recordings.filter(([, r]) => (r.exchanges ?? []).some((e) => HELIUS_KEY_IN_TEXT.test(String(e.t ?? "")))).map(([f]) => f)
    expect(leaks).toEqual([])
  })
})

describe("the upstream fixtures", () => {
  it("every file is valid JSON, with no credential in it", () => {
    const files = readdirSync(FIXTURES)
    expect(files.length, "the fixtures are there (the check is not blind)").toBeGreaterThan(10)
    for (const f of files) {
      const text = readFileSync(resolve(FIXTURES, f), "utf8")
      expect(() => JSON.parse(text), f).not.toThrow()
      expect(UNREDACTED.test(text) || HELIUS_KEY_IN_TEXT.test(text), f).toBe(false)
    }
  })
})
