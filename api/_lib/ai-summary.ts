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

const OPENAI_URL = "https://api.openai.com/v1/chat/completions"
const MAX_FLAGS = 5
const TIMEOUT_MS = 5000
const MIN_LENGTH = 20
const MAX_LENGTH = 600

const FLAG_LABELS: Record<string, string> = {
  "mint_authority_enabled": "Mint authority is enabled",
  "freeze_authority_enabled": "Freeze authority is enabled",
  "honeypot_detected": "Honeypot detected",
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
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
}

const SYSTEM_PROMPT =
  "You are a terse, factual crypto risk analyst. " +
  "Summarize only the facts given to you. Never invent or infer. " +
  "Never use markdown, emojis, bullet points, or disclaimers. " +
  "Output exactly 2 to 3 complete plain-text sentences. Nothing more."

export async function generateAISummary(
  input: AISummaryInput
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || apiKey === "") return null

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini"

  const topFlags = input.flags
    .filter((f: string) => {
      const lower = f.toLowerCase()
      return lower.includes("critical") || lower.includes("warning")
    })
    .sort((a: string, b: string) => {
      const aScore = a.toLowerCase().includes("critical") ? SEVERITY_ORDER.critical : SEVERITY_ORDER.warning
      const bScore = b.toLowerCase().includes("critical") ? SEVERITY_ORDER.critical : SEVERITY_ORDER.warning
      return aScore - bScore
    })
    .slice(0, MAX_FLAGS)
    .map((f: string) => FLAG_LABELS[f] || f)

  const context = {
    score: input.score,
    risk: input.risk,
    tokenSymbol: input.tokenSymbol,
    holders: input.holders,
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
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 150,
        temperature: 0.3,
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
    if (msg.length > MAX_LENGTH) return null

    return msg
  } catch {
    clearTimeout(timeout)
    return null
  }
}
