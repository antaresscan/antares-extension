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
  // Format age as the demo summaries do — "30d+ trading history" /
  // "young (<24h)" — so Gemini can drop it into the counter-context
  // paragraph verbatim.
  if (input.tokenAgeHours !== null) {
    const days = input.tokenAgeHours / 24
    if (days >= 30) metrics.push(`age: 30d+ trading history`)
    else if (days >= 7) metrics.push(`age: ${Math.round(days)}d (established)`)
    else if (days >= 1) metrics.push(`age: ${Math.round(days)}d (recent)`)
    else metrics.push(`age: <24h (very young)`)
  }
  if (input.priceChange1h !== null) metrics.push(`1h price change: ${input.priceChange1h}%`)
  if (input.topHolderPct !== null) metrics.push(`top holder owns ${input.topHolderPct.toFixed(1)}% of supply`)
  if (metrics.length > 0) lines.push(`Metrics: ${metrics.join(", ")}`)

  // Explicitly list BOTH positive and negative status — not just the
  // negatives. Without "mint renounced / freeze renounced / no
  // honeypot" the model has no way to weave those into the
  // counter-context paragraph (the "what's clean" half of the demo
  // narrative).
  const bools: string[] = []
  if (input.lpBurned) bools.push("LP burned (good)")
  else if (input.lpLocked) bools.push("LP locked (good)")
  else bools.push("LP NOT burned or locked (BAD)")
  bools.push(input.mintAuthority ? "mint authority ENABLED (BAD)" : "mint authority renounced (good)")
  bools.push(input.freezeAuthority ? "freeze authority ENABLED (BAD)" : "freeze authority renounced (good)")
  bools.push(input.honeypot ? "HONEYPOT detected (BAD)" : "no honeypot (good)")
  lines.push(`Status: ${bools.join(", ")}`)

  if (topFlags.length > 0) {
    lines.push("")
    lines.push("Detected flags (most critical first):")
    for (const f of topFlags) {
      lines.push(`- [${f.severity}] ${f.label} (impact: ${f.impact})`)
    }
  } else {
    lines.push("")
    lines.push("No flags raised — verdict is driven by the bonus signals above.")
  }

  lines.push("")
  lines.push(
    "Write the 3-paragraph AI Verdict block. Paragraph 1 = verdict reason with concrete numbers. " +
      "Paragraph 2 = counter-context that weaves both the flags AND the bonus status (good/BAD signals above). " +
      "Paragraph 3 = boundary case (why this verdict, not the adjacent one) for CAUTION/DANGER, action statement for RUG, brief confirming closer for SAFE.",
  )
  return lines.join("\n")
}

