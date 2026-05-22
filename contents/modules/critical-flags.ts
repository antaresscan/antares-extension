import { state } from "./state"
import { closePanelAnimated } from "./panel-close"
import type { ScanResponseFlag } from "../../shared/types"

// ─── FLAG DESCRIPTIONS ────────────────────────────────────────────
// Plain-English descriptions for every common flag label. The Critical
// Flags panel surfaces ALL flags regardless of severity — credibility
// rule per founder feedback: "safe sans explications n'est pas crédible
// aux yeux des users". If LP shows ✗ in the indicator grid but verdict
// is SAFE, the user must be able to read in the panel WHY it's still
// safe (small LP % of supply, mature token, etc.). Hiding info-level
// flags created exactly that contradiction.
//
// Two lookup strategies:
//   1. Exact label → description (FLAG_DESCRIPTIONS map)
//   2. Regex match for parameterized labels like "LP holds X% of supply
//      — moderate rug capacity" (FLAG_PATTERNS) — these come from the
//      new 2-axis LP risk matrix (api/_lib/lp-risk-matrix.ts) and embed
//      the actual percentage value, so they can't be string-matched.
//
// Keep both copies in sync with js/token-app.js (the standalone analysis
// page has its own copy because it's plain JS, not a TS import).
const FLAG_DESCRIPTIONS: Record<string, string> = {
  // ── critical ──
  "Mint Authority enabled": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Mint Authority enabled (RugCheck)": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Freeze Authority enabled": "The dev can freeze your wallet and prevent you from selling.",
  "Freeze Authority enabled (RugCheck)": "The dev can freeze your wallet and prevent you from selling.",
  "Honeypot detected — cannot sell": "You cannot sell this token. Any funds spent are gone.",
  "Bundle activity detected": "Coordinated wallets bought together to fake demand — classic pump and dump setup.",
  "Bundle holds": "A coordinated group controls a large portion of supply and can dump at will.",
  "Sniper activity detected": "Bots bought massively at launch before anyone else could — supply is concentrated.",
  "Top 10 holders > 70%": "Ten wallets control over 70% of the supply. If they sell together, the price collapses.",
  "Top 10 holders > 50%": "Half the supply is in 10 wallets — high dump risk.",
  "Single wallet holds": "One wallet controls a huge portion of supply and can crash the price alone.",
  "Wash trading detected": "The trading volume is fake — bots trading with themselves to create false activity.",
  "Sell tax": "A hidden fee is taken every time you sell — often used to bleed holders slowly.",
  "Buy tax": "A fee is taken on every purchase — used to fund the dev or prevent exits.",
  "Owner holds > 5%": "The owner wallet holds a large stake and can dump it at any time.",
  "Creator holds > 5%": "The creator wallet holds a large stake and can dump it at any time.",
  "Blacklist capability": "The dev can blacklist specific wallets and prevent them from selling.",
  "Transfer pausable": "The dev can pause all transfers, trapping everyone's funds.",
  "Hidden owner": "The real owner of the contract is hidden — a known red flag for rug pulls.",
  "Upgradeable/proxy contract": "The contract code can be replaced after launch — any security audit becomes worthless.",
  "Metadata mutable": "The dev can change the token name, symbol and logo after launch — common in rug setups.",
  "No website / Twitter / Telegram": "Zero social presence — the team can disappear without any trace.",
  // ── legacy LP labels (kept for back-compat with cached scans) ──
  "LP not burned or locked": "The dev can pull all liquidity in one transaction and crash the price to zero.",
  "LP not burned but token is mature and liquid (unverified LP)": "Liquidity is not locked — the dev could still rug, but the token's age and depth make this less likely.",
  // ── pipeline / data gap flags ──
  "Helius unavailable — holder concentration unverified": "Our holder-distribution data source is temporarily unreachable. We can't verify wallet concentration right now — the verdict reflects this uncertainty conservatively.",
  "GoPlus unavailable": "One of our backup analysis sources is unreachable. Other sources still cover the same checks.",
  "RugCheck unavailable": "One of our primary analysis sources is unreachable. Other sources still cover the same checks.",
  "Solscan unavailable": "Our on-chain data source is unreachable. Some metrics (transaction count, age) may be approximate.",
  "Holder data unreliable (broken upstream view) — mature pair, deep liquidity": "Holder data view is degraded, but the token's deep liquidity and maturity offset this gap.",
  // ── bonus ──
  "LP Burned ✓": "Liquidity is permanently burned. No dev can ever pull it — the floor under the price is locked in.",
  "Established token (30d+) ✓": "The token has been live for more than 30 days without rugging. Time is one of the strongest trust signals on Solana.",
}

