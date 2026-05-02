import { state } from "./state"
import type { ScanResponseFlag } from "../../shared/types"

// Plain-English descriptions for the most common flags. Mirrors the map
// used on the standalone analysis page (js/token-app.js) so users see the
// same wording whether they read flags inline or in the deep-dive tab.
// Keep both copies in sync — there is no shared module because token-app.js
// is plain JS shipped as a static asset, not a TS import.
const FLAG_DESCRIPTIONS: Record<string, string> = {
  "Mint Authority enabled": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Mint Authority enabled (RugCheck)": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Freeze Authority enabled": "The dev can freeze your wallet and prevent you from selling.",
  "Freeze Authority enabled (RugCheck)": "The dev can freeze your wallet and prevent you from selling.",
  "LP not burned or locked": "The dev can pull all liquidity in one transaction and crash the price to zero.",
  "LP not burned but token is mature and liquid (unverified LP)": "Liquidity is not locked — the dev can still rug at any time.",
  "Honeypot detected — cannot sell": "You cannot sell this token. Any funds spent are gone.",
  "Bundle activity detected": "Coordinated wallets bought together to fake demand — classic pump and dump setup.",
  "Bundle holds": "A coordinated group controls a large portion of supply and can dump at will.",
  "Sniper activity detected": "Bots bought massively at launch before anyone else could — supply is concentrated.",
  "Top 10 holders > 70%": "Ten wallets control over 70% of the supply. If they sell together, the price collapses.",
  "Top 10 holders > 50%": "Half the supply is in 10 wallets — high dump risk.",
  "Single wallet holds": "One wallet controls a huge portion of supply and can crash the price alone.",
  "Metadata mutable": "The dev can change the token name, symbol and logo after launch — common in rug setups.",
  "No website / Twitter / Telegram": "Zero social presence — the team can disappear without any trace.",
  "Wash trading detected": "The trading volume is fake — bots trading with themselves to create false activity.",
  "Sell tax": "A hidden fee is taken every time you sell — often used to bleed holders slowly.",
  "Buy tax": "A fee is taken on every purchase — used to fund the dev or prevent exits.",
  "Owner holds > 5%": "The owner wallet holds a large stake and can dump it at any time.",
  "Creator holds > 5%": "The creator wallet holds a large stake and can dump it at any time.",
  "Blacklist capability": "The dev can blacklist specific wallets and prevent them from selling.",
  "Transfer pausable": "The dev can pause all transfers, trapping everyone's funds.",
  "Hidden owner": "The real owner of the contract is hidden — a known red flag for rug pulls.",
  "Upgradeable/proxy contract": "The contract code can be replaced after launch — any security audit becomes worthless.",
}

function getFlagDescription(label: string): string | null {
  if (FLAG_DESCRIPTIONS[label]) return FLAG_DESCRIPTIONS[label]
  for (const key of Object.keys(FLAG_DESCRIPTIONS)) {
    if (label.toLowerCase().startsWith(key.toLowerCase())) return FLAG_DESCRIPTIONS[key]
  }
  return null
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

/**
 * Toggle the Critical Flags panel in the overlay.
 *
 * Mirrors toggleAiSummary: builds the subtree exclusively via DOM API
 * (createElement + textContent), so flag labels coming from upstream
 * scoring sources cannot be interpreted as HTML. The panel renders only
 * once on first open; subsequent clicks toggle the .open class.
 *
 * Bonus flags are excluded — they justify a higher score, not the verdict
 * downgrade the button name promises. Critical flags appear before
 * warnings; unknown severities fall through to a neutral style.
 */
export function toggleCriticalFlags(flags: ScanResponseFlag[] | null | undefined): void {
  const panel = state.shadow?.querySelector("#ant-critical-flags") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")
  if (isOpen) {
    panel.classList.remove("open")
    return
  }

  // Mutex: close any sibling panels before opening this one. AI Summary,
  // Critical Flags, and Watchlist share the same vertical real estate; if
  // multiple are open the overlay overflows the viewport on shorter screens
  // (the user-reported case was a 900px-tall window where the bottom of the
  // box was clipped). One-at-a-time also matches standard accordion behavior.
  state.shadow?.querySelector("#ant-ai-summary")?.classList.remove("open")
  state.shadow?.querySelector("#ant-watchlist")?.classList.remove("open")

  if (!panel.dataset.loaded) {
    panel.dataset.loaded = "1"
    renderPanel(panel, flags)
  }

  panel.classList.add("open")
}

function renderPanel(panel: HTMLElement, flags: ScanResponseFlag[] | null | undefined): void {
  panel.replaceChildren()

  // Filter rules:
  //   bonus      → already excluded (these are positives, not "issues")
  //   info       → infrastructure status, e.g. "Helius unavailable" or
  //                "GoPlus unavailable". They tell the user *we* couldn't
  //                reach a source, not that there's a problem with the
  //                token. Showing them in the Critical Flags panel is
  //                noise — users read "1 flag detected" and assume the
  //                token is risky when in fact only our pipeline is
  //                degraded. The reduced confidence already surfaces
  //                upstream availability via the Conf X% header.
  //   "unavailable"-shaped warnings → legacy: some sources still emit
  //                outage notices at "warning" severity. Catch those by
  //                label until each source is migrated to "info".
  const filtered = (flags ?? []).filter((f) => {
    if (f.severity === "bonus" || f.severity === "info") return false
    if (typeof f.label === "string" && /\bunavailable\b/i.test(f.label)) return false
    return true
  })

  if (filtered.length === 0) {
    const empty = document.createElement("div")
    empty.className = "cf-panel-empty"
    empty.textContent = "No issues found."
    panel.appendChild(empty)
    return
  }

  const sorted = [...filtered].sort((a, b) => {
    const oa = SEVERITY_ORDER[a.severity] ?? 99
    const ob = SEVERITY_ORDER[b.severity] ?? 99
    return oa - ob
  })

  const inner = document.createElement("div")
  inner.className = "cf-panel-inner"

  for (const flag of sorted) {
    const sevClass = flag.severity === "critical" ? "cr" : flag.severity === "warning" ? "wr" : "in"
    const iconClass = flag.severity === "critical" ? "r" : flag.severity === "warning" ? "y" : "g"
    const iconChar = flag.severity === "critical" ? "✕" : flag.severity === "warning" ? "!" : "i"

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
    inner.appendChild(row)
  }

  panel.appendChild(inner)
}
