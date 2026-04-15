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
const TIMEOUT_MS = 8000
const MIN_LENGTH = 20
const MAX_LENGTH = 800

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
  "You are a concise crypto risk analyst explaining a Solana token scan result to a retail user. " +
  "Write 2 to 4 plain-text sentences explaining whether this token looks safe or dangerous and why, " +
  "based strictly on the data provided. Be direct and specific: mention the actual flags, score, and " +
  "key on-chain facts. If the token is dangerous, say clearly why. If it looks safe, say why it passed. " +
  "Never use markdown, emojis, bullet points, or generic disclaimers. Output only the sentences."

export async function generateAISummary(
  input: AISummaryInput
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey === "") return null

  const model = process.env.AI_MODEL || "gemini-2.5-flash"

  // Include ALL flags sorted by severity (no restrictive keyword filter)
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
        max_tokens: 200,
        temperature: 0.35,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)
    if (!response.ok) return null

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }

    const msg = data?.choices?.[0]?.message?.content?.trim()
    if (typeof msg !== "string") return null
    if (msg.length < MIN_LENGTH) return null
    if (msg.length > MAX_LENGTH) return msg.slice(0, MAX_LENGTH).replace(/\s+\S*$/, "") + "."
    return msg
  } catch {
    clearTimeout(timeout)
    return null
  }
}
