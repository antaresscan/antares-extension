export type AISummaryInput = {
  score: number
  risk: string
  flags: string[]
  tokenSymbol: string | null
  holders: number | null
  marketCap: number | null
  liquidity: number | null
  lpBurned: boolean | null
  mintAuthority: boolean | null
  freezeAuthority: boolean | null
  honeypot: boolean | null
  tokenAgeHours: number | null
  sourcesUsed: string[]
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
const MAX_FLAGS = 8
const TIMEOUT_MS = 6000
const RETRY_DELAY_MS = 1200
const MIN_LENGTH = 20
const MAX_LENGTH = 1200

const FLAG_LABELS: Record<string, string> = {
  "mint_authority_enabled": "Mint authority is enabled",
  "freeze_authority_enabled": "Freeze authority is enabled",
  "honeypot_detected": "Honeypot detected — cannot sell",
  "lp_not_burned": "LP not burned or locked",
  "low_holders": "Low holder count",
  "top_holder_concentration": "Top holder concentration is high",
  "copycat_token": "Copycat token detected",
  "rug_pattern": "Rug pull pattern detected",
  "wash_trading": "Wash trading detected",
  "bundle_activity": "Bundle activity detected",
  "sniper_activity": "Sniper activity detected",
  "pump_and_dump": "Pump and dump pattern",
  "low_liquidity": "Low liquidity",
  "very_new_token": "Very new token",
  "cannot_sell": "Cannot sell all tokens",
  "blacklisted": "Token is blacklisted",
  "hidden_owner": "Hidden owner detected",
  "proxy_contract": "Proxy contract detected",
  "is_open_source": "Contract is not open source",
  "is_proxy": "Contract uses proxy pattern",
  "is_mintable": "Token is mintable",
  "can_take_back_ownership": "Ownership can be reclaimed",
  "owner_change_balance": "Owner can change balances",
  "selfdestruct": "Contract has selfdestruct",
  "external_call": "Contract makes external calls",
  "transfer_pausable": "Transfers can be paused",
  "trading_cooldown": "Trading cooldown enabled",
  "anti_whale_modifiable": "Anti-whale rules are modifiable",
  "is_anti_whale": "Anti-whale mechanism active",
  "is_whitelisted": "Whitelist restriction active",
  "is_blacklisted": "Blacklist mechanism detected",
  "slippage_modifiable": "Slippage/tax is modifiable",
  "personal_slippage_modifiable": "Per-address tax modifiable",
  "mutable_metadata": "Token metadata is mutable",
  "high_ownership_concentration": "High ownership concentration",
  "low_community_trust": "Low community trust score",
  "suspicious_deployer": "Deployer has suspicious history",
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  bonus: 2,
  info: 3,
}

const SYSTEM_PROMPT =
  "You are a crypto risk analyst explaining a Solana token scan to a retail user in plain English. " +
  "Your job is NOT to repeat the verdict — the user already sees SAFE / DANGER / RUG PULL on screen. " +
  "Your job is to explain WHY: pick the 1 or 2 most important flags from the data and describe " +
  "the exact mechanism of danger in concrete terms. " +
  "Examples of good explanations: " +
  "'Bundle activity means a group of coordinated wallets bought together at launch to inflate the price — " +
  "they now hold a large share and can dump simultaneously, crashing the price instantly.' " +
  "'Wash trading means the volume you see is fake — bots are trading with themselves to create the " +
  "illusion of demand. Real buyers are scarce, and the price can collapse once the bots stop.' " +
  "'LP not locked means the developer can remove all liquidity in one transaction — when that happens, " +
  "the token price drops to zero and nobody can sell.' " +
  "Rules: " +
  "- Start directly with the flag name or the danger, never with 'This token is' or 'Based on the data'. " +
  "- Write 2 to 4 sentences max. " +
  "- Be specific: use numbers from the data when available (e.g. score, liquidity, holders). " +
  "- If the token is SAFE, explain what passed (LP burned, clean holders, good score) in the same concrete style. " +
  "- Never use markdown, emojis, bullet points, or generic disclaimers. Output only the sentences."

/**
 * Single Gemini call. Returns:
 *   - the summary string on success
 *   - "__RETRY__" if the error is recoverable (429 rate-limit or AbortError timeout)
 *   - null for all other errors (network failure, 5xx, bad payload, etc.)
 */
async function callGemini(
  apiKey: string,
  model: string,
  context: object,
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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    // 429 = rate-limit → recoverable
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
    // Only retry on AbortError (our own timeout signal) — not on network errors
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

  const topFlags = input.flags
    .slice()
    .sort((a: string, b: string) => {
      const aLower = a.toLowerCase()
      const bLower = b.toLowerCase()
      const aScore = aLower.includes("critical") ? SEVERITY_ORDER.critical
        : aLower.includes("warning") ? SEVERITY_ORDER.warning
        : aLower.includes("bonus") ? SEVERITY_ORDER.bonus
        : SEVERITY_ORDER.info
      const bScore = bLower.includes("critical") ? SEVERITY_ORDER.critical
        : bLower.includes("warning") ? SEVERITY_ORDER.warning
        : bLower.includes("bonus") ? SEVERITY_ORDER.bonus
        : SEVERITY_ORDER.info
      return aScore - bScore
    })
    .slice(0, MAX_FLAGS)
    .map((f: string) => FLAG_LABELS[f] || f)

  const context = {
    score: input.score,
    risk: input.risk,
    tokenSymbol: input.tokenSymbol,
    holders: input.holders,
    marketCap: input.marketCap,
    liquidity: input.liquidity,
    lpBurned: input.lpBurned,
    mintAuthority: input.mintAuthority,
    freezeAuthority: input.freezeAuthority,
    honeypot: input.honeypot,
    tokenAgeHours: input.tokenAgeHours,
    flags: topFlags,
    sourcesUsed: input.sourcesUsed,
  }

  // Attempt 1: primary model
  let result = await callGemini(apiKey, primaryModel, context)

  // Retry once on recoverable error (429 or timeout), then try fallback
  if (result === "__RETRY__") {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    result = await callGemini(apiKey, primaryModel, context)
  }

  // If still failing, switch to fallback model
  if (result === "__RETRY__" || result === null) {
    result = await callGemini(apiKey, fallbackModel, context)
  }

  // Last chance: retry fallback on recoverable error
  if (result === "__RETRY__") {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    result = await callGemini(apiKey, fallbackModel, context)
  }

  if (result === "__RETRY__") return null
  return result
}
