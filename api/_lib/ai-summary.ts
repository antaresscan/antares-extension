import { logger } from "./logger"

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
const TIMEOUT_MS = 8000
const MIN_LENGTH = 20
// Bumped 1200→1800 so we never have to truncate a complete Gemini
// output mid-sentence. Gemini under the new max_tokens=600 budget
// (see callGemini) can land at ~1500 chars on dense scans; 1800
// gives a comfortable safety margin without ballooning UI height.
const MAX_LENGTH = 1800
const MAX_RETRIES = 2
const RETRY_DELAYS = [1500, 3000]

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  bonus: 2,
  info: 3,
}

/**
 * Local flag explanation dictionary.
 * Used as fallback when Gemini is unavailable.
 */
const FLAG_EXPLANATIONS: Record<string, string> = {
  "Bundle activity detected": "Coordinated wallets bought together at launch to inflate the price. They hold a large share and can dump simultaneously, crashing the price.",
  "Wash trading detected": "The trading volume is fake. Bots are trading with themselves to create the illusion of demand. Real buyers are scarce.",
  "Honeypot detected": "This token prevents you from selling. Once you buy, your funds are trapped and the developer keeps all the liquidity.",
  "Mint authority enabled": "The developer can create unlimited new tokens at any time, diluting your holdings to zero.",
  "Freeze authority enabled": "The developer can freeze your wallet, preventing you from selling or transferring your tokens.",
  "LP not locked or burned": "The developer can remove all liquidity in one transaction. When that happens, the token price drops to zero and nobody can sell.",
  "Very low liquidity": "There is almost no real money backing this token. Even a small sell order will crash the price significantly.",
  "Very few holders": "Extreme concentration of ownership. A single wallet selling can collapse the entire market.",
  "Top holder concentration": "A small number of wallets control most of the supply. They can coordinate a dump at any time.",
  "Token is very new": "This token was just created. New tokens have the highest rug pull rate as developers often abandon them after extracting liquidity.",
  "Copycat token name": "This token copies the name of a popular project to trick buyers into thinking it is legitimate.",
  "High sell tax": "A large percentage of every sell is taken as tax, making it nearly impossible to exit profitably.",
  "Ownership not renounced": "The developer retains admin control and can change contract rules, add taxes, or drain liquidity.",
}

function getFlagExplanation(label: string): string | null {
  // Exact match
  if (FLAG_EXPLANATIONS[label]) return FLAG_EXPLANATIONS[label]
  // Partial match
  const lowerLabel = label.toLowerCase()
  for (const [key, val] of Object.entries(FLAG_EXPLANATIONS)) {
    if (lowerLabel.includes(key.toLowerCase().split(" ")[0]) && lowerLabel.includes(key.toLowerCase().split(" ").slice(-1)[0])) {
      return val
    }
  }
  return null
}

/**
 * Build a structured explanation prompt from the scan data.
 */
