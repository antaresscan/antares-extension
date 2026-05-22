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
// MAX_FLAGS bumped 8→12 so a stacked rug (10+ flags) doesn't silently
// drop the tail-end critical flags before they ever reach the prompt.
// Completeness > brevity per the founder's call: it's better to have
// a slightly longer summary than to omit a real risk signal.
const MAX_FLAGS = 12
const TIMEOUT_MS = 8000
const MIN_LENGTH = 20
// Bumped to 2600 to cover the high-flag tier headroom (target up to
// ~180 words, can land at ~2200 chars after expansion). 2600 gives
// margin for the rare 10+ critical flag scan without truncating
// mid-sentence.
const MAX_LENGTH = 2600
const MAX_RETRIES = 2
const RETRY_DELAYS = [1500, 3000]

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  bonus: 2,
  info: 3,
}

/**
 * Word-count target band scaled to the SIGNIFICANT-flag count
 * (critical + warning, ignoring bonus/info noise).
 *
 * Earlier versions counted only critical flags, which silently
 * de-prioritised warning flags. A real production CA (GIGARAT,
 * 2026-05-08) had 0 critical + 4 warning flags and got a 70-word
 * summary that only mentioned 1 of the 4 — exactly the failure mode
 * we're trying to prevent. The user already sees no severity
 * distinction in the flags panel; the summary needs to mirror that.
 *
 * Bands (`s` = significant flags = critical + warning):
 *   0–2 → 45–75 words  (lean SAFE / single-flag CAUTION)
 *   3–4 → 70–110 words (DANGER with stacking issues — GIGARAT case)
 *   5–7 → 95–145 words (heavy DANGER/RUG with full enumeration)
 *   8+  → 110–180 words (extreme stacked rug — never drop a flag)
 *
 * Paragraph 2 of the prompt is then required to enumerate EVERY
 * significant flag with a one-clause reason, so the user never sees
 * "the AI explained 1 of 7 flags".
 *
 * Completeness is the founder's stated priority: better a slightly
 * longer block than a silently dropped risk signal.
 */
function computeWordTarget(significantFlagCount: number): { min: number; max: number } {
  if (significantFlagCount >= 8) return { min: 110, max: 180 }
  if (significantFlagCount >= 5) return { min: 95, max: 145 }
  if (significantFlagCount >= 3) return { min: 70, max: 110 }
  return { min: 45, max: 75 }
}

// Removed: FLAG_EXPLANATIONS dictionary + getFlagExplanation helper.
// They were used by the old fallback to look up canned per-flag
// explanations. The new buildStructuredFallback no longer needs them
// — it picks the dominant cause-of-verdict from the input and writes
// the entire 3-paragraph narrative deterministically.

/**
 * Build a structured explanation prompt from the scan data.
 */
function buildUserPrompt(
  input: AISummaryInput,
  topFlags: Array<{ label: string; severity: string; impact: number }>,
  target: { min: number; max: number },
): string {
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

  // Significant = critical + warning. Info-level signals (e.g. the
  // 2-axis LP matrix's "LP holds X% of supply — limited rug impact"
  // bucket) ARE discussed too — credibility rule per founder feedback:
  // "même si un token est safe je dois voir tous les flags identifiés
  // dans critical flags et tout doit être expliqué dans le ai summary".
  // Hiding info flags created the "no issues found / CAUTION" UX
  // contradiction. Bonus signals (LP burned ✓ etc.) are now also
  // surfaced so the verdict reasoning reads complete.
  const significantFlags = topFlags.filter(
    (f) => f.severity === "critical" || f.severity === "warning",
  )
  const infoFlags = topFlags.filter((f) => f.severity === "info")
  const bonusFlags = topFlags.filter((f) => f.severity === "bonus")
  if (topFlags.length > 0) {
    lines.push("")
    lines.push("Detected flags (AUTHORITATIVE — discuss ONLY these as risks/context; the Metrics line above is for adding numbers to flags that DID fire, never for inventing new risks):")
    for (const f of topFlags) {
      lines.push(`- [${f.severity}] ${f.label} (impact: ${f.impact})`)
    }
  } else {
    lines.push("")
    lines.push("No flags raised — verdict is driven by the positive signals above. Do NOT introduce risks from raw metric values; the engine has decided nothing is flag-worthy.")
  }

  lines.push("")
  // Embed the per-scan length target + the explicit enumeration
  // requirement directly in the user message. Keeping it in the user
  // prompt (rather than the system prompt alone) reinforces both
  // constraints right next to the flag list, which empirically
  // produces tighter compliance from Gemini than relying on the
  // system prompt only.
  //
  // SAFE-verdict tokens with info-level flags (e.g. LP unverified but
  // small % of supply) MUST get an explicit explanation of why the
  // flag doesn't downgrade the verdict — otherwise the user sees a
  // ✗ in the indicator grid and a SAFE pill and loses trust.
  const enumParts: string[] = []
  if (significantFlags.length >= 3) {
    enumParts.push(
      `Paragraph 2 MUST enumerate ALL ${significantFlags.length} critical/warning flags with one short clause each — do NOT skip any.`,
    )
  } else if (significantFlags.length > 0) {
    enumParts.push("Paragraph 2 weaves the warning flags concisely.")
  }
  if (infoFlags.length > 0) {
    enumParts.push(
      `Paragraph 2 ALSO addresses the ${infoFlags.length} info-level signal(s) above — name each one and explain why it does not downgrade the verdict (typically: small LP %, mature token, CEX-dominated liquidity). Skipping these creates a credibility gap when the user sees them in the Critical Flags panel.`,
    )
  }
  if (bonusFlags.length > 0) {
    enumParts.push(
      `Paragraph 3 references the ${bonusFlags.length} positive signal(s) as part of the closer.`,
    )
  }
  if (enumParts.length === 0) {
    enumParts.push("Paragraph 2 weaves the flags and bonus signals — keep it tight.")
  }
  const enumInstruction = enumParts.join(" ")

  lines.push(
    `Write the 3-paragraph AI Verdict block. TOTAL length ${target.min}-${target.max} words. ` +
      "Paragraph 1 = verdict reason with concrete numbers (≤25 words). " +
      `Paragraph 2 = counter-context. ${enumInstruction} ` +
      "Paragraph 3 = boundary case (why this verdict, not the adjacent one) for CAUTION/DANGER, action statement for RUG, brief confirming closer for SAFE.",
  )
  return lines.join("\n")
}

