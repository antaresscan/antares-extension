export type AISummaryInput = {
  score: number
  risk: string
  flags: Array<{ label: string; severity: string; impact: number }>
  tokenSymbol: string | null
  holders: number | null
  marketCap: number | null
  liquidity: number | null
  lpBurned: boolean | null
  lpLocked: boolean | null
  mintAuthority: boolean | null
  freezeAuthority: boolean | null
  honeypot: boolean | null
  tokenAgeHours: number | null
  sourcesUsed: string[]
  topHolderPct: number | null
  volume24h: number | null
  priceChange1h: number | null
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
const MAX_FLAGS = 8
const TIMEOUT_MS = 6000
const RETRY_DELAY_MS = 1200
const MIN_LENGTH = 20
const MAX_LENGTH = 1200

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  bonus: 2,
  info: 3,
}

/**
 * Build a structured explanation prompt from the scan data.
 * The goal: Gemini must explain WHY the token is dangerous (or safe)
 * using the actual flags and numbers, not just repeat the verdict.
 */
function buildUserPrompt(input: AISummaryInput, topFlags: Array<{ label: string; severity: string; impact: number }>): string {
  const lines: string[] = []

  lines.push(`Token: ${input.tokenSymbol || "unknown"}`)
  lines.push(`Score: ${input.score}/1000, Verdict: ${input.risk}`)
  lines.push(`Sources used: ${input.sourcesUsed.join(", ") || "none"}`)

  // Key metrics
  const metrics: string[] = []
  if (input.holders !== null) metrics.push(`holders: ${input.holders}`)
  if (input.marketCap !== null) metrics.push(`mcap: $${input.marketCap.toLocaleString()}`)
  if (input.liquidity !== null) metrics.push(`liquidity: $${input.liquidity.toLocaleString()}`)
  if (input.volume24h !== null) metrics.push(`24h volume: $${input.volume24h.toLocaleString()}`)
  if (input.tokenAgeHours !== null) metrics.push(`age: ${input.tokenAgeHours}h`)
  if (input.priceChange1h !== null) metrics.push(`1h price change: ${input.priceChange1h}%`)
  if (input.topHolderPct !== null) metrics.push(`top holder owns ${input.topHolderPct.toFixed(1)}% of supply`)
  if (metrics.length > 0) lines.push(`Metrics: ${metrics.join(", ")}`)

  // Boolean flags
  const bools: string[] = []
  if (input.lpBurned) bools.push("LP burned")
  else if (input.lpLocked) bools.push("LP locked")
  else bools.push("LP NOT burned or locked")
  if (input.mintAuthority) bools.push("mint authority ENABLED")
  if (input.freezeAuthority) bools.push("freeze authority ENABLED")
  if (input.honeypot) bools.push("HONEYPOT detected")
  lines.push(`Status: ${bools.join(", ")}`)

  // Flags with severity and impact
  if (topFlags.length > 0) {
    lines.push("")
    lines.push("Detected flags (most critical first):")
    for (const f of topFlags) {
      lines.push(`- [${f.severity}] ${f.label} (impact: ${f.impact})`)
    }
  }

  lines.push("")
  lines.push("Explain the 1-2 most dangerous flags above to a retail user. Describe the MECHANISM of danger in concrete terms.")

  return lines.join("\n")
}

const SYSTEM_PROMPT =
  "You are a crypto risk analyst explaining a Solana token scan to a retail user in plain English. " +
  "Your job is NOT to repeat the verdict \u2014 the user already sees SAFE / DANGER / RUG PULL on screen. " +
  "Your job is to explain WHY by picking the 1 or 2 most important flags and describing " +
  "the exact mechanism of danger in concrete terms using the numbers provided. " +
  "Examples of good explanations: " +
  "'Bundle activity means a group of coordinated wallets bought together at launch to inflate the price \u2014 " +
  "they now hold a large share and can dump simultaneously, crashing the price instantly.' " +
  "'Wash trading means the volume you see is fake \u2014 bots are trading with themselves to create the " +
  "illusion of demand. Real buyers are scarce, and the price can collapse once the bots stop.' " +
  "'LP not locked means the developer can remove all liquidity in one transaction \u2014 when that happens, " +
  "the token price drops to zero and nobody can sell.' " +
  "'The top wallet holds 45% of supply with only 12 holders \u2014 one sell order from this wallet would crash the price.' " +
  "Rules: " +
  "- Start directly with the flag name or the danger, never with 'This token is' or 'Based on the data'. " +
  "- Write 2 to 4 sentences max. " +
  "- Be specific: USE the numbers from the data (holders, liquidity, top holder %, age, score). " +
  "- If the token is SAFE, explain what passed (LP burned, clean holders, good score) in the same concrete style. " +
  "- Never use markdown, emojis, bullet points, or generic disclaimers. Output only the sentences."

/**
 * Single Gemini call. Returns:
 * - the summary string on success
 * - "__RETRY__" if the error is recoverable (429 rate-limit or AbortError timeout)
 * - null for all other errors (network failure, 5xx, bad payload, etc.)
 */
async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | "__RETRY__" | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 350,
        temperature: 0.35,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    // 429 = rate-limit -> recoverable
    if (response.status === 429) return "__RETRY__"
    if (!response.ok) return null
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const msg = data?.choices?.[0]?.message?.content?.trim()
    if (typeof msg !== "string") return null
    if (msg.length < MIN_LENGTH) return null
    if (msg.length > MAX_LENGTH) return msg.slice(0, MAX_LENGTH).replace(/\s+\S*$/, "") + "."
    return msg
  } catch (err: unknown) {
    clearTimeout(timeout)
    // Only retry on AbortError (our own timeout signal) -- not on network errors
    if (err instanceof Error && err.name === "AbortError") return "__RETRY__"
    return null
  }
}

export async function generateAISummary(
  input: AISummaryInput
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey === "") return null

  const primaryModel = process.env.AI_MODEL || "gemini-2.5-flash"
  const fallbackModel = "gemini-2.0-flash"

  // Sort flags by severity then impact
  const topFlags = input.flags
    .slice()
    .filter((f) => f.severity !== "bonus")
    .sort((a, b) => {
      const aSev = SEVERITY_ORDER[a.severity] ?? 3
      const bSev = SEVERITY_ORDER[b.severity] ?? 3
      if (aSev !== bSev) return aSev - bSev
      return b.impact - a.impact
    })
    .slice(0, MAX_FLAGS)

  const userPrompt = buildUserPrompt(input, topFlags)

  // Attempt 1: primary model
  let result = await callGemini(apiKey, primaryModel, SYSTEM_PROMPT, userPrompt)

  // Retry once on recoverable error (429 or timeout), then try fallback
  if (result === "__RETRY__") {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    result = await callGemini(apiKey, primaryModel, SYSTEM_PROMPT, userPrompt)
  }

  // If still failing, switch to fallback model
  if (result === "__RETRY__" || result === null) {
    result = await callGemini(apiKey, fallbackModel, SYSTEM_PROMPT, userPrompt)
  }

  // Last chance: retry fallback on recoverable error
  if (result === "__RETRY__") {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    result = await callGemini(apiKey, fallbackModel, SYSTEM_PROMPT, userPrompt)
  }

  if (result === "__RETRY__") return null
  return result
}