// Parameterized labels (regex → description-builder). The pattern's match
// groups feed into the description so the user sees the actual number
// from THEIR scan, not a generic template.
const FLAG_PATTERNS: Array<{ pattern: RegExp; build: (m: RegExpMatchArray) => string }> = [
  {
    pattern: /^LP holds ([\d.]+)% of supply — negligible rug risk$/i,
    build: (m) => `Only ${m[1]}% of the total supply sits in the liquidity pool. Even if the dev pulled it, the price impact would be under 5% — absorbed by the broader market within minutes. Typical for established tokens with CEX-dominated liquidity.`,
  },
  {
    pattern: /^LP holds ([\d.]+)% of supply — limited rug impact$/i,
    build: (m) => `${m[1]}% of supply is in the pool. If the dev pulled liquidity, the price would drop roughly 5-15% — the token would recover within hours. Not formally locked, but not the dominant rug vector at this share.`,
  },
  {
    pattern: /^LP holds ([\d.]+)% of supply — moderate rug capacity$/i,
    build: (m) => `${m[1]}% of supply in the pool with no formal lock. A dev pull would knock the price 20-50% and you'd likely take a meaningful loss. The token would probably survive, but reduce position size accordingly.`,
  },
  {
    pattern: /^LP holds ([\d.]+)% of supply — significant rug capacity$/i,
    build: (m) => `${m[1]}% of supply is in the unlocked pool. If the dev pulls, expect a 50-80% price crash. The token's age and clean contract are the only counter-signals — treat with caution.`,
  },
  {
    pattern: /^LP holds ([\d.]+)% of supply — high rug exposure$/i,
    build: (m) => `${m[1]}% of supply in the pool with no lock. A pull would crash the price 80-95%. This profile is unusual for a non-fresh token — high risk regardless of other signals.`,
  },
  {
    pattern: /^LP holds ([\d.]+)% of supply — extreme rug exposure$/i,
    build: (m) => `Dev controls ${m[1]}% of supply via the unlocked liquidity pool. A pull would zero the token instantly. This is the standard fresh-launch / pre-graduation rug setup — exit any open position.`,
  },
  {
    pattern: /^LP-to-supply ratio could not be computed$/i,
    build: () => `We couldn't compute what share of the total supply sits in the LP (missing data from one of our upstreams). Falling back to age + dollar liquidity for the LP-unverified scoring — conservative by design.`,
  },
  {
    pattern: /^Pump \+(\d+)%/i,
    build: (m) => `The token has pumped +${m[1]}% recently — could be organic momentum, but at this scale it's also a classic exit-liquidity setup where bagholders dump on late buyers.`,
  },
  {
    pattern: /^Extreme \d+h pump \+(\d+)% — exit liquidity trap$/i,
    build: (m) => `+${m[1]}% in a short window with structural weaknesses (thin liquidity, no sells, bundler patterns) — this matches the "bundle dump" template where coordinated wallets pump the price to sell into your buy.`,
  },
  {
    pattern: /^Liquidity < \$(\d+k)/i,
    build: (m) => `Total liquidity is under ${m[1]} — even a small sell can crash the price meaningfully. Slippage and exit costs will be high.`,
  },
  {
    pattern: /^Newborn token on-chain \(<(\d+)/i,
    build: (m) => `Token was created less than ${m[1]} hour(s) ago. We have almost no time-based trust data — historical rug patterns show the first 24h are when most pump-and-dumps execute.`,
  },
  {
    pattern: /^LP Locked > (\d+) days ✓$/i,
    build: (m) => `Liquidity is locked for more than ${m[1]} days. The dev cannot pull the pool for at least that long — a strong on-chain commitment.`,
  },
]

function getFlagDescription(label: string): string | null {
  if (FLAG_DESCRIPTIONS[label]) return FLAG_DESCRIPTIONS[label]
  for (const key of Object.keys(FLAG_DESCRIPTIONS)) {
    if (label.toLowerCase().startsWith(key.toLowerCase())) return FLAG_DESCRIPTIONS[key]
  }
  for (const entry of FLAG_PATTERNS) {
    const m = label.match(entry.pattern)
    if (m) return entry.build(m)
  }
  return null
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  bonus: 3,
}

// Pipeline-status flags ("Helius unavailable", "GoPlus unavailable",
// "Holder data unreliable", etc.) are NEVER shown in the panel. They
// describe OUR plumbing, not the token — surfacing them decredibilises
// the verdict. Founder rule: "ne jamais mettre ça, c'est d'aucune
// utilité a part décrédibiliser le projet". Verdict-side safety
// policy (Helius-down → safeBlock) is preserved on the layer object;
// only the visible flag is suppressed.
const PIPELINE_STATUS_PATTERN =
  /^(Helius|GoPlus|RugCheck|Solscan|DexScreener|Birdeye|Helius RPC) (unavailable|rate[- ]limited|timed out|degraded)\b|Holder data unreliable|broken upstream/i

// Human-facing section headers, in display order.
const SECTIONS: Array<{
  key: "critical" | "warning" | "info" | "bonus"
  title: string
  className: string
}> = [
  { key: "critical", title: "Critical issues",   className: "cf-section-critical" },
  { key: "warning",  title: "Warnings",          className: "cf-section-warning" },
  { key: "info",     title: "Context & notes",   className: "cf-section-info" },
  { key: "bonus",    title: "Positive signals",  className: "cf-section-bonus" },
]

/**
 * Toggle the Critical Flags panel in the overlay.
 *
 * Renders EVERY flag regardless of severity, grouped into 4 sections
 * (Critical / Warnings / Context & Notes / Positive Signals). The user
 * sees the full reasoning behind any verdict — even on SAFE, where an
 * "LP unverified" info-level note explains why the ✗ in the indicator
 * grid doesn't downgrade the result.
 *
 * Mirrors toggleAiSummary: builds the subtree via DOM API only so flag
 * labels coming from upstream scoring sources cannot be interpreted as
 * HTML. The panel renders once on first open; subsequent clicks toggle
 * the .open class.
 */
export function toggleCriticalFlags(flags: ScanResponseFlag[] | null | undefined): void {
  const panel = state.shadow?.querySelector("#ant-critical-flags") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")
  if (isOpen) {
    closePanelAnimated(panel)
    return
  }

  // Mutex: close the AI Summary panel INSTANTLY before opening this one.
  // Animated close was creating a 150ms window where both panels were
  // in the DOM, .box height had to accommodate both, and the resulting
  // layout jiggle was being read as "the overlay bugs out". Snapping
  // the other panel shut while this one fades in feels rock solid.
  const aiPanel = state.shadow?.querySelector("#ant-ai-summary") as HTMLElement | null
  if (aiPanel) aiPanel.classList.remove("open", "closing")

  if (!panel.dataset.loaded) {
    panel.dataset.loaded = "1"
    renderPanel(panel, flags)
  }

  panel.classList.add("open")
}

function renderPanel(panel: HTMLElement, flags: ScanResponseFlag[] | null | undefined): void {
  panel.replaceChildren()

  // No severity filter — show everything. Empty state only triggers
  // when there are LITERALLY no flags at all (which would be unusual
  // because the layers always emit at least one bonus or info).
  // Drop pipeline-status flags entirely — they describe OUR plumbing
  // (Helius/GoPlus/RugCheck/Solscan availability), not the token, and
  // surfacing them decredibilises the verdict. Founder rule: "ne jamais
  // mettre ça, c'est d'aucune utilité a part décrédibiliser le projet".
  // Verdict-side safety policy (Helius-down → safeBlock) is preserved
  // on the layer object; only the visible flag is suppressed.
  const all = (flags ?? []).filter((f) => !PIPELINE_STATUS_PATTERN.test(f.label))

  if (all.length === 0) {
    const empty = document.createElement("div")
    empty.className = "cf-panel-empty"
    empty.textContent = "All signals reviewed. Nothing to display."
    panel.appendChild(empty)
    return
  }

  // Group by severity, preserving the original order within each section.
  const buckets: Record<string, ScanResponseFlag[]> = {
    critical: [],
    warning: [],
    info: [],
    bonus: [],
  }
  for (const f of all) {
    const sev = (f.severity as string) ?? "info"
    if (buckets[sev]) buckets[sev].push(f)
    else buckets["info"].push(f)
  }

  const inner = document.createElement("div")
  inner.className = "cf-panel-inner"

  for (const section of SECTIONS) {
    const items = buckets[section.key]
    if (!items || items.length === 0) continue

    const sectionEl = document.createElement("div")
    sectionEl.className = `cf-section ${section.className}`

    const header = document.createElement("div")
    header.className = "cf-section-header"
    const count = document.createElement("span")
    count.className = "cf-section-count"
    count.textContent = String(items.length)
    const title = document.createElement("span")
    title.className = "cf-section-title"
    title.textContent = section.title
    header.appendChild(count)
    header.appendChild(title)
    sectionEl.appendChild(header)

    for (const flag of items) {
      const sevClass =
        section.key === "critical" ? "cr" :
        section.key === "warning"  ? "wr" :
        section.key === "info"     ? "in" :
                                     "bn"
      const iconClass =
        section.key === "critical" ? "r" :
        section.key === "warning"  ? "y" :
        section.key === "info"     ? "b" :
                                     "g"
      const iconChar =
        section.key === "critical" ? "✕" :
        section.key === "warning"  ? "!" :
        section.key === "info"     ? "i" :
                                     "✓"

      const row = document.createElement("div")
      row.className = `cf-flag cf-flag-${sevClass}`

      const icon = document.createElement("div")
      icon.className = `cf-flag-icon cf-flag-icon-${iconClass}`
      icon.textContent = iconChar

      const body = document.createElement("div")
      body.className = "cf-flag-body"

      const label = document.createElement("div")
      label.className = "cf-flag-label"
      label.textContent = flag.label
      body.appendChild(label)

      const desc = getFlagDescription(flag.label)
      if (desc) {
        const descEl = document.createElement("div")
        descEl.className = "cf-flag-desc"
        descEl.textContent = desc
        body.appendChild(descEl)
      }

      row.appendChild(icon)
      row.appendChild(body)
      sectionEl.appendChild(row)
    }

    inner.appendChild(sectionEl)
  }

  panel.appendChild(inner)
}

// Re-export for tests
export const __testing__ = { getFlagDescription, SEVERITY_ORDER, SECTIONS }