function buildUserPrompt(input: AISummaryInput, topFlags: Array<{ label: string; severity: string; impact: number }>): string {
  const lines: string[] = []
  lines.push(`Token: ${input.tokenSymbol || "unknown"}`)
  lines.push(`Score: ${input.score}/1000, Verdict: ${input.risk}`)
  lines.push(`Sources used: ${input.sourcesUsed.join(", ") || "none"}`)

  const metrics: string[] = []
  if (input.holders !== null) metrics.push(`holders: ${input.holders}`)
  if (input.marketCap !== null) metrics.push(`mcap: $${input.marketCap.toLocaleString()}`)
  if (input.liquidity !== null) metrics.push(`liquidity: $${input.liquidity.toLocaleString()}`)
  if (input.volume24h !== null) metrics.push(`24h volume: $${input.volume24h.toLocaleString()}`)
  if (input.tokenAgeHours !== null) metrics.push(`age: ${input.tokenAgeHours}h`)
  if (input.priceChange1h !== null) metrics.push(`1h price change: ${input.priceChange1h}%`)
  if (input.topHolderPct !== null) metrics.push(`top holder owns ${input.topHolderPct.toFixed(1)}% of supply`)
  if (metrics.length > 0) lines.push(`Metrics: ${metrics.join(", ")}`)

  const bools: string[] = []
  if (input.lpBurned) bools.push("LP burned")
  else if (input.lpLocked) bools.push("LP locked")
  else bools.push("LP NOT burned or locked")
  if (input.mintAuthority) bools.push("mint authority ENABLED")
  if (input.freezeAuthority) bools.push("freeze authority ENABLED")
  if (input.honeypot) bools.push("HONEYPOT detected")
  lines.push(`Status: ${bools.join(", ")}`)

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Single Gemini call. Returns:
 * - the summary string on success
 * - "__RETRY__" if the error is recoverable (429 or timeout)
 * - null for all other errors
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
        // max_tokens 350→600. The previous ceiling was hitting mid-
        // sentence on dense-flag scans (e.g. the user-reported Luca
        // RUG that ended at "...remove all $5" — Gemini was
        // budgeting "$52.7K of liquidity" but ran out of tokens
        // mid-number). 600 gives 4 full sentences of headroom even
        // when the system prompt + 8 flags + metrics line bloat the
        // input. Still well under Gemini's per-call cost ceiling.
        max_tokens: 600,
        // temperature 0.35→0.25. Lower temp keeps the output focused
        // on the concrete numbers we feed in (top holder %, holders,
        // liquidity, age) instead of drifting into generic risk
        // narratives. Same model, sharper output.
        temperature: 0.25,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (response.status === 429) {
      logger.warn("ai-summary", "Gemini rate-limited", { status: 429 })
      return "__RETRY__"
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown")
      logger.warn("ai-summary", "Gemini HTTP error", {
        status: response.status,
        body: errorText.slice(0, 500),
      })
      return null
    }

    const raw = await response.text()
    let data: { choices?: Array<{ message?: { content?: string } }> }
    try {
      data = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> }
    } catch {
      logger.warn("ai-summary", "Failed to parse Gemini response as JSON")
      return null
    }

    const msg = data?.choices?.[0]?.message?.content?.trim()
    if (typeof msg !== "string") return null
    if (msg.length < MIN_LENGTH) return null
    if (msg.length > MAX_LENGTH) return msg.slice(0, MAX_LENGTH).replace(/\s+\S*$/, "") + "."
    return msg
  } catch (err: unknown) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === "AbortError") {
      logger.warn("ai-summary", "Gemini call timed out")
      return "__RETRY__"
    }
    logger.warn("ai-summary", "Gemini call error", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Generate a deterministic local fallback summary when Gemini is unavailable.
 * Uses the FLAG_EXPLANATIONS dictionary to explain the most critical flags.
 */
function generateLocalFallback(
  input: AISummaryInput,
  topFlags: Array<{ label: string; severity: string; impact: number }>,
): string | null {
  const parts: string[] = []

  // Try to explain the top 1-2 flags
  for (const flag of topFlags.slice(0, 2)) {
    const explanation = getFlagExplanation(flag.label)
    if (explanation) {
      parts.push(explanation)
    }
  }

  // Add context from boolean checks if no flag explanations found
  if (parts.length === 0) {
    if (input.honeypot) {
      parts.push("This token is a honeypot. You will not be able to sell after buying. Your funds will be permanently trapped.")
    }
    if (input.mintAuthority) {
      parts.push("Mint authority is still enabled, meaning the developer can create unlimited new tokens and crash the price to zero.")
    }
    if (input.freezeAuthority) {
      parts.push("Freeze authority is enabled. The developer can freeze any wallet, preventing holders from selling.")
    }
    if (!input.lpBurned && !input.lpLocked) {
      parts.push("Liquidity is not locked or burned. The developer can pull all liquidity at any moment, making the token worthless.")
    }
  }

  // Add metrics context
  if (input.topHolderPct !== null && input.topHolderPct > 20) {
    parts.push(`The top wallet holds ${input.topHolderPct.toFixed(1)}% of supply${input.holders !== null ? " with only " + input.holders + " holders" : ""}, creating extreme dump risk.`)
  }

  // For safe tokens
  if (parts.length === 0 && input.risk === "SAFE") {
    const safePoints: string[] = []
    if (input.lpBurned) safePoints.push("LP is burned")
    else if (input.lpLocked) safePoints.push("LP is locked")
    if (!input.mintAuthority) safePoints.push("mint authority is disabled")
    if (!input.freezeAuthority) safePoints.push("freeze authority is disabled")
    if (input.holders !== null && input.holders > 100) safePoints.push(`${input.holders} holders show organic distribution`)
    if (safePoints.length > 0) {
      parts.push(`Score ${input.score}/1000. ${safePoints.join(", ")}. No critical risks were detected in the contract or holder analysis.`)
    }
  }

  if (parts.length === 0) return null

  const result = parts.join(" ")
  logger.info("ai-summary", "Local fallback generated", { chars: result.length })
  return result.length > MAX_LENGTH ? result.slice(0, MAX_LENGTH).replace(/\s+\S*$/, "") + "." : result
}

export async function generateAISummary(
  input: AISummaryInput
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey === "") {
    logger.info("ai-summary", "No GEMINI_API_KEY found, using local fallback")
  }

  const primaryModel = process.env.AI_MODEL || "gemini-2.5-flash"

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

  // Try Gemini with retries
  if (apiKey && apiKey !== "") {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1] || 3000
        logger.info("ai-summary", "Retrying Gemini call", {
          attempt,
          maxRetries: MAX_RETRIES,
          delayMs: delay,
        })
        await sleep(delay)
      }

      logger.info("ai-summary", "Calling Gemini", {
        model: primaryModel,
        attempt: attempt + 1,
        totalAttempts: MAX_RETRIES + 1,
      })
      const result = await callGemini(apiKey, primaryModel, SYSTEM_PROMPT, userPrompt)

      if (result === "__RETRY__") {
        // Continue to next retry attempt
        continue
      }

      if (result !== null) {
        logger.info("ai-summary", "Gemini success", { attempt: attempt + 1, chars: result.length })
        return result
      }

      // null = non-recoverable error, fall through to fallback
      logger.warn("ai-summary", "Gemini returned non-recoverable error, using fallback")
      break
    }

    logger.warn("ai-summary", "All Gemini attempts exhausted, using local fallback")
  }

  // Local fallback: generate summary from flag dictionary
  const fallback = generateLocalFallback(input, topFlags)
  if (fallback) {
    logger.info("ai-summary", "Returning local fallback", { chars: fallback.length })
    return fallback
  }

  logger.error("ai-summary", "No fallback could be generated either")
  return null
}
