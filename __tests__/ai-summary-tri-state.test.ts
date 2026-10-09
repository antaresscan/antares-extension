// __tests__/ai-summary-tri-state.test.ts
//
// The summary used to tell Gemini "mint authority renounced (good), no honeypot (good)" for every token, because the pills
// were false whenever nothing had been measured. The pills are now tri-state (true / false / null = not verified), and the
// prompt must say "NOT VERIFIED" for null instead of narrating a clean contract.
import { describe, it, expect, vi, afterEach } from "vitest"
import { generateAISummary } from "../api/_lib/ai-summary"
import type { AISummaryInput } from "../api/_lib/ai-summary"

const base: AISummaryInput = {
  score: 900,
  risk: "SAFE",
  flags: [{ label: "Established token (30d+) ✓", severity: "bonus", impact: 0 }],
  tokenSymbol: "TEST",
  holders: 5000,
  marketCap: 1_000_000,
  liquidity: 500_000,
  lpBurned: true,
  lpLocked: false,
  mintAuthority: false,
  freezeAuthority: false,
  honeypot: false,
  tokenAgeHours: 2000,
  sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius"],
  topHolderPct: 8,
  volume24h: 100_000,
  priceChange1h: 1,
}

const geminiOk = {
  ok: true,
  status: 200,
  text: async () => "{}",
  json: async () => ({ choices: [{ message: { content: "TEST is a clean token. Nothing flagged." } }] }),
} as Response

/** The text sent to Gemini for this input (first call). */
async function promptFor(over: Partial<AISummaryInput>): Promise<string> {
  vi.stubEnv("GEMINI_API_KEY", "test-key")
  let sent = ""
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => { sent = String(init?.body ?? ""); return geminiOk }))
  await generateAISummary({ ...base, ...over })
  return sent
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("the Gemini prompt reports the three states of each pill", () => {
  it("verified renounced / no restriction: says so", async () => {
    const p = await promptFor({ mintAuthority: false, freezeAuthority: false, honeypot: false })
    expect(p).toContain("mint authority renounced (good)")
    expect(p).toContain("freeze authority renounced (good)")
    expect(p).toContain("no token-level sale restriction found (good)")
  })

  it("verified active / cannot be sold: says so", async () => {
    const p = await promptFor({ mintAuthority: true, freezeAuthority: true, honeypot: true })
    expect(p).toContain("mint authority ENABLED (BAD)")
    expect(p).toContain("freeze authority ENABLED (BAD)")
    expect(p).toContain("token cannot be sold (BAD)")
  })

  it("NOT verified (null): says so and forbids narrating it as renounced or as no honeypot", async () => {
    const p = await promptFor({ mintAuthority: null, freezeAuthority: null, honeypot: null })
    expect(p).toContain("mint authority NOT VERIFIED")
    expect(p).toContain("freeze authority NOT VERIFIED")
    expect(p).toContain("sale restrictions NOT VERIFIED")
    expect(p).not.toContain("mint authority renounced (good)")
    expect(p).not.toContain("freeze authority renounced (good)")
    expect(p).not.toContain("no token-level sale restriction found (good)")
  })

  it("each pill is independent: only the unverified one is flagged", async () => {
    const p = await promptFor({ mintAuthority: true, freezeAuthority: null, honeypot: false })
    expect(p).toContain("mint authority ENABLED (BAD)")
    expect(p).toContain("freeze authority NOT VERIFIED")
    expect(p).toContain("no token-level sale restriction found (good)")
  })
})

describe("the local fallback summary (what users see when Gemini is down) makes no claim about unverified pills", () => {
  it("no renounced / revoked / honeypot wording when nothing was verified", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const text = (await generateAISummary({ ...base, mintAuthority: null, freezeAuthority: null, honeypot: null })) ?? ""
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/renounced|revoked|no honeypot/i)
  })
})
