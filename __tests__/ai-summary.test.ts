import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateAISummary } from "../api/_lib/ai-summary";
import type { AISummaryInput } from "../api/_lib/ai-summary";

vi.mock("../api/_lib/helpers", () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from "../api/_lib/helpers";
const mockFetchJson = vi.mocked(fetchJson);

const baseInput: AISummaryInput = {
  score: 750,
  risk: "SAFE",
  flags: [
    { label: "LP burned", severity: "bonus" },
    { label: "Low holders", severity: "warning" },
  ],
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
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("generateAISummary", () => {
  it("returns null when OPENAI_API_KEY is not set", async () => {
    const result = await generateAISummary(baseInput);
    expect(result).toBeNull();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("calls OpenAI API when key is set and returns summary", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetchJson.mockResolvedValueOnce({
      choices: [{ message: { content: "This token appears safe with strong liquidity and burned LP." } }],
    });
    const result = await generateAISummary(baseInput);
    expect(result).toBe("This token appears safe with strong liquidity and burned LP.");
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it("returns null when API returns empty content", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetchJson.mockResolvedValueOnce({
      choices: [{ message: { content: "" } }],
    });
    const result = await generateAISummary(baseInput);
    expect(result).toBeNull();
  });

  it("returns null when API returns too short content", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetchJson.mockResolvedValueOnce({
      choices: [{ message: { content: "Short" } }],
    });
    const result = await generateAISummary(baseInput);
    expect(result).toBeNull();
  });

  it("returns null when API returns too long content", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetchJson.mockResolvedValueOnce({
      choices: [{ message: { content: "x".repeat(501) } }],
    });
    const result = await generateAISummary(baseInput);
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetchJson.mockRejectedValueOnce(new Error("timeout"));
    const result = await generateAISummary(baseInput);
    expect(result).toBeNull();
  });

  it("returns null when choices array is empty", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetchJson.mockResolvedValueOnce({ choices: [] });
    const result = await generateAISummary(baseInput);
    expect(result).toBeNull();
  });

  it("filters only critical and warning flags", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetchJson.mockResolvedValueOnce({
      choices: [{ message: { content: "Token has some warning signs but is generally okay." } }],
    });
    await generateAISummary(baseInput);
    const callArgs = mockFetchJson.mock.calls[0];
    const body = JSON.parse((callArgs[1] as any).body);
    const context = JSON.parse(body.messages[1].content);
    expect(context.flags).toEqual(["[WARNING] Low holders"]);
  });
});
