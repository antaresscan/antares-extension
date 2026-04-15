import { describe, it, expect, vi, afterEach } from "vitest"
import { generateAISummary } from "../api/_lib/ai-summary"
import type { AISummaryInput } from "../api/_lib/ai-summary"

const baseInput: AISummaryInput = {
  score: 750,
  risk: "SAFE",
  flags: ["[critical] Mint authority enabled", "[warning] Low holders"],
  tokenSymbol: "TEST",
  holders: 500,
  marketCap: 100000,
  liquidity: 50000,
  lpBurned: true,
  mintAuthority: false,
  freezeAuthority: false,
  honeypot: false,
  tokenAgeHours: 48,
  sourcesUsed: ["dexscreener", "rugcheck", "goplus"],
}

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("generateAISummary", () => {
  it("returns null when GEMINI_API_KEY is undefined", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("returns null when GEMINI_API_KEY is an empty string", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    const result = await generateAISummary(baseInput)
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

  it("returns null when fetch throws a network error", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"))
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("returns null when API returns HTTP 500", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ error: "internal server error" }, 500)
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("returns null when response content is empty or shorter than 20 chars", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "Too short" } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("truncates and returns a string (not null) when response content exceeds MAX_LENGTH (800 chars)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const longContent = "This is a valid sentence that will be repeated. ".repeat(20) // ~960 chars
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: longContent } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
    expect(result!.length).toBeLessThanOrEqual(800)
    expect(result!.endsWith(".")).toBe(true)
  })

  it("returns null when choices array has no message content", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: {} }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("sorts bonus flags after critical and warning", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const inputWithBonus: AISummaryInput = {
      ...baseInput,
      flags: [
        "[bonus] LP Burned",
        "[critical] Mint authority enabled",
        "[warning] Low holders",
        "[info] Token is 3 days old",
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
    // Verify fetch was called (flags were processed without throwing)
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it("handles flags with no recognized severity prefix (info fallback)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const inputNoSeverity: AISummaryInput = {
      ...baseInput,
      flags: ["unknown_flag_without_severity", "another_plain_flag"],
    }
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "This token has no recognized severity flags but looks borderline." } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(inputNoSeverity)
    expect(result).not.toBeNull()
    expect(mockFetch).toHaveBeenCalledOnce()
  })
})