// Strict-format prompt v4. Earlier v3 locked the cap at 45-75 words
// regardless of how many flags fired, which produced "the AI named 1
// of 7 critical flags" outputs that erode user trust. v4 takes a
// dynamic word band (computed by computeWordTarget) and a flag-
// enumeration requirement on paragraph 2.
//
// The four /demo summaries (HAWK/PIPPIN/FARTCOIN/PENGU) remain the
// canonical low-flag references \u2014 they still sit in the 45-75 band.
// Higher-flag tokens get more room to enumerate without the model
// padding the easy cases.
function buildSystemPrompt(target: { min: number; max: number }): string {
  return (
  "You are writing the AI Verdict block of an Antares Solana token scan overlay. " +
  "The user already sees the verdict pill (SAFE / CAUTION / DANGER / RUG PULL), the score (X / 1000) and a list of detected flags. " +
  "Your block goes underneath. " +
  "\n\n" +
  "STRICT FORMAT \u2014 every output MUST follow this exactly: " +
  "\n" +
  "\u2022 EXACTLY 3 paragraphs separated by a single blank line. Never 1, never 2, never 4. " +
  `\u2022 TOTAL length ${target.min} to ${target.max} words. Never less than ${target.min}, never more than ${target.max}. ` +
  "\u2022 Plain text only. No markdown, no emoji, no bullets, no headers. " +
  "\n\n" +
  "FLAG FIDELITY \u2014 the 'Detected flags' list in the user message is the AUTHORITATIVE source of negative findings. " +
  "The 'Metrics' line shows raw values for context (so you can quote concrete numbers when explaining a flag that already fired) and the 'Status' line shows positive/negative structural state. " +
  "But a number being present in Metrics does NOT mean it is a flagged risk. " +
  "If 'top holder owns 8.1% of supply' appears in Metrics but NO concentration flag is in the Detected flags list, you MUST NOT call it a concentration risk \u2014 the engine already decided 8.1% is within tolerance for this token. " +
  "Same rule for any other metric: holder count, liquidity, age, volume. " +
  "Use Metrics to add concrete numbers to flags that DID fire, never to invent new ones. " +
  "If the flag list is short or empty, your paragraphs 1\u20132 must mirror that \u2014 lead with the single dominant flag (or the verdict reason itself if no flags fired) and use the rest of the data as positive counter-context, not as additional risk. " +
  "\n\n" +
  "PARAGRAPH 1 \u2014 VERDICT REASON (exactly 1 sentence, \u226425 words). " +
  "Open with the token name. State the verdict and the dominant mechanism with one concrete number. " +
  "\n\n" +
  "PRIORITY when picking the dominant mechanism (highest first):" +
  "\n" +
  "1. Honeypot \u2014 total loss on entry, no recovery." +
  "\n" +
  "2. Bundle / coordinated wallets \u2014 Antares's signature flag. INVISIBLE concentration via multiple addresses controlled by a single entity. " +
  "More dangerous than visible top-holder concentration because the user has no surface cue (Helius shows healthy distribution). " +
  "If the data shows a Bundle / Bundler / coordinated-wallet flag, lead with it." +
  "\n" +
  "3. Visible top-1 wallet concentration (\u226510% of supply)." +
  "\n" +
  "4. LP not locked or burned." +
  "\n" +
  "5. Mint or freeze authority enabled." +
  "\n" +
  "6. Other dominant flag (whatever is the top-severity item)." +
  "\n\n" +
  "Templates per verdict: " +
  "\u2022 RUG (bundle): \"{Symbol} is a bundle rug \u2014 coordinated wallets hold ~X% of supply across multiple addresses, invisible to top-holder metrics but acting as a single seller.\" " +
  "\u2022 RUG (concentration): \"{Symbol} is the textbook concentration rug \u2014 a single wallet holds X% of total supply, \u2026\" " +
  "\u2022 RUG (honeypot): \"{Symbol} is a honeypot \u2014 once you buy, the contract blocks every sell, trapping your funds permanently.\" " +
  "\u2022 DANGER (bundle): \"{Symbol} lands on DANGER because of bundle activity \u2014 coordinated wallets hold ~X% of supply, masking concentration that visible top-holder metrics don't catch.\" " +
  "\u2022 DANGER (other): \"{Symbol} lands on DANGER because {mechanism with numbers}.\" " +
  "\u2022 CAUTION (bundle): \"{Symbol} lands on CAUTION because of bundle activity \u2014 coordinated wallets hold ~X% of supply, invisible to standard concentration metrics even with otherwise solid fundamentals.\" " +
  "\u2022 CAUTION (other): \"{Symbol} lands on CAUTION because {mechanism with numbers} \u2014 a meaningful risk even with otherwise solid fundamentals.\" " +
  "\u2022 SAFE: \"{Symbol} shows a SAFE profile with {primary positive signal}.\" " +
  "\n\n" +
  "PARAGRAPH 2 \u2014 COUNTER-CONTEXT + FULL FLAG INVENTORY. " +
  "List BOTH positive signals (LP burned, mint/freeze renounced, no honeypot, 30d+ trading) AND every remaining flag (critical AND warning \u2014 the user sees both colours and expects them named). " +
  "If 3+ flags fired in total (critical + warning), paragraph 2 MUST name each one with a one-clause reason \u2014 e.g. \u201cBundle holds 37%, top-10 hold 78%, deceptive name, wash trading, single wallet 14%, high vol/liquidity ratio\u201d. " +
  "Do NOT skip flags: a user already sees the full flag list above your block, and explaining only one when many fired reads as incomplete. " +
  "Treat warnings with the same enumeration discipline as criticals \u2014 a 4-warning DANGER token must name all 4. " +
  "For RUG / DANGER: state whether positives save the verdict or get overridden. " +
  "For SAFE / CAUTION: list positives matter-of-factly; reference sources by name when they cross-validate. " +
  "\n\n" +
  "PARAGRAPH 3 \u2014 BOUNDARY OR ACTION (1 or 2 sentences, \u226420 words). " +
  "\u2022 RUG: trader action only. \"Hard kill. Treat any remaining liquidity as exit-only.\" or similar. " +
  "\u2022 DANGER: \"The verdict is not RUG because {what's clean}, but {dominant flag} alone is enough to treat this as exit-liquidity risk.\" " +
  "\u2022 CAUTION: \"The verdict is not DANGER because the rest is clean; it is not SAFE because {flag} alone has enough leverage.\" " +
  "\u2022 SAFE: brief confirming closer. \"Strong holder distribution.\" or \"Cross-validates across the 7 layers.\" " +
  "\n\n" +
  "REFERENCE OUTPUTS (copy structure and tone \u2014 these are the target. Lengths scale with flag count):" +
  "\n\n" +
  "[RUG \u00b7 105/1000 \u00b7 single wallet 44%, 1 critical flag]\n" +
  "Hawk Tuah is the textbook concentration rug \u2014 a single wallet holds 44% of total supply, more than enough to crash the price to zero in one transaction.\n\n" +
  "LP is technically burned and the token has 30d+ of trading history, but those signals are completely overridden by the wallet concentration.\n\n" +
  "Hard kill. Treat any remaining liquidity as exit-only." +
  "\n\n" +
  "[RUG \u00b7 60/1000 \u00b7 6 critical flags] (note the longer paragraph 2 enumerating each flag)\n" +
  "TROLLV2 is a stacked rug \u2014 a single wallet holds 38% of supply with the top 10 controlling 91%, more than enough to dump in one transaction.\n\n" +
  "LP is unlocked, the contract retains both mint and freeze authority, the metadata is mutable, the project lists no socials, and the engine flags a deceptive name copying an established meme \u2014 every structural surface is compromised.\n\n" +
  "Hard kill. Any remaining liquidity is exit-only." +
  "\n\n" +
  "[DANGER \u00b7 525/1000 \u00b7 top1 27%, top10 67%]\n" +
  "Pippin lands on DANGER because of stacked concentration risk \u2014 a single wallet holds 27% of supply and the top 10 wallets together control 67%.\n\n" +
  "The LP is burned and the contract is clean (no mint, no freeze, no honeypot), which keeps the verdict from collapsing all the way to RUG.\n\n" +
  "But the holder structure alone is enough to treat this as exit-liquidity risk." +
  "\n\n" +
  "[CAUTION \u00b7 825/1000 \u00b7 top1 11%]\n" +
  "Fartcoin lands on CAUTION because a single wallet holds 11% of supply \u2014 a meaningful concentration risk even with otherwise solid fundamentals.\n\n" +
  "LP is fully burned, mint and freeze authorities are revoked, no honeypot, and the token has 30d+ of trading history.\n\n" +
  "The verdict is not DANGER because the rest is clean; it is not SAFE because the concentrated wallet alone has enough leverage to swing the price." +
  "\n\n" +
  "[SAFE \u00b7 880/1000 \u00b7 sources cross-validated]\n" +
  "PENGU shows a SAFE profile with locked liquidity and 30d+ established trading on Solana.\n\n" +
  "RugCheck and GoPlus cross-validate the safe verdict; Helius temporarily unavailable lowers confidence to 80%.\n\n" +
  "Strong holder distribution." +
  "\n\n" +
  "Output ONLY the 3 paragraphs. Do not include the verdict tag or score in your output. Do not add quotation marks. Do not preface."
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Single Gemini call. Returns:
 * - the summary string on success
 * - "__RETRY__" if the error is recoverable (429 or timeout)
 * - null for all other errors
 *
 * `target` is the per-scan word budget (computed by computeWordTarget).
 * The validator uses a wider tolerance band around it (target.min - 20
 * down to a hard floor of 25, and target.max + 25) so a slightly
 * over/under output isn't rejected — but a wall-of-text or two-word
 * regression still gets caught.
 */
async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  target: { min: number; max: number },
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
        // max_tokens 850 → 400. Earlier 850 was a safety margin for
        // a "5–9 sentences" instruction that turned out to encourage
        // wall-of-text outputs. The new strict 45–75 word format
        // never needs more than ~110 tokens — 400 gives a 3.5×
        // safety margin against mid-word truncation while making
        // it physically harder for Gemini to over-produce.
        max_tokens: 400,
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

    // Enforce the 3-paragraph 45–75 word contract that the prompt
    // declares. Gemini is good but not deterministic; ~10% of outputs
    // come back as a single dense paragraph or a 2-paragraph short
    // version. When that happens we'd rather use the deterministic
    // local fallback (which always honors the format) than ship the
    // off-format Gemini reply. Returning null here makes the caller
    // fall through to the local builder.
    const cleaned = msg.replace(/^\s+|\s+$/g, "")
    const paragraphs = cleaned.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    const wordCount = cleaned.split(/\s+/).filter((w) => w.length > 0).length
    if (paragraphs.length !== 3) {
      logger.warn("ai-summary", "Gemini output rejected — wrong paragraph count", {
        paragraphs: paragraphs.length,
        wordCount,
      })
      return null
    }
    // Tolerance band keyed off the dynamic target. Lower floor
    // is hard-set at 25 — the canonical PENGU /demo summary is ~30
    // words because there is genuinely little to say when nothing
    // is wrong. Upper bound is target.max + 25 to leave slack for a
    // model that runs slightly over on dense scans, while still
    // catching wall-of-text regressions.
    const acceptMin = Math.max(25, target.min - 20)
    const acceptMax = target.max + 25
    if (wordCount < acceptMin || wordCount > acceptMax) {
      logger.warn("ai-summary", "Gemini output rejected — word count out of band", {
        wordCount,
        target: `${target.min}-${target.max} typical, ${acceptMin}-${acceptMax} hard limits`,
      })
      return null
    }
    return cleaned
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
 * Build the deterministic 3-paragraph structured fallback. Always
 * returns a string — never null — so the user is guaranteed a
 * summary even when Gemini is rate-limited, times out, or returns
 * off-format output. The shape mirrors the four canonical /demo
 * summaries (HAWK / PIPPIN / FARTCOIN / PENGU) so production output
 * stays visually consistent regardless of the source.
 *
 * Format: 3 paragraphs, blank-line separated, 45–75 words total.
 *  • PARA 1: verdict reason with concrete numbers (≤25 words)
 *  • PARA 2: counter-context — positives + whether they save the verdict
 *  • PARA 3: boundary case (DANGER / CAUTION) or trader action (RUG) or brief closer (SAFE)
 */
function buildStructuredFallback(
  input: AISummaryInput,
  topFlags: Array<{ label: string; severity: string; impact: number }>,
): string {
  const sym = input.tokenSymbol || "This token"
  const top1 = input.topHolderPct
  const lpProtected = input.lpBurned === true || input.lpLocked === true
  const lpVerb = input.lpBurned === true ? "burned" : input.lpLocked === true ? "locked" : null
  const mintRen = input.mintAuthority === false
  const freezeRen = input.freezeAuthority === false
  const noHoneypot = input.honeypot === false
  const ageDays = input.tokenAgeHours !== null ? input.tokenAgeHours / 24 : null
  const mature30d = ageDays !== null && ageDays >= 30
  const verdict = (input.risk || "").toUpperCase()

  // Collect short labels of positive structural signals so the
  // counter-context paragraph reads like the demo: "LP is fully
  // burned, mint and freeze authorities are revoked, no honeypot,
  // and the token has 30d+ of trading history."
  const positives: string[] = []
  if (lpVerb) positives.push(`LP is ${lpVerb}`)
  if (mintRen && freezeRen) positives.push("mint and freeze authorities are revoked")
  else if (mintRen) positives.push("mint authority is revoked")
  else if (freezeRen) positives.push("freeze authority is revoked")
  if (noHoneypot) positives.push("no honeypot")
  if (mature30d) positives.push("30d+ trading history")

  // Pick the dominant flag label for use in the boundary paragraph.
  // Falls back to a generic "the dominant signal" if no flag is
  // present (rare — usually only on SAFE).
  const dominantFlag = topFlags.length > 0 ? topFlags[0].label.toLowerCase() : null

  // Detect bundle / coordinated-wallet activity. This is Antares's
  // signature edge over RugCheck and visible-concentration scanners:
  // a single entity holding the supply across multiple wallets is
  // INVISIBLE to top-N holder metrics, but acts as a single seller
  // when the dump fires. The /scan code emits labels like:
  //   "Bundle holds ~37% of supply — coordinated buy/dump"
  //   "Bundle detected (~22% of supply)"
  //   "Bundle activity detected (RugCheck)"
  //   "Bundler detected (RugCheck summary)"
  //   "Wash trading detected (vol/liq > 20) — bundler dump"
  //   "Buy/sell imbalance (coordinated pump)"
  //   "Coordinated pump pattern"
  // The /bundl|coordinated/i regex catches all of these.
  const bundleFlag = topFlags.find((f) => /bundl|coordinated/i.test(f.label))
  // Try to extract the bundled-supply percentage if the flag has one.
  const bundlePctMatch = bundleFlag ? bundleFlag.label.match(/~?(\d+(?:\.\d+)?)\s*%/) : null
  const bundlePct = bundlePctMatch ? bundlePctMatch[1] : null

  // Did the scoring engine actually flag concentration? Without this
  // gate the fallback would invent a "single wallet holds X% — concentration
  // risk" narrative purely off the raw top-holder metric, even when the
  // engine concluded the holding was within tolerance and emitted no
  // concentration flag (CHILLHOUSE bug: top1=8.1% with only an LP flag
  // produced a concentration narrative that didn't match the displayed
  // flag list). The flag list is the authoritative source of risks; the
  // metric is only allowed to anchor para1 when there IS a flag for it.
  const concentrationFlag = topFlags.find((f) =>
    /single wallet|top\s*holder|top\s*1[^0]|top\s*10|holder concentration|concentration/i.test(f.label),
  )
  // Did the engine flag the LP? Same fidelity rule for the LP-anchored
  // RUG / DANGER branches — we only narrate "liquidity unlocked" or
  // "exit-scam pattern" when an LP flag is actually in the list.
  const lpFlag = topFlags.find((f) => /\blp\b|liquidity|locked|burned/i.test(f.label))
  // Did the engine flag mint or freeze authority?
  const mintFlag = topFlags.find((f) => /mint authority/i.test(f.label))
  const freezeFlag = topFlags.find((f) => /freeze authority/i.test(f.label))

  // top1 is in PERCENTAGE form (0–100), as set by api/scan.ts:
  //   `(topAmt / totalSupplyUi) * 100`
  // i.e. a 44% wallet arrives as 44, not 0.44. All thresholds and
  // formatting below assume that convention.

  // ── PARA 1 ── verdict reason. Branch order matters — we pick the
  // dominant cause-of-verdict first, falling through to less
  // distinctive ones. Priority hierarchy:
  //   1. honeypot         — total loss on entry, no recovery
  //   2. bundle           — INVISIBLE concentration via coordinated wallets
  //                         (Antares's signature edge — what other scanners miss)
  //   3. concentration    — visible top1 holding (Helius shows it directly)
  //   4. LP not locked    — exit-scam surface
  //   5. mint authority   — dilution-rug surface
  //   6. generic          — fall-through to dominant flag label
  // Each branch below is gated on whether the engine actually flagged
  // the corresponding mechanism. The honeypot boolean is treated as a
  // flag-equivalent because it's a hard-coded contract property the
  // /scan code surfaces directly. All other narratives require a flag
  // in topFlags so we never invent a risk from raw metric values.
  let para1: string
  if (verdict === "RUG") {
    if (input.honeypot) {
      para1 = `${sym} is a honeypot — once you buy, the contract blocks every sell, trapping your funds permanently.`
    } else if (bundleFlag) {
      const pctClause = bundlePct ? `roughly ${bundlePct}% of supply` : "a meaningful share of supply"
      para1 = `${sym} is a bundle rug — coordinated wallets quietly hold ${pctClause} across multiple addresses, invisible to top-holder metrics but acting as a single coordinated seller.`
    } else if (concentrationFlag && top1 !== null && top1 >= 25) {
      para1 = `${sym} is the textbook concentration rug — a single wallet holds ${top1.toFixed(1)}% of total supply, more than enough to crash the price to zero in one transaction.`
    } else if (lpFlag && !lpProtected) {
      para1 = `${sym} is an exit-scam pattern — liquidity is unlocked and the dev can drain the entire pool in a single transaction.`
    } else if (mintFlag && input.mintAuthority === true) {
      para1 = `${sym} is a mint-authority rug — the dev can print unlimited new tokens and dilute holders to zero at will.`
    } else if (dominantFlag) {
      para1 = `${sym} lands on RUG because of ${dominantFlag} — multiple critical signals confirm the verdict.`
    } else {
      para1 = `${sym} lands on RUG with ${input.score}/1000 — multiple critical flags confirm the verdict.`
    }
  } else if (verdict === "DANGER") {
    if (bundleFlag) {
      const pctClause = bundlePct ? `roughly ${bundlePct}% of supply` : "a meaningful share of supply"
      para1 = `${sym} lands on DANGER because of bundle activity — coordinated wallets hold ${pctClause}, masking concentration that visible top-holder metrics don't catch.`
    } else if (concentrationFlag && top1 !== null && top1 >= 20) {
      para1 = `${sym} lands on DANGER because of stacked concentration risk — a single wallet holds ${top1.toFixed(1)}% of supply, enough to dictate price action on its own.`
    } else if (lpFlag && !lpProtected) {
      para1 = `${sym} lands on DANGER because liquidity is neither locked nor burned — the dev retains the option to drain the pool whenever they choose.`
    } else if ((mintFlag && input.mintAuthority === true) || (freezeFlag && input.freezeAuthority === true)) {
      const which = input.mintAuthority === true && input.freezeAuthority === true ? "mint and freeze" : input.mintAuthority === true ? "mint" : "freeze"
      para1 = `${sym} lands on DANGER because the contract retains ${which} authority — a structural risk that no holder activity can offset.`
    } else if (dominantFlag) {
      para1 = `${sym} lands on DANGER because of ${dominantFlag} — the engine sees enough structural risk to flag the token.`
    } else {
      para1 = `${sym} lands on DANGER with ${input.score}/1000 — multiple structural concerns aggregate to a high-risk verdict.`
    }
  } else if (verdict === "CAUTION") {
    if (bundleFlag) {
      const pctClause = bundlePct ? `roughly ${bundlePct}% of supply` : "a meaningful share of supply"
      para1 = `${sym} lands on CAUTION because of bundle activity — coordinated wallets hold ${pctClause}, invisible to standard concentration metrics even with otherwise solid fundamentals.`
    } else if (concentrationFlag && top1 !== null && top1 >= 8) {
      // Only narrate concentration when the engine actually flagged it.
      // Without this gate we would invent the FARTCOIN-style narrative
      // for any token with a top-1 ≥8% even when the only fired flag
      // was about LP/mint/freeze/socials/etc — exactly the CHILLHOUSE
      // bug (8.1% top1, 1 LP flag, but the AI summary led with concentration).
      para1 = `${sym} lands on CAUTION because a single wallet holds ${top1.toFixed(1)}% of supply — a meaningful concentration risk even with otherwise solid fundamentals.`
    } else if (dominantFlag) {
      para1 = `${sym} lands on CAUTION because of ${dominantFlag} — a meaningful risk even with otherwise solid fundamentals.`
    } else {
      para1 = `${sym} lands on CAUTION with ${input.score}/1000 — the engine sees one notable concern alongside an otherwise clean structure.`
    }
  } else {
    // SAFE
    const safeOpener = lpVerb ? `${lpVerb} liquidity` : "a clean contract"
    const ageOpener = mature30d ? " and 30d+ established trading on Solana" : ""
    para1 = `${sym} shows a SAFE profile with ${safeOpener}${ageOpener}.`
  }

  // ── PARA 2 ── counter-context.
  //
  // Enumerate EVERY significant flag (critical OR warning) with a
  // short clause so the user never sees "the AI named 1 of N flags".
  // The summarised list excludes whichever flag we already used to
  // anchor paragraph 1 (avoids redundancy on the dominant signal).
  // Earlier this branch only counted `severity === "critical"` and
  // missed warning-only tokens like GIGARAT (0 critical + 4 warning),
  // which got a single-flag summary. Now both severities qualify for
  // the enumeration trigger.
  const significantFlags = topFlags.filter(
    (f) => f.severity === "critical" || f.severity === "warning",
  )
  const dominantUsed = topFlags[0]?.label ?? ""
  // No slice cap here — significantFlags is already bounded by
  // MAX_FLAGS (12) on the upstream sort, and removing the dominant
  // leaves at most 11 to enumerate. Capping smaller would resurface
  // the "AI named only 1 of N flags" complaint this PR is fixing.
  const otherFlags = significantFlags
    .filter((f) => f.label !== dominantUsed)
    .map((f) => shortenFlagLabel(f.label))

  let para2: string
  if (verdict === "RUG") {
    if (significantFlags.length >= 3 && otherFlags.length > 0) {
      // Heavy-flag rug — enumerate the supporting flags.
      const cleanClause =
        positives.length > 0 ? `${capitalize(joinCommaList(positives))} are present, but ` : "There are no clean structural counter-signals; "
      para2 = `${cleanClause}the engine also flags ${joinCommaList(otherFlags)} — every structural surface that should protect a holder is compromised.`
    } else if (positives.length > 0) {
      para2 = `${capitalize(joinCommaList(positives))}, but those signals are completely overridden by the dominant flag — the dev (or whoever controls that wallet) can collapse the price at any moment.`
    } else {
      para2 = `No structural counter-signals to mitigate — the contract is compromised across multiple layers and there is no clean signal to weigh against the verdict.`
    }
  } else if (verdict === "DANGER") {
    if (significantFlags.length >= 3 && otherFlags.length > 0) {
      const cleanClause =
        positives.length >= 1 ? `${capitalize(joinCommaList(positives))}, which keeps the verdict short of RUG. The engine ` : "The engine "
      para2 = `${cleanClause}also flags ${joinCommaList(otherFlags)} — each one a meaningful risk on its own.`
    } else if (positives.length >= 2) {
      para2 = `${capitalize(joinCommaList(positives))} — the contract surface itself is clean, which is why the verdict does not collapse all the way to RUG.`
    } else if (positives.length === 1) {
      para2 = `${capitalize(positives[0])} — the only counter-signal that keeps the verdict from collapsing all the way to RUG.`
    } else {
      para2 = `No clean structural counter-signals to weigh against the dominant risk — the contract has nothing in its favor to soften the verdict.`
    }
  } else if (verdict === "CAUTION") {
    if (significantFlags.length >= 3 && otherFlags.length > 0) {
      const cleanClause =
        positives.length > 0 ? `${capitalize(joinCommaList(positives))}, but ` : "Beyond the primary concern, "
      para2 = `${cleanClause}the engine also flags ${joinCommaList(otherFlags)} — secondary concerns that compound the verdict.`
    } else if (positives.length > 0) {
      para2 = `${capitalize(joinCommaList(positives))} — the rest of the structural posture is clean.`
    } else {
      para2 = `The rest of the contract surface is clean and there are no other critical signals firing alongside the primary concern.`
    }
  } else {
    // SAFE
    const usedSources = input.sourcesUsed || []
    const present = new Set(usedSources.map((s) => s.toLowerCase()))
    const expected = ["dexscreener", "rugcheck", "goplus", "helius", "solscan"]
    const missing = expected.filter((s) => !present.has(s))
    const validators = expected.filter((s) => present.has(s)).slice(0, 2).map(prettySource)
    if (missing.length > 0 && validators.length >= 2) {
      para2 = `${validators.join(" and ")} cross-validate the safe verdict; ${prettySource(missing[0])} temporarily unavailable lowers confidence slightly.`
    } else if (validators.length >= 2) {
      para2 = `${validators.join(" and ")} cross-validate the safe verdict across independent layers.`
    } else if (positives.length >= 2) {
      para2 = `${capitalize(joinCommaList(positives))} — the structural surface lines up with what a healthy token looks like.`
    } else {
      para2 = `The contract surface and holder distribution both check out across the available scanning layers.`
    }
  }

  // ── PARA 3 ── boundary or action
  let para3: string
  if (verdict === "RUG") {
    para3 = "Hard kill. Treat any remaining liquidity as exit-only."
  } else if (verdict === "DANGER") {
    para3 = "But the holder structure alone is enough to treat this as exit-liquidity risk."
  } else if (verdict === "CAUTION") {
    para3 = "The verdict is not DANGER because the rest is clean; it is not SAFE because the dominant flag alone has enough leverage to swing the price."
  } else {
    para3 = positives.length >= 3 ? "Strong holder distribution." : "Cross-validates across the available scanning layers."
  }

  const summary = `${para1}\n\n${para2}\n\n${para3}`
  logger.info("ai-summary", "Structured fallback generated", { chars: summary.length, verdict })
  return summary
}

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1)
}