// Re-engineered for demo-quality narrative output. The previous prompt
// capped output at "2 to 4 sentences max" and forced focus on "1 or 2
// most important flags" \u2014 both of which collapsed the response into a
// flag explanation rather than a full verdict explanation. Demo-quality
// summaries (HAWK, PIPPIN, FARTCOIN, PENGU on /demo) are structured as
// 3 short paragraphs that tell the verdict's story: primary reason,
// counter-context (positive signals + whether they save the verdict),
// and either the boundary case (why this band, not adjacent) or the
// trader action (RUG \u2192 "Hard kill, treat as exit-only"). The
// examples below are the actual demo summaries verbatim so Gemini
// anchors on them as the target style.
const SYSTEM_PROMPT =
  "You are writing the AI Verdict block of an Antares Solana token scan overlay. " +
  "The user already sees the verdict pill (SAFE / CAUTION / DANGER / RUG PULL), the score (X / 1000) and a list of detected flags. " +
  "Your block goes underneath. It must explain WHY the verdict landed where it did, in concrete trader language, weaving multiple signals into a coherent narrative. " +
  "\n\n" +
  "WRITE EXACTLY 3 SHORT PARAGRAPHS, separated by a blank line. Total 5 to 9 sentences across all three paragraphs. " +
  "\n\n" +
  "PARAGRAPH 1 \u2014 THE VERDICT REASON (1 sentence). " +
  "Open with the token name. State the verdict and the primary mechanism in one tight sentence with concrete numbers. Use one of these patterns: " +
  "\u2022 \"{Symbol} is the textbook concentration rug \u2014 {primary numeric reason}.\" (RUG with one dominant cause). " +
  "\u2022 \"{Symbol} lands on {VERDICT} because {primary mechanism with numbers}.\" (DANGER / CAUTION). " +
  "\u2022 \"{Symbol} shows a SAFE profile with {primary positive signals}.\" (SAFE). " +
  "\n\n" +
  "PARAGRAPH 2 \u2014 THE COUNTER-CONTEXT (1 to 3 sentences). " +
  "List the OTHER signals that matter \u2014 both positive (LP burned, mint and freeze renounced, no honeypot, 30d+ trading history, holder count) and negative (additional concentration, source disagreements, recent flow). " +
  "For RUG / DANGER, explain whether the positives \"save\" the verdict or get overridden by the dominant flag. " +
  "For SAFE / CAUTION, list the positives matter-of-factly and reference sources by name when they cross-validate. " +
  "\n\n" +
  "PARAGRAPH 3 \u2014 THE BOUNDARY OR ACTION (1 to 2 sentences). " +
  "\u2022 RUG: state the trader action. Examples: \"Hard kill. Treat any remaining liquidity as exit-only.\" or \"Do not buy. The chart is the bait.\" " +
  "\u2022 DANGER: explain why DANGER and not RUG, or why not CAUTION \u2014 what specifically tips it. " +
  "\u2022 CAUTION: explain why not SAFE and why not DANGER \u2014 the boundary case. " +
  "\u2022 SAFE: a brief confirming closer. Examples: \"Strong holder distribution.\" or \"Cross-validates across the 7 layers.\" " +
  "\n\n" +
  "EXAMPLES OF THE FULL FORMAT (these are real outputs, copy this style exactly): " +
  "\n\n" +
  "[RUG, score 105, single wallet 44%]\n" +
  "\"Hawk Tuah is the textbook concentration rug \u2014 a single wallet holds 44% of total supply, more than enough to crash the price to zero in one transaction.\n\n" +
  "LP is technically burned and the token has 30d+ of trading history, but those signals are completely overridden by the wallet concentration: the dev (or whoever controls that wallet) can dump at any moment and the remaining holders cannot defend the price.\n\n" +
  "Hard kill. Treat any remaining liquidity as exit-only.\"" +
  "\n\n" +
  "[DANGER, score 525, top1 27%, top10 67%]\n" +
  "\"Pippin lands on DANGER because of stacked concentration risk \u2014 a single wallet holds 27% of supply and the top 10 wallets together control 67%.\n\n" +
  "Either of those alone would already trigger a soft block; together they make a coordinated dump trivially possible.\n\n" +
  "The LP is burned and the contract is clean (no mint, no freeze, no honeypot), which keeps the verdict from collapsing all the way to RUG, but the holder structure alone is enough to treat this as exit-liquidity risk.\"" +
  "\n\n" +
  "[CAUTION, score 825, top1 11%]\n" +
  "\"Fartcoin lands on CAUTION because a single wallet holds 11% of supply \u2014 a meaningful concentration risk even with otherwise solid fundamentals.\n\n" +
  "LP is fully burned, mint and freeze authorities are revoked, no honeypot, and the token has 30d+ of trading history.\n\n" +
  "The verdict is not DANGER because the rest of the structural posture is clean; it is not SAFE because the concentrated wallet alone has enough leverage to swing the price.\"" +
  "\n\n" +
  "[SAFE, score 880, sources cross-validated]\n" +
  "\"PENGU shows a SAFE profile with locked liquidity and 30d+ established trading on Solana.\n\n" +
  "Helius source temporarily unavailable lowers confidence to 80% but RugCheck and GoPlus cross-validate the safe verdict.\n\n" +
  "Strong holder distribution.\"" +
  "\n\n" +
  "RULES: " +
  "\u2022 Always use the actual numbers from the data (holders, percentages, liquidity, age in days). " +
  "\u2022 Reference sources by name when relevant (\"RugCheck and GoPlus cross-validate\", \"Helius source unavailable\"). " +
  "\u2022 Never use markdown, emojis, bullet points, headers, or phrases like \"Based on the data\". " +
  "\u2022 Always 3 paragraphs separated by a blank line. If data is genuinely thin, 2 paragraphs is acceptable but never 1. " +
  "\u2022 Output ONLY the paragraphs."

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
        // max_tokens bumped 600 → 850 to fit the 3-paragraph
        // narrative format. The previous 600-token ceiling worked
        // when the prompt asked for "2 to 4 sentences max"; now that
        // we ask for 3 short paragraphs (5–9 sentences total) plus
        // weave both the critical flags AND the bonus status into
        // the response, we need room. 850 gives ~600 words of output
        // headroom which is comfortable for the demo-quality
        // narrative without bloating per-call cost. Mid-sentence
        // truncation regression is extremely unlikely at this size.
        max_tokens: 850,
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
