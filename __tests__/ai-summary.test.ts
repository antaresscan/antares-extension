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
  it("returns null when OPENAI_API_KEY is undefined", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    delete process.env.OPENAI_API_KEY
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("returns null when OPENAI_API_KEY is an empty string", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("does not call fetch when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    delete process.env.OPENAI_API_KEY
    const mockFetch = vi.fn()
    vi.stubGlobal("fetch", mockFetch)
    await generateAISummary(baseInput)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("calls fetch with correct URL and Authorization header when key is present", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-123")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "This is a valid summary that is long enough to pass validation checks." } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    await generateAISummary(baseInput)
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key-123",
        }),
      })
    )
  })

  it("returns trimmed summary string on a valid OpenAI 200 response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "  This token appears safe with strong liquidity and burned LP.  " } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBe("This token appears safe with strong liquidity and burned LP.")
  })

  it("returns null when fetch throws a network error", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"))
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("returns null when OpenAI returns HTTP 500", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ error: "internal server error" }, 500)
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })

  it("returns null when response content is empty or shorter than 20 chars", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key")
    const mockFetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        choices: [{ message: { content: "Too short" } }],
      })
    )
    vi.stubGlobal("fetch", mockFetch)
    const result = await generateAISummary(baseInput)
    expect(result).toBeNull()
  })
})