/**
 * Compact a verbose flag label into a clause that fits a comma-list.
 *
 * Examples:
 *   "Top 10 holders > 70%"                        → "top-10 hold >70%"
 *   "Single wallet holds 18% of supply"           → "single wallet 18%"
 *   "Mint Authority enabled (RugCheck)"           → "mint authority enabled"
 *   "LP not burned or locked"                     → "LP unlocked"
 *   "Honeypot detected — cannot sell"             → "honeypot"
 *   "Bundle holds ~37% of supply — coordinated…"  → "bundle holds ~37%"
 *   "No website / Twitter / Telegram"             → "no socials"
 *   "Metadata mutable"                            → "mutable metadata"
 *
 * Falls back to a lowercased version of the original label trimmed at
 * the first long-form separator (em dash, parenthesis) when no rule
 * matches. Output is always lowercased so the joined list reads like
 * a natural-language inventory.
 */
function shortenFlagLabel(label: string): string {
  const l = label.toLowerCase()
  if (/honeypot/.test(l)) return "honeypot"
  if (/lp not burned|lp not locked|lp open|liquidity (?:not|unlocked)/.test(l)) return "LP unlocked"
  if (/freeze authority/.test(l)) return "freeze authority enabled"
  if (/mint authority/.test(l)) return "mint authority enabled"
  const top10Match = l.match(/top\s*10[^%]*?(\d+(?:\.\d+)?)\s*%/)
  if (top10Match) return `top-10 hold ${top10Match[1]}%`
  const single = l.match(/single wallet[^%]*?(\d+(?:\.\d+)?)\s*%/)
  if (single) return `single wallet ${single[1]}%`
  const bundle = l.match(/bundl[ae]r?[^%]*?(\d+(?:\.\d+)?)\s*%/)
  if (bundle) return `bundle holds ~${bundle[1]}%`
  if (/bundl|coordinated/.test(l)) return "bundle activity"
  if (/wash/.test(l)) return "wash trading"
  if (/sniper/.test(l)) return "sniper activity"
  if (/deceptive name|impersonat/.test(l)) return "deceptive name"
  if (/metadata mutable/.test(l)) return "mutable metadata"
  if (/no website|no socials|no twitter|no telegram|missing socials/.test(l)) return "no socials"
  if (/hidden owner/.test(l)) return "hidden owner"
  if (/upgradeable|proxy/.test(l)) return "upgradeable contract"
  if (/blacklist/.test(l)) return "blacklist capability"
  if (/transfer pausable|transfer paused/.test(l)) return "transfer pausable"
  if (/sell tax|buy tax/.test(l)) return l.match(/(?:sell|buy)\s*tax\s*(\d+)?/)?.[0] || "tax flag"
  // Generic fallback: take the part before any separator and trim.
  const head = label.split(/[—(]/)[0].trim().toLowerCase()
  return head.length > 60 ? head.slice(0, 57) + "…" : head
}

function joinCommaList(items: string[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

function prettySource(slug: string): string {
  const map: Record<string, string> = {
    dexscreener: "DexScreener",
    rugcheck: "RugCheck",
    goplus: "GoPlus",
    helius: "Helius",
    solscan: "Solscan",
  }
  return map[slug.toLowerCase()] || slug
}

/**
 * Backwards-compatible wrapper. Old call sites (and tests) expect
 * `generateLocalFallback` to return `string | null`. The new
 * structured builder always succeeds, so this wrapper just forwards
 * its output. Kept as a separate function so callers do not need
 * to be touched.
 */
function generateLocalFallback(
  input: AISummaryInput,
  topFlags: Array<{ label: string; severity: string; impact: number }>,
): string | null {
  return buildStructuredFallback(input, topFlags)
}

export async function generateAISummary(
  input: AISummaryInput
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey === "") {
    logger.info("ai-summary", "No GEMINI_API_KEY found, using local fallback")
  }

  const primaryModel = process.env.AI_MODEL || "gemini-2.5-flash"

  // Sort flags by severity then impact. KEEP info AND bonus flags now —
  // founder feedback: SAFE verdicts that hide info-level signals (e.g. the
  // 2-axis LP matrix's "LP holds X% of supply — limited rug impact" bucket)
  // produce a credibility gap because the indicator grid shows ✗ on LP
  // but the summary doesn't explain why. The system prompt asks the AI to
  // address each info flag with the "why not a downgrade" reasoning.
  const topFlags = input.flags
    .slice()
    .sort((a, b) => {
      const aSev = SEVERITY_ORDER[a.severity] ?? 3
      const bSev = SEVERITY_ORDER[b.severity] ?? 3
      if (aSev !== bSev) return aSev - bSev
      return b.impact - a.impact
    })
    .slice(0, MAX_FLAGS)

  // Scale the word budget with the SIGNIFICANT-flag count (critical +
  // warning). Counting only criticals missed warning-only tokens like
  // GIGARAT (0 critical, 4 warning) — the summary then enumerated only
  // 1 of 4 flags. See computeWordTarget for the bands.
  const significantCount = topFlags.filter(
    (f) => f.severity === "critical" || f.severity === "warning",
  ).length
  const target = computeWordTarget(significantCount)
  const systemPrompt = buildSystemPrompt(target)
  const userPrompt = buildUserPrompt(input, topFlags, target)

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
        significantCount,
        targetWords: `${target.min}-${target.max}`,
      })
      const result = await callGemini(apiKey, primaryModel, systemPrompt, userPrompt, target)

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
