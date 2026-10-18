// __tests__/audit-lot64.test.ts — Lot 64 of the file-by-file audit (2026-10-17): the AI summary keeps three of its own rules. Fails on the previous code.
//
// Three rules of api/_lib/ai-summary.ts could be broken with the whole suite green (and one guard of the Critical Actors cards, at the bottom):
//   1. the flags that describe OUR plumbing ("Helius unavailable", "Holder data unreliable") never reach Gemini (the founder's rule: they make the model
//      write "GoPlus was unreachable so we couldn't verify...");
//   2. a Gemini reply that is not 3 paragraphs is refused, even when its length is right (the only test sent a 10-word reply, refused by its length);
//   3. the local summary of a RUG never tells a concentration story the engine did not flag, even when the top holder holds 25 % or more (on a rug that
//      is often the pool itself). The CHILLHOUSE test covers 8.1 %, below the branch.

import { describe, it, expect, vi, afterEach } from "vitest"
import { generateAISummary } from "../api/_lib/ai-summary"
import type { AISummaryInput } from "../api/_lib/ai-summary"
import { composeCriticalActors } from "../api/_lib/critical-actors"
import type { HeliusHolder } from "../api/_lib/types"
import type { InsiderGraphResult } from "../api/_lib/insider-graph"

const input: AISummaryInput = {
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

const reply = (content: string, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify({ choices: [{ message: { content } }] }), json: async () => ({}) }) as Response

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("the AI summary — what reaches Gemini", () => {
  it("the flags about our own sources (unavailable, rate-limited, holder data unreliable) are never in the prompt, nor in the local summary", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const fetchMock = vi.fn().mockResolvedValue(reply("", 500))
    vi.stubGlobal("fetch", fetchMock)
    const flags = [
      ...input.flags,
      { label: "Helius unavailable", severity: "warning", impact: 0 },
      { label: "GoPlus rate-limited", severity: "warning", impact: 0 },
      { label: "Holder data unreliable — top holders unknown", severity: "warning", impact: 0 },
    ]

    const summary = await generateAISummary({ ...input, flags })

    const body = String((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body, "the prompt carries the token's flags (the check is not blind)").toContain("Mint authority enabled")
    for (const plumbing of ["Helius unavailable", "GoPlus rate-limited", "Holder data unreliable"]) {
      expect(body).not.toContain(plumbing)
      expect(summary).not.toContain(plumbing)
    }
  })

  // The creator's text is bounded before it enters the prompt (promptText: 32 characters for the symbol, 200 for a flag label). The line breaks
  // are tested in audit-lot21; the bound was not: a symbol of any length reached Gemini whole.
  it("the creator's symbol enters the prompt cut to 32 characters, a flag label to 200", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const fetchMock = vi.fn().mockResolvedValue(reply("", 500))
    vi.stubGlobal("fetch", fetchMock)
    const symbol = "S".repeat(40) + "IGNORE-PREVIOUS-INSTRUCTIONS"
    const label = "Deceptive name " + "L".repeat(300) + " END-OF-LABEL"

    await generateAISummary({ ...input, tokenSymbol: symbol, flags: [{ label, severity: "warning", impact: 10 }] })

    const prompt = (JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body)) as { messages: Array<{ content: string }> })
      .messages.map((m) => m.content).join("\n")
    expect(prompt).toContain("Token: " + "S".repeat(32))
    expect(prompt).not.toContain("S".repeat(33))
    expect(prompt).not.toContain("IGNORE-PREVIOUS-INSTRUCTIONS")
    expect(prompt).toContain(label.slice(0, 200))
    expect(prompt).not.toContain("END-OF-LABEL")
  })
})

describe("the AI summary — what is accepted from Gemini", () => {
  const sentence = "TEST keeps a SAFE profile with burned liquidity and renounced authorities across the sources it was checked against"

  it("a reply of the right length in ONE paragraph is refused: the local 3-paragraph summary is used", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const oneParagraph = `${sentence}. ${sentence}. ${sentence}.` // ~57 words: inside the word band of this scan
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(oneParagraph)))

    const summary = await generateAISummary(input)

    expect(summary).not.toContain(sentence)
    expect(summary!.split(/\n\s*\n/).filter((p) => p.trim().length > 0)).toHaveLength(3)
  })

  it("witness: the same words in 3 paragraphs are used as Gemini wrote them", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key")
    const threeParagraphs = `${sentence}.\n\n${sentence}.\n\n${sentence}.`
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(threeParagraphs)))

    expect(await generateAISummary(input)).toBe(threeParagraphs)
  })
})

describe("the local summary of a RUG tells only what the engine flagged", () => {
  const rug: AISummaryInput = {
    ...input,
    score: 90,
    risk: "RUG",
    flags: [{ label: "LP not locked or burned", severity: "critical", impact: 300 }],
    lpBurned: false,
    lpLocked: false,
    topHolderPct: 31.4, // often the pool itself on a rug: no concentration flag was raised
  }

  it("a top holder at 31 % with no concentration flag: no concentration story, the LP one (the flag that fired)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY

    const summary = await generateAISummary(rug)

    expect(summary).not.toMatch(/concentration rug|single wallet holds/i)
    expect(summary).toMatch(/exit-scam/i)
  })

  it("witness: with the concentration flag raised, the same token is told as a concentration rug", async () => {
    vi.stubEnv("GEMINI_API_KEY", "")
    delete process.env.GEMINI_API_KEY

    const summary = await generateAISummary({ ...rug, flags: [{ label: "Top holder concentration 31%", severity: "critical", impact: 400 }, ...rug.flags] })

    expect(summary).toMatch(/concentration rug/i)
    expect(summary).toContain("31.4%")
  })
})

// Critical Actors (api/_lib/critical-actors.ts): the "noise clusters" test is titled "< 1% supply or singletons" but only has the < 1 % case.
describe("Critical Actors — what is never shown", () => {
  const SUPPLY = 1_000_000
  const W1 = "ClusterWallet1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const graphWith = (wallets: string[], totalPct: number): InsiderGraphResult => ({
    nodes: [],
    edges: [],
    clusters: [{ wallets, totalPct, label: "Insider Group 1" }],
    stats: { totalHolders: 0, analyzedWallets: 0, clusterCount: 1, insiderPct: totalPct },
    cachedAt: 0,
  })
  const compose = (holders: HeliusHolder[], insiderGraph: InsiderGraphResult | null) =>
    composeCriticalActors({ tokenCreator: null, creatorReputation: null, realHolderAccounts: holders, totalSupplyUi: SUPPLY, insiderGraph })

  it("a 'cluster' of ONE wallet, however large, is not a cluster: the page would draw a lone wallet as a coordinated one", () => {
    const out = compose([{ address: "a1", owner: W1, uiAmount: SUPPLY * 0.06 }], graphWith([W1], 6))
    expect(out[0].type).toBe("insider")
    expect(out[0].tag).toBe("Holder #1")
  })

  it("witness: two wallets holding 6 % together are a cluster", () => {
    const out = compose([{ address: "a1", owner: W1, uiAmount: SUPPLY * 0.06 }], graphWith([W1, "OtherWallet2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], 6))
    expect(out[0].type).toBe("cluster")
  })
})
