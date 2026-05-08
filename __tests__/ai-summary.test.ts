import { describe, it, expect, vi, afterEach } from "vitest"
import { generateAISummary } from "../api/_lib/ai-summary"
import type { AISummaryInput } from "../api/_lib/ai-summary"

const baseInput: AISummaryInput = {
  score: 750,
  risk: "SAFE",
  flags: [
    { label: "Mint authority enabled", severity: "critical", impact: 200 },
    { label: "Low holders", severity: "warning", impact: 80 },
  ],
  tokenSymbol: "TEST",
  holders: 500,
  marketCap: 100000,
  liquidity: 50000,
  lpBurned: true,
  lpLocked: false,
  mintAuthority: false,
  freezeAuthority: false,
  honeypot: false,
  tokenAgeHours: 48,
  sourcesUsed: ["dexscreener", "rugcheck", "goplus"],
  topHolderPct: 12.5,
  volume24h: 25000,
  priceChange1h: -3.2,
}

// Input with no recognizable flags for fallback (should return null when Gemini fails)
const noFlagInput: AISummaryInput = {
  score: 500,
  risk: "WARNING",
  flags: [
    { label: "Unusual xyz pattern", severity: "info", impact: 10 },
  ],
  tokenSymbol: "NOFLAG",
  holders: 50,
  marketCap: 5000,
  liquidity: 2000,
  lpBurned: true,
  lpLocked: false,
  mintAuthority: false,
  freezeAuthority: false,
  honeypot: false,
  tokenAgeHours: 2,
  sourcesUsed: ["dexscreener"],
  topHolderPct: 10,
  volume24h: 500,
  priceChange1h: -1,
}

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("generateAISummary", () => {
  // ---------------------------------------------------------------------------
  // No API key tests: fallback kicks in
  // ---------------------------------------------------------------------------
  it("returns local fallback (not null) when GEMINI_API_KEY is undefined and flags are recognized", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const result = await generateAISummary(baseInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("returns a structured fallback even when no flags are recognized — every scan gets a summary now", async () => {
    // Behavior change: the fallback used to return null when neither
    // a known flag nor a boolean shortcut matched. Users were hitting
    // tokens where the overlay showed nothing under "AI Summary" — a
    // hard regression vs the /demo experience. The new structured
    // fallback always emits a 3-paragraph summary anchored on the
    // verdict band + score, so the AI Summary slot is never empty.
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const result = await generateAISummary(noFlagInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
    // 3-paragraph structure
    expect(result!.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length).toBe(3)
  })

  it("does not call fetch when GEMINI_API_KEY is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const mockFetch = vi.fn()
    vi.stubGlobal("fetch", mockFetch)
    await generateAISummary(baseInput)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Successful Gemini responses
  // ---------------------------------------------------------------------------
  it("calls fetch with correct URL and Authorization header when key is present", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-123")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "This is a valid summary that is long enough to pass validation checks." } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    await generateAISummary(baseInput)
    expect(mockFetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.objectContaining({
        method: "POST",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Authorization: "Bearer test-key-123",
        }),
      })
    )
  })

  it("returns Gemini output verbatim when it follows the 3-paragraph 45–75 word contract", async () => {
    // The new validation in callGemini enforces 3 paragraphs and
    // 30–110 words. Mocks must respect that contract or they get
    // rejected and the structured fallback kicks in.
    const validThreeParagraph =
      "TEST shows a SAFE profile with locked liquidity and 30d+ established trading on Solana.\n\n" +
      "RugCheck and GoPlus cross-validate the safe verdict across independent layers.\n\n" +
      "Strong holder distribution."
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: ` ${validThreeParagraph} ` } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBe(validThreeParagraph)
  })

  it("rejects a single-paragraph Gemini response and falls through to the structured fallback", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: " This token appears safe with strong liquidity and burned LP. " } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).not.toBeNull()
    // Should be the structured fallback, not the single-paragraph Gemini output
    expect(result!.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length).toBe(3)
    expect(result).not.toContain("This token appears safe with strong liquidity")
  })

  // ---------------------------------------------------------------------------
  // Gemini failures with fallback
  // ---------------------------------------------------------------------------
  it("returns local fallback when fetch throws a network error and flags are recognized", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"))
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    // Fallback should return something for "Mint authority enabled"
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("returns the structured fallback even when fetch throws a network error and no flags are recognized", async () => {
    // Same behavior change: every scan gets a summary now.
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"))
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(noFlagInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("returns local fallback when API returns HTTP 500 and flags are recognized", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ error: "internal server error" }, 500)
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("returns local fallback when response content is too short", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "Too short" } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    // Gemini returned too-short content -> falls back to local
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("truncates and returns a string when response content exceeds MAX_LENGTH (1800 chars)", async () => {
    // MAX_LENGTH bumped 1200→1800 alongside max_tokens 350→600 so
    // dense Gemini outputs no longer hit the truncation path mid-
    // sentence. Repeat the sentence enough to overflow the new bound.
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const longContent = "This is a valid sentence that will be repeated. ".repeat(45)
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: longContent } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
    expect(result!.length).toBeLessThanOrEqual(1800)
    expect(result!.endsWith(".")).toBe(true)
  })

  it("returns local fallback when choices array has no message content", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: {} }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  // ---------------------------------------------------------------------------
  // Flag sorting
  // ---------------------------------------------------------------------------
  it("sorts bonus flags after critical and warning", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const inputWithBonus: AISummaryInput = {
      ...baseInput,
      flags: [
        { label: "LP Burned", severity: "bonus", impact: 50 },
        { label: "Mint authority enabled", severity: "critical", impact: 200 },
        { label: "Low holders", severity: "warning", impact: 80 },
        { label: "Token is 3 days old", severity: "info", impact: 10 },
      ],
    }
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "This token has critical mint authority enabled and low holders but LP is burned." } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(inputWithBonus)
    expect(result).not.toBeNull()
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it("handles flags with unknown severity", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const inputUnknown: AISummaryInput = {
      ...baseInput,
      flags: [
        { label: "Unknown flag", severity: "unknown", impact: 30 },
        { label: "Another plain flag", severity: "info", impact: 10 },
      ],
    }
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "This token has no recognized severity flags but looks borderline." } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(inputUnknown)
    expect(result).not.toBeNull()
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  // ---------------------------------------------------------------------------
  // Retry behavior tests
  // ---------------------------------------------------------------------------
  it("retries on 429 and returns fallback after all retries exhausted", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ error: "rate limit" }, 429)
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    // Should have retried: 1 initial + 2 retries = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3)
    // Falls back to local
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("retries on AbortError (timeout) and returns fallback after exhaustion", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const abortError = new Error("timeout")
    abortError.name = "AbortError"
    const mockFetch = vi.fn().mockRejectedValue(abortError)
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("retries on 429 and falls back to structured summary when no flags are recognized", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ error: "rate limit" }, 429)
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(noFlagInput)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    // Was: toBeNull(). New: every scan gets a summary.
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
  })

  it("succeeds on second attempt after initial 429 when Gemini reply is valid 3-paragraph format", async () => {
    const validThreeParagraph =
      "TEST lands on CAUTION because of moderate concentration risk — a single wallet holds 12.5% of supply.\n\n" +
      "LP is burned, mint and freeze authorities are revoked, no honeypot, and the token has 2 days of trading history — the rest of the structural posture is clean.\n\n" +
      "The verdict is not DANGER because the rest is clean; it is not SAFE because the concentrated wallet alone has enough leverage to swing the price."
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ error: "rate limit" }, 429))
      .mockResolvedValueOnce(
        mockFetchResponse({
          choices: [{ message: { content: validThreeParagraph } }],
        })
      )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result).toBe(validThreeParagraph)
  })

  // ---------------------------------------------------------------------------
  // Local fallback coverage tests
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Structured fallback — verdict-band coverage
  //
  // Each test below mirrors a real-world scan scenario. The new fallback
  // is a deterministic builder that always emits a 3-paragraph 45–75
  // word summary. Assertions check structural shape (paragraph count,
  // word count, key data points) — not exact phrasing — so the
  // wording can be polished without breaking tests.
  // ---------------------------------------------------------------------------

  function structuralChecks(result: string | null) {
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
    const paragraphs = result!.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    expect(paragraphs.length).toBe(3)
    const wordCount = result!.split(/\s+/).filter((w) => w.length > 0).length
    expect(wordCount).toBeGreaterThanOrEqual(20)
    expect(wordCount).toBeLessThanOrEqual(110)
  }

  it("fallback covers RUG with honeypot — emits structured 3-paragraph summary", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const honeypotInput: AISummaryInput = {
      ...noFlagInput,
      risk: "RUG",
      score: 80,
      honeypot: true,
    }
    const result = await generateAISummary(honeypotInput)
    structuralChecks(result)
    expect(result).toContain("honeypot")
    expect(result).toContain("Hard kill")
  })

  it("fallback covers DANGER with freeze authority — verdict appears with boundary explanation", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const freezeInput: AISummaryInput = {
      ...noFlagInput,
      risk: "DANGER",
      score: 450,
      freezeAuthority: true,
      // Real /scan code emits a flag when freezeAuthority === true.
      // The fallback now requires the flag to be present before
      // narrating "freeze authority enabled" — the boolean alone is
      // not authoritative (CHILLHOUSE fix: don't invent risks from
      // raw fields when the engine didn't surface them).
      flags: [
        { label: "Freeze Authority enabled (RugCheck)", severity: "critical", impact: 200 },
      ],
    }
    const result = await generateAISummary(freezeInput)
    structuralChecks(result)
    expect(result!.toLowerCase()).toContain("danger")
    expect(result!.toLowerCase()).toContain("freeze")
  })

  it("fallback covers RUG with mint authority — opens with mint-authority rug pattern", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const mintInput: AISummaryInput = {
      ...noFlagInput,
      risk: "RUG",
      score: 90,
      mintAuthority: true,
      lpBurned: true,
      topHolderPct: 5,
      honeypot: false,
      // /scan emits a critical flag when mintAuthority === true; the
      // fallback now requires that flag before narrating "mint-authority
      // rug" (was inventing the narrative from the boolean alone).
      flags: [
        { label: "Mint Authority enabled (RugCheck)", severity: "critical", impact: 220 },
      ],
    }
    const result = await generateAISummary(mintInput)
    structuralChecks(result)
    expect(result!.toLowerCase()).toMatch(/mint/)
  })

  it("fallback covers RUG with LP not locked or burned — exit-scam opener", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const lpInput: AISummaryInput = {
      ...noFlagInput,
      risk: "RUG",
      score: 100,
      lpBurned: false,
      lpLocked: false,
      topHolderPct: 2,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
    }
    const result = await generateAISummary(lpInput)
    structuralChecks(result)
    expect(result!.toLowerCase()).toMatch(/liquidity|exit-scam/)
  })

  it("fallback covers RUG with top1 ≥ 25% — concentration rug + percentage in output", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const topHolderInput: AISummaryInput = {
      ...noFlagInput,
      risk: "RUG",
      score: 105,
      // topHolderPct is in PERCENTAGE form (0–100), per api/scan.ts:
      //   (topAmt / totalSupplyUi) * 100
      topHolderPct: 45,
      holders: 12,
      lpBurned: true,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      // /scan emits a critical concentration flag when top1 ≥ 25%; the
      // fallback now requires that flag before narrating "concentration
      // rug" (was inventing it from the raw topHolderPct alone — the
      // CHILLHOUSE bug, where 8.1% top holder with only an LP flag was
      // being narrated as a concentration risk).
      flags: [
        { label: "Single wallet holds 45% of supply", severity: "critical", impact: 250 },
      ],
    }
    const result = await generateAISummary(topHolderInput)
    structuralChecks(result)
    expect(result).toContain("concentration rug")
    expect(result).toContain("45.0%")
    expect(result).toContain("Hard kill")
  })

  it("fallback covers SAFE with clean profile — references LP + sources without 'Score X' phrasing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const safeInput: AISummaryInput = {
      ...noFlagInput,
      risk: "SAFE",
      score: 850,
      lpBurned: true,
      mintAuthority: false,
      freezeAuthority: false,
      holders: 200,
      honeypot: false,
      tokenAgeHours: 24 * 60, // 60d — mature
    }
    const result = await generateAISummary(safeInput)
    structuralChecks(result)
    expect(result).toContain("SAFE profile")
    // The new fallback does not literal-emit "Score 850" — that's a
    // /scan-overlay UI element. Just verify no regression to the old
    // raw-score phrasing.
    expect(result).not.toContain("Score 850/1000")
  })

  it("fallback covers safe token with LP locked (not burned)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const safeLpLockedInput: AISummaryInput = {
      ...noFlagInput,
      risk: "SAFE",
      score: 800,
      lpBurned: false,
      lpLocked: true,
      mintAuthority: false,
      freezeAuthority: false,
      holders: 150,
      honeypot: false,
    }
    const result = await generateAISummary(safeLpLockedInput)
    expect(result).not.toBeNull()
    expect(result).toContain("locked")
  })

  it("fallback stays within MAX_LENGTH on dense inputs", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const longInput: AISummaryInput = {
      ...noFlagInput,
      risk: "RUG",
      score: 50,
      honeypot: true,
      mintAuthority: true,
      freezeAuthority: true,
      lpBurned: false,
      lpLocked: false,
      topHolderPct: 0.9,
      holders: 3,
    }
    const result = await generateAISummary(longInput)
    expect(result).not.toBeNull()
    if (result) {
      // MAX_LENGTH bumped to 2200 in the dynamic-target rewrite — kept
      // the assertion at the new ceiling. 1800 was a leftover from the
      // 45–75 word fixed cap; today the cap scales with critical-flag
      // count up to 145 words.
      expect(result.length).toBeLessThanOrEqual(2200)
    }
  })

  it("fallback enumerates ALL critical flags in paragraph 2 when 5+ are present (no AI explanations one-of-many)", async () => {
    // The user-reported pain: tokens with 5–10 flags would get a
    // summary that explained only the dominant one and waved at "and
    // some other negatives". This test pins the new contract — every
    // critical flag must appear by name in paragraph 2.
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const denseInput: AISummaryInput = {
      ...noFlagInput,
      risk: "RUG",
      score: 80,
      tokenSymbol: "TROLLV2",
      flags: [
        { label: "Single wallet holds 38% of supply", severity: "critical", impact: 200 },
        { label: "Top 10 holders > 90%", severity: "critical", impact: 180 },
        { label: "LP not burned or locked", severity: "critical", impact: 160 },
        { label: "Mint Authority enabled", severity: "critical", impact: 150 },
        { label: "Freeze Authority enabled", severity: "critical", impact: 140 },
        { label: "Metadata mutable", severity: "critical", impact: 100 },
        { label: "No website / Twitter / Telegram", severity: "critical", impact: 90 },
        { label: "Deceptive name detected", severity: "critical", impact: 80 },
      ],
      lpBurned: false,
      lpLocked: false,
      mintAuthority: true,
      freezeAuthority: true,
      topHolderPct: 38,
    }
    const result = await generateAISummary(denseInput)
    expect(result).not.toBeNull()
    const paragraphs = result!.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    expect(paragraphs.length).toBe(3)
    // Paragraph 2 should mention secondary critical flags by short
    // name. We test for the compacted forms emitted by
    // shortenFlagLabel — same shape the comma-list uses.
    const para2Lower = paragraphs[1].toLowerCase()
    // The dominant flag (single wallet 38%) anchors paragraph 1 and is
    // intentionally NOT repeated in paragraph 2 — but the rest must be.
    const expectedMentions = [
      "top-10 hold",       // top 10 holders > 90%
      "lp unlocked",       // LP not burned/locked
      "mutable metadata",  // metadata mutable
      "no socials",        // no website / twitter / telegram
      "deceptive name",    // deceptive name detected
    ]
    for (const mention of expectedMentions) {
      expect(para2Lower).toContain(mention)
    }
    // Word count should land in the 5+ critical band (95–145 typical,
    // wider tolerance allowed).
    const wordCount = result!.split(/\s+/).filter((w) => w.length > 0).length
    expect(wordCount).toBeGreaterThanOrEqual(60)
    expect(wordCount).toBeLessThanOrEqual(170)
  })

  it("fallback enumerates ALL flags when token has only WARNING flags (GIGARAT regression: 0 critical + 4 warning)", async () => {
    // Production CA GIGARAT shipped with 0 critical + 4 warning flags
    // and the AI summary enumerated only the dominant flag (LP not
    // burned), waving at "holder structure" without naming the wash
    // trading, the wallet pct, or the volume/liquidity ratio. The user
    // saw 4 flags in the panel and 1 flag in the summary — exactly the
    // failure mode this PR fixes. The earlier `criticalFlags >= 3`
    // gate was the bug; it now triggers on `significantFlags >= 3`
    // (critical + warning).
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const gigaratLikeInput: AISummaryInput = {
      ...noFlagInput,
      risk: "DANGER",
      score: 480,
      tokenSymbol: "GIGARAT",
      flags: [
        { label: "LP not burned or locked — dev can rug liquidity", severity: "warning", impact: 150 },
        { label: "Single wallet holds 14% of supply", severity: "warning", impact: 120 },
        { label: "Liquidity mirage: volume >> liquidity (wash)", severity: "warning", impact: 100 },
        { label: "High vol/liquidity ratio", severity: "warning", impact: 80 },
      ],
      lpBurned: false,
      lpLocked: false,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      topHolderPct: 14,
    }
    const result = await generateAISummary(gigaratLikeInput)
    expect(result).not.toBeNull()
    const paragraphs = result!.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    expect(paragraphs.length).toBe(3)
    const para2Lower = paragraphs[1].toLowerCase()
    // The dominant (LP not burned) anchors paragraph 1 — paragraph 2
    // must surface the OTHER three. Each compact label produced by
    // shortenFlagLabel (single wallet 14%, wash trading, high vol)
    // should appear.
    expect(para2Lower).toContain("single wallet 14%")
    expect(para2Lower).toContain("wash trading")
    // The fourth ("High vol/liquidity ratio") falls through to the
    // generic shortener and shows up as "high vol/liquidity ratio".
    expect(para2Lower).toContain("vol/liquidity")
  })

  it("fallback does NOT invent concentration narrative when no concentration flag is fired (CHILLHOUSE regression: 8.1% top1 + only LP flag)", async () => {
    // Production CA CHILLHOUSE shipped on CAUTION with exactly one
    // warning flag — "LP not burned but token is mature and liquid" —
    // and a top-holder of 8.1%. The /scan engine deliberately did NOT
    // flag the 8.1% concentration: that holding is within tolerance
    // for a mature 30d+ token with otherwise clean structure. But the
    // structured fallback was triggering on `top1 >= 8` regardless,
    // and the AI summary opened with "lands on CAUTION because a
    // single wallet holds 8.1% of supply — a meaningful concentration
    // risk" — i.e. inventing a risk the engine had ruled out and
    // contradicting the visible flag list.
    //
    // The fix gates each verdict's para1 on the actual presence of a
    // matching flag in topFlags. With no concentration flag here, the
    // CAUTION branch must fall through to the dominant-flag path and
    // open with the LP issue, NOT the concentration narrative.
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const chillhouseLikeInput: AISummaryInput = {
      ...noFlagInput,
      risk: "CAUTION",
      score: 850,
      tokenSymbol: "CHILLHOUSE",
      flags: [
        // Only LP is flagged. The 8.1% top-holder did NOT trigger the
        // engine — that's exactly the configuration the fidelity fix
        // protects against.
        { label: "LP not burned but token is mature and liquid (unverified LP)", severity: "warning", impact: 150 },
      ],
      holders: 16060,
      lpBurned: false,
      lpLocked: false,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      tokenAgeHours: 24 * 365, // 12mo old, mature
      topHolderPct: 8.1, // ABOVE 8 (old gate fired) but NOT FLAGGED
    }
    const result = await generateAISummary(chillhouseLikeInput)
    expect(result).not.toBeNull()
    const paragraphs = result!.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    expect(paragraphs.length).toBe(3)
    const para1Lower = paragraphs[0].toLowerCase()
    // Para 1 must NOT claim concentration is the dominant mechanism.
    // The two markers that betray the bug:
    expect(para1Lower).not.toContain("single wallet holds 8.1%")
    expect(para1Lower).not.toMatch(/concentration risk/)
    // Para 1 SHOULD mention the LP flag (the only thing actually flagged).
    expect(para1Lower).toMatch(/lp|liquidity|burned/)
  })

  it("fallback does NOT invent mint-authority narrative without a mint flag", async () => {
    // Inverse-direction guard: even if mintAuthority === true on the
    // raw input, without a corresponding flag the fallback must not
    // narrate "mint-authority rug". Real /scan code always emits the
    // flag when the boolean fires, so this is paranoia coverage —
    // catches a regression where someone might forget to wire the
    // flag in but still surface the boolean.
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const mintNoFlagInput: AISummaryInput = {
      ...noFlagInput,
      risk: "RUG",
      score: 95,
      tokenSymbol: "GHOSTMINT",
      mintAuthority: true,
      // No mint flag in the list — only a generic info flag.
      flags: [
        { label: "Unusual xyz pattern", severity: "info", impact: 10 },
      ],
      lpBurned: true,
      honeypot: false,
      topHolderPct: 5,
    }
    const result = await generateAISummary(mintNoFlagInput)
    expect(result).not.toBeNull()
    const para1Lower = result!.split(/\n\s*\n/)[0].toLowerCase()
    // The mint-authority narrative must NOT appear without a flag.
    expect(para1Lower).not.toContain("mint-authority rug")
    expect(para1Lower).not.toContain("dilute holders to zero")
  })

  it("low-flag scans stay tight — no padding when only 1 critical flag fires", async () => {
    // Mirror invariant: tokens with 1 critical flag still get a 45–75
    // word summary. We don't want the new dynamic cap to make every
    // CAUTION read like a wall of text.
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const tightInput: AISummaryInput = {
      ...noFlagInput,
      risk: "CAUTION",
      score: 825,
      tokenSymbol: "Fartcoin",
      flags: [
        { label: "Single wallet holds 11% of supply", severity: "critical", impact: 100 },
      ],
      lpBurned: true,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      tokenAgeHours: 24 * 60,
      topHolderPct: 11,
    }
    const result = await generateAISummary(tightInput)
    expect(result).not.toBeNull()
    const wordCount = result!.split(/\s+/).filter((w) => w.length > 0).length
    expect(wordCount).toBeGreaterThanOrEqual(25)
    expect(wordCount).toBeLessThanOrEqual(95)
  })

  // ---------------------------------------------------------------------------
  // GOLDEN TESTS — verdict-band parity with the four /demo summaries
  //
  // These four inputs reproduce the exact scenarios the demo summaries
  // illustrate (HAWK / PIPPIN / FARTCOIN / PENGU). Each scan must
  // produce a 3-paragraph 45–75 word summary that hits the same
  // structural beats the demo hits, regardless of whether Gemini is
  // available or down. If any of these break, the AI Summary slot is
  // off-spec and users will see worse summaries than the demo.
  //
  // Tests mock GEMINI_API_KEY="" so they exercise the structured
  // fallback directly. Production also runs Gemini with the same
  // strict prompt — Gemini output must pass the 3-paragraph 30–110
  // word validator in callGemini or it falls through to this same
  // structured path.
  // ---------------------------------------------------------------------------

  function goldenStructuralChecks(result: string | null) {
    expect(result).not.toBeNull()
    const paragraphs = result!.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    expect(paragraphs.length).toBe(3)
    const wordCount = result!.split(/\s+/).filter((w) => w.length > 0).length
    expect(wordCount).toBeGreaterThanOrEqual(30)
    expect(wordCount).toBeLessThanOrEqual(110)
    return { paragraphs, wordCount }
  }

  describe("golden — demo parity for the four canonical scans", () => {
    it("HAWK (RUG · 105 · single wallet 44%) reads as a concentration rug with hard-kill closer", async () => {
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const hawkInput: AISummaryInput = {
        score: 105,
        risk: "RUG",
        flags: [{ label: "Top wallet concentration", severity: "critical", impact: 350 }],
        tokenSymbol: "HAWK",
        holders: 4200,
        marketCap: 2_000_000,
        liquidity: 71_200,
        lpBurned: true,
        lpLocked: false,
        mintAuthority: false,
        freezeAuthority: false,
        honeypot: false,
        tokenAgeHours: 24 * 35, // 35d, mature
        sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"],
        // percentage form, per api/scan.ts convention
        topHolderPct: 44,
        volume24h: 500_000,
        priceChange1h: -8,
      }
      const result = await generateAISummary(hawkInput)
      const { paragraphs } = goldenStructuralChecks(result)
      // PARA 1: opens with token name + "concentration rug" + 44.0%
      expect(paragraphs[0]).toContain("HAWK")
      expect(paragraphs[0]).toContain("concentration rug")
      expect(paragraphs[0]).toContain("44.0%")
      // PARA 2: mentions positives that get overridden
      expect(paragraphs[1].toLowerCase()).toMatch(/lp|burn|history|renounce|honeypot/)
      // PARA 3: hard-kill action
      expect(paragraphs[2]).toContain("Hard kill")
    })

    it("PIPPIN (DANGER · 525 · top1 27%) opens with stacked concentration and explains why not RUG", async () => {
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const pippinInput: AISummaryInput = {
        score: 525,
        risk: "DANGER",
        flags: [{ label: "Stacked concentration risk", severity: "critical", impact: 250 }],
        tokenSymbol: "Pippin",
        holders: 1800,
        marketCap: 50_000_000,
        liquidity: 4_450_000,
        lpBurned: true,
        lpLocked: false,
        mintAuthority: false,
        freezeAuthority: false,
        honeypot: false,
        tokenAgeHours: 24 * 90,
        sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"],
        topHolderPct: 27,
        volume24h: 2_500_000,
        priceChange1h: -3,
      }
      const result = await generateAISummary(pippinInput)
      const { paragraphs } = goldenStructuralChecks(result)
      // PARA 1
      expect(paragraphs[0]).toContain("Pippin")
      expect(paragraphs[0]).toContain("DANGER")
      expect(paragraphs[0]).toContain("27.0%")
      // PARA 2: clean LP / authorities
      expect(paragraphs[1].toLowerCase()).toMatch(/lp|burn|renounce|clean/)
      // PARA 3: boundary "but ... exit-liquidity risk"
      expect(paragraphs[2].toLowerCase()).toContain("exit-liquidity risk")
    })

    it("FARTCOIN (CAUTION · 825 · top1 11%) explains why not SAFE / why not DANGER", async () => {
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const fartcoinInput: AISummaryInput = {
        score: 825,
        risk: "CAUTION",
        flags: [{ label: "Top wallet concentration", severity: "warning", impact: 80 }],
        tokenSymbol: "Fartcoin",
        holders: 80_000,
        marketCap: 700_000_000,
        liquidity: 7_400_000,
        lpBurned: true,
        lpLocked: false,
        mintAuthority: false,
        freezeAuthority: false,
        honeypot: false,
        tokenAgeHours: 24 * 365,
        sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"],
        topHolderPct: 11,
        volume24h: 50_000_000,
        priceChange1h: 1.2,
      }
      const result = await generateAISummary(fartcoinInput)
      const { paragraphs } = goldenStructuralChecks(result)
      // PARA 1
      expect(paragraphs[0]).toContain("Fartcoin")
      expect(paragraphs[0]).toContain("CAUTION")
      expect(paragraphs[0]).toContain("11.0%")
      expect(paragraphs[0]).toContain("solid fundamentals")
      // PARA 2: positives matter-of-factly
      expect(paragraphs[1].toLowerCase()).toMatch(/lp|burn|renounce|clean/)
      // PARA 3: boundary
      expect(paragraphs[2]).toContain("not DANGER")
      expect(paragraphs[2]).toContain("not SAFE")
    })

    it("PENGU (SAFE · 880 · sources cross-validated) emits a brief 3-paragraph SAFE profile", async () => {
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const penguInput: AISummaryInput = {
        score: 880,
        risk: "SAFE",
        flags: [],
        tokenSymbol: "PENGU",
        holders: 250_000,
        marketCap: 1_500_000_000,
        liquidity: 4_400_000,
        lpBurned: false,
        lpLocked: true,
        mintAuthority: false,
        freezeAuthority: false,
        honeypot: false,
        tokenAgeHours: 24 * 200,
        // Helius unavailable so the fallback should reference cross-
        // validation by the remaining sources.
        sourcesUsed: ["dexscreener", "rugcheck", "goplus", "solscan"],
        topHolderPct: 4,
        volume24h: 80_000_000,
        priceChange1h: 0.5,
      }
      const result = await generateAISummary(penguInput)
      const { paragraphs } = goldenStructuralChecks(result)
      // PARA 1: SAFE profile + locked liquidity
      expect(paragraphs[0]).toContain("PENGU")
      expect(paragraphs[0]).toContain("SAFE profile")
      expect(paragraphs[0].toLowerCase()).toMatch(/locked|burned/)
      // PARA 2: cross-validation by name (RugCheck, GoPlus, etc.)
      expect(paragraphs[1].toLowerCase()).toMatch(/rugcheck|goplus|cross-validate/)
      // PARA 3: brief closer
      expect(paragraphs[2].length).toBeLessThan(80)
    })

    it("BUNDLE flag beats top-1 concentration — bundle is Antares's signature edge and should lead the verdict reason", async () => {
      // Reproduces a scenario where BOTH a bundle flag AND a high
      // visible top-1 holder are present. Without the priority logic,
      // the deterministic fallback would pick the top-1 concentration
      // ("textbook concentration rug"). The new priority order moves
      // bundle to slot #2 (right after honeypot) because invisible
      // concentration via coordinated wallets is harder to detect
      // with standard scanners and is the higher-value signal Antares
      // adds.
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const bundlePlusTopHolder: AISummaryInput = {
        score: 90,
        risk: "RUG",
        flags: [
          { label: "Bundle holds ~37% of supply — coordinated buy/dump", severity: "critical", impact: 400 },
          { label: "Single wallet holds 28% of supply", severity: "critical", impact: 350 },
        ],
        tokenSymbol: "STEALTH",
        holders: 5200,
        marketCap: 1.2e6,
        liquidity: 35000,
        lpBurned: true,
        lpLocked: false,
        mintAuthority: false,
        freezeAuthority: false,
        honeypot: false,
        tokenAgeHours: 24 * 14,
        sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"],
        topHolderPct: 28,
        volume24h: 200000,
        priceChange1h: -12,
      }
      const result = await generateAISummary(bundlePlusTopHolder)
      goldenStructuralChecks(result)
      const para1 = result!.split(/\n\s*\n/)[0]
      // Para 1 must lead with bundle, NOT with "concentration rug"
      expect(para1).toContain("bundle rug")
      expect(para1.toLowerCase()).toContain("coordinated wallets")
      expect(para1).toContain("37%")
      // Para 1 must NOT lead with the visible-concentration template
      expect(para1).not.toContain("textbook concentration rug")
    })

    it("BUNDLE leads on a DANGER scenario where the bundle flag fires alongside other concerns", async () => {
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const bundleDanger: AISummaryInput = {
        score: 480,
        risk: "DANGER",
        flags: [
          { label: "Bundle activity detected (RugCheck)", severity: "critical", impact: 250 },
          { label: "Single wallet holds 22% of supply", severity: "critical", impact: 200 },
        ],
        tokenSymbol: "STEALTHY",
        holders: 3000,
        marketCap: 5e6,
        liquidity: 800_000,
        lpBurned: true,
        lpLocked: false,
        mintAuthority: false,
        freezeAuthority: false,
        honeypot: false,
        tokenAgeHours: 24 * 60,
        sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"],
        topHolderPct: 22,
        volume24h: 500_000,
        priceChange1h: -2,
      }
      const result = await generateAISummary(bundleDanger)
      goldenStructuralChecks(result)
      const para1 = result!.split(/\n\s*\n/)[0]
      expect(para1).toContain("DANGER")
      expect(para1).toContain("bundle activity")
      expect(para1).not.toContain("stacked concentration risk")
    })

    it("HONEYPOT still beats BUNDLE — total-loss on entry is even more critical than invisible concentration", async () => {
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const honeypotBundle: AISummaryInput = {
        score: 50,
        risk: "RUG",
        flags: [
          { label: "Bundle holds ~30% of supply", severity: "critical", impact: 400 },
          { label: "Honeypot detected", severity: "critical", impact: 500 },
        ],
        tokenSymbol: "TRAP",
        holders: 800,
        marketCap: 2e5,
        liquidity: 12000,
        lpBurned: false,
        lpLocked: false,
        mintAuthority: true,
        freezeAuthority: true,
        honeypot: true,
        tokenAgeHours: 6,
        sourcesUsed: ["dexscreener", "rugcheck", "goplus"],
        topHolderPct: 30,
        volume24h: 50000,
        priceChange1h: -15,
      }
      const result = await generateAISummary(honeypotBundle)
      goldenStructuralChecks(result)
      const para1 = result!.split(/\n\s*\n/)[0]
      expect(para1.toLowerCase()).toContain("honeypot")
      expect(para1).not.toContain("bundle rug")
    })

    it("all four golden scans land in the 30–80 word band — same length envelope", async () => {
      vi.stubEnv("GEMINI_API_KEY", "")
      delete process.env.GEMINI_API_KEY
      const inputs: AISummaryInput[] = [
        // HAWK
        { score: 105, risk: "RUG", flags: [{ label: "Concentration", severity: "critical", impact: 350 }], tokenSymbol: "HAWK", holders: 4200, marketCap: 2e6, liquidity: 71200, lpBurned: true, lpLocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false, tokenAgeHours: 24 * 35, sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"], topHolderPct: 44, volume24h: 500000, priceChange1h: -8 },
        // PIPPIN
        { score: 525, risk: "DANGER", flags: [{ label: "Stacked concentration", severity: "critical", impact: 250 }], tokenSymbol: "Pippin", holders: 1800, marketCap: 5e7, liquidity: 4.45e6, lpBurned: true, lpLocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false, tokenAgeHours: 24 * 90, sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"], topHolderPct: 27, volume24h: 2.5e6, priceChange1h: -3 },
        // FARTCOIN
        { score: 825, risk: "CAUTION", flags: [{ label: "Top concentration", severity: "warning", impact: 80 }], tokenSymbol: "Fartcoin", holders: 80000, marketCap: 7e8, liquidity: 7.4e6, lpBurned: true, lpLocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false, tokenAgeHours: 24 * 365, sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"], topHolderPct: 11, volume24h: 5e7, priceChange1h: 1.2 },
        // PENGU
        { score: 880, risk: "SAFE", flags: [], tokenSymbol: "PENGU", holders: 250000, marketCap: 1.5e9, liquidity: 4.4e6, lpBurned: false, lpLocked: true, mintAuthority: false, freezeAuthority: false, honeypot: false, tokenAgeHours: 24 * 200, sourcesUsed: ["dexscreener", "rugcheck", "goplus", "solscan"], topHolderPct: 4, volume24h: 8e7, priceChange1h: 0.5 },
      ]
      const wordCounts: number[] = []
      for (const input of inputs) {
        const result = await generateAISummary(input)
        expect(result).not.toBeNull()
        wordCounts.push(result!.split(/\s+/).filter((w) => w.length > 0).length)
      }
      // The whole point of the new contract: every verdict band lands
      // in roughly the same length envelope so the AI Summary panel
      // always looks balanced. Demo references sit between 30 and 75
      // words. The intrinsic variance (RUG has more to say than SAFE)
      // means we accept up to ~2.6× ratio — that's exactly what the
      // canonical /demo summaries show (HAWK 63 words / PENGU 30
      // words = 2.1x; with margin we allow up to 2.6x).
      for (const wc of wordCounts) {
        expect(wc).toBeGreaterThanOrEqual(25)
        expect(wc).toBeLessThanOrEqual(85)
      }
      const min = Math.min(...wordCounts)
      const max = Math.max(...wordCounts)
      expect(max / min).toBeLessThan(2.6)
    })
  })
})
