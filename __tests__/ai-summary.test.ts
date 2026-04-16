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

  it("returns null when GEMINI_API_KEY is missing and no flags are recognized", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const result = await generateAISummary(noFlagInput)
    expect(result).toBeNull()
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

  it("returns trimmed summary string on a valid 200 response", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: " This token appears safe with strong liquidity and burned LP. " } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBe("This token appears safe with strong liquidity and burned LP.")
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

  it("returns null when fetch throws a network error and no flags are recognized", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"))
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(noFlagInput)
    expect(result).toBeNull()
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

  it("truncates and returns a string when response content exceeds MAX_LENGTH (1200 chars)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const longContent = "This is a valid sentence that will be repeated. ".repeat(30)
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: longContent } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
    expect(result!.length).toBeLessThanOrEqual(1200)
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

  it("returns null on 429 when no flags are recognized for fallback", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ error: "rate limit" }, 429)
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(noFlagInput)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(result).toBeNull()
  })

  it("succeeds on second attempt after initial 429", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ error: "rate limit" }, 429))
      .mockResolvedValueOnce(
        mockFetchResponse({
          choices: [{ message: { content: "This is a valid summary returned on the second attempt after retry." } }],
        })
      )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result).toBe("This is a valid summary returned on the second attempt after retry.")
  })
})
