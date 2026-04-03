// api/_lib/ai-summary.ts — AI-powered scan summary generator
import type { ScanFlag, Verdict } from "./types";
import { fetchJson } from "./helpers";

export interface AISummaryInput {
  score: number;
  risk: Verdict;
  flags: ScanFlag[];
  tokenSymbol: string | null;
  holders: number | null;
  marketCap: number | null;
  liquidity: number | null;
  lpBurned: boolean;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  honeypot: boolean;
  tokenAgeHours: number | null;
  sourcesUsed: string[];
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MAX_FLAGS = 8;
const TIMEOUT_MS = 4000;

/**
 * Generate a 2-3 sentence AI summary of a token scan.
 * Uses GPT-4o-mini for cost efficiency (~$0.00015/call).
 * Returns null silently on any failure — never blocks the scan.
 */
export async function generateAISummary(input: AISummaryInput): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const topFlags = input.flags
    .filter(f => f.severity === "critical" || f.severity === "warning")
    .slice(0, MAX_FLAGS)
    .map(f => `[${f.severity.toUpperCase()}] ${f.label}`);

  const context = {
    token: input.tokenSymbol || "Unknown",
    score: `${input.score}/1000`,
    verdict: input.risk,
    flags: topFlags,
    holders: input.holders,
    marketCap: input.marketCap,
    liquidity: input.liquidity,
    lpBurned: input.lpBurned,
    mintAuthority: input.mintAuthority,
    freezeAuthority: input.freezeAuthority,
    honeypot: input.honeypot,
    ageHours: input.tokenAgeHours,
    sources: input.sourcesUsed.length,
  };

  const systemPrompt = [
    "You are Antares, a Solana token safety analyst.",
    "Given scan data, write exactly 2-3 sentences summarizing the risk level and key findings.",
    "Be direct and specific. Mention the most critical flags first.",
    "Use trader-friendly language. No markdown, no bullet points.",
    "If the token is dangerous, warn clearly. If safe, confirm why.",
  ].join(" ");

  try {
    const response = await fetchJson(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 120,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
    }, TIMEOUT_MS);

    const msg = (response as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content?.trim();

    if (!msg || msg.length < 10 || msg.length > 500) return null;
    return msg;
  } catch {
    // AI summary is best-effort — never fail the scan
    return null;
  }
}
