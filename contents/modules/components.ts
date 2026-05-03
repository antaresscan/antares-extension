import type { ScanResponseFlag, ScanResponseData, QuotaStatus } from "../../shared/types"
import { RISK_CLASS, LABELS, ANALYSIS_PAGE, SVG_MOVE, SVG_CLOSE, VERDICT_COLORS, PHOTON_REF, buildPhotonUrl, PRICING_URL } from "./constants"
import { state, scanCache } from "./state"
import { SHADOW_CSS, injectFonts } from "./styles"
import { initDrag } from "./drag"
import { encodeHashPayload } from "../../shared/hash-payload"
import { toggleAiSummary } from "./ai-summary"
import { toggleCriticalFlags } from "./critical-flags"
import { getInstallId } from "../../shared/install-id"

// DOM-API element builder. Used by buildResult instead of string template
// literals so every text interpolation goes through textContent (which the
// browser cannot parse as HTML), making script-bearing input structurally
// inert. Replaces the previous escapeHtml / safeText helpers — they're
// gone because no caller still needs them. See PR #283 for the audit.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | undefined>,
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) node.setAttribute(k, v)
    }
  }
  for (const child of children) {
    if (child == null) continue
    if (typeof child === "string") {
      node.appendChild(document.createTextNode(child))
    } else {
      node.appendChild(child)
    }
  }
  return node
}

// Inserts an SVG icon string into a parent element. The only callers pass
// the static SVG_MOVE / SVG_CLOSE constants from constants.ts, never user
// input — innerHTML here is safe by construction.
function setStaticSvg(parent: HTMLElement, svg: string): void {
  parent.innerHTML = svg
}

export function formatMcap(mc: number | null | undefined): string {
  if (mc == null) return "\u2014"
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(2)}M`
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(1)}K`
  return `$${mc.toFixed(0)}`
}

export function createHost() {
  injectFonts()
  document.getElementById("antares-host")?.remove()
  state.host = document.createElement("div")
  state.host.id = "antares-host"
  document.documentElement.appendChild(state.host)
  state.shadow = state.host.attachShadow({ mode: "open" })
  const styleEl = document.createElement("style")
  styleEl.textContent = SHADOW_CSS
  state.shadow.appendChild(styleEl)
  const fontLink = document.createElement("link")
  fontLink.rel = "stylesheet"
  fontLink.href = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap"
  state.shadow.appendChild(fontLink)
  state.boxEl = document.createElement("div")
  state.boxEl.className = "box"
  state.shadow.appendChild(state.boxEl)
  initDrag()
}

export function getBox(): HTMLDivElement {
  if (!state.host || !document.documentElement.contains(state.host)) createHost()
  return state.boxEl!
}

export function hideBox() {
  if (!state.boxEl) return
  state.boxEl.style.transition = "opacity .15s ease, transform .15s ease"
  state.boxEl.style.opacity = "0"
  state.boxEl.style.transform = "translateY(8px)"
  if (state.hideTimeout) clearTimeout(state.hideTimeout)
  state.hideTimeout = setTimeout(() => {
    if (state.boxEl) {
      state.boxEl.style.display = "none"
      state.boxEl.style.transition = "opacity .2s ease, transform .2s ease"
    }
  }, 150)
}

export function showBox() {
  if (!state.host || !document.documentElement.contains(state.host)) createHost()
  const el = state.boxEl!
  if (state.hideTimeout) clearTimeout(state.hideTimeout)
  el.style.display = "block"
  el.style.transition = "opacity .2s ease, transform .2s ease"
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.opacity = "1"
    el.style.transform = "translateY(0)"
  }))
}

export function resetState() {
  state.lastCA = ""
  state.manuallyDismissed = false
  state.currentScanController?.abort()
  state.currentScanController = null
  if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null }
  hideBox()
}

export function attachClose(
  aiSummary?: string | null,
  flags?: ScanResponseFlag[] | null,
) {
  state.shadow?.querySelector("#ant-close")?.addEventListener(
    "click",
    () => { state.manuallyDismissed = true; hideBox() },
    { once: true }
  )
  // AI Summary button. Listener wraps stopPropagation + preventDefault
  // so the click never bubbles to the drag/scan handlers attached
  // higher in the overlay tree. Without this, the user-reported
  // "click panel button → overlay refreshes and panels collapse" race
  // was caused by the click reaching the drag layer, which in turn
  // re-rendered the box and wiped the panels' .open state.
  //
  // Free-tier note: the locked variant carries `.locked` and already has
  // an upgrade-redirect listener attached at build time. We skip the
  // clone+rebind here so we don't wipe that listener.
  const aiBtn = state.shadow?.querySelector("#ant-ai-summary-btn")
  if (aiBtn && !aiBtn.classList.contains("locked")) {
    const fresh = aiBtn.cloneNode(true) as HTMLElement
    aiBtn.parentNode?.replaceChild(fresh, aiBtn)
    fresh.addEventListener("click", (e) => {
      e.stopPropagation()
      e.preventDefault()
      toggleAiSummary(aiSummary ?? null)
    })
  }
  // Critical Flags button: same toggle pattern as AI Summary, with its
  // own panel. Replaces the old DexScreener external link — flags are
  // now visible in-overlay so users no longer need to spawn a tab to see
  // why the verdict was assigned. Same `.locked` skip as above for free.
  const cfBtn = state.shadow?.querySelector("#ant-critical-flags-btn")
  if (cfBtn && !cfBtn.classList.contains("locked")) {
    const fresh = cfBtn.cloneNode(true) as HTMLElement
    cfBtn.parentNode?.replaceChild(fresh, cfBtn)
    fresh.addEventListener("click", (e) => {
      e.stopPropagation()
      e.preventDefault()
      toggleCriticalFlags(flags ?? null)
    })
  }
}

/**
 * Attaches the Full Analysis button handler.
 * Delegates tab creation to the background service worker via chrome.runtime.sendMessage
 * because chrome.tabs.create is NOT available in content scripts (MV3).
 */
export function attachAnalysisBtn(mint: string) {
  const btn = state.shadow?.querySelector("#ant-full-analysis")
  if (!btn) return
  // Free-tier note: the locked variant carries `.locked` and already has
  // an upgrade-redirect listener attached at build time. Skip rebind.
  if (btn.classList.contains("locked")) return

  // Clone to remove any previous listener
  const fresh = btn.cloneNode(true) as HTMLElement
  btn.parentNode?.replaceChild(fresh, btn)

  fresh.addEventListener("click", (e) => {
    e.preventDefault()
    const cacheEntry = scanCache.get(mint)
    const hashFragment = cacheEntry
      ? encodeHashPayload(cacheEntry.data as unknown as Record<string, unknown>)
      : ""
    const baseUrl = `${ANALYSIS_PAGE}?ca=${encodeURIComponent(mint)}`
    const url = hashFragment ? `${baseUrl}#data=${hashFragment}` : baseUrl
    // Match any analysis-page tab regardless of mint — keeps a single
    // Antares deep-dive tab around and updates its URL on each click.
    // Previously the pattern was per-mint so every new token spawned a
    // fresh tab, leaving the user with stacks of stale analysis tabs.
    const reusePattern = ANALYSIS_PAGE

    // Delegate to background — the only place allowed to call chrome.tabs.create in MV3
    chrome.runtime.sendMessage(
      { type: "OPEN_TAB", url, reusePattern },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          // Last-resort fallback: open via window.open (works from content script)
          window.open(url, "_blank", "noopener,noreferrer")
        }
      }
    )
  })
}

export function showCachedBadge(ageMs: number) {
  const fo = state.shadow?.querySelector(".fo")
  if (!fo) return
  fo.querySelector(".cached-badge")?.remove()
  const mins = Math.max(1, Math.round(ageMs / 60_000))
  const badge = document.createElement("span")
  badge.className = "cached-badge"
  badge.textContent = `\u26a1 cached \u00b7 ${mins}m ago`
  fo.prepend(badge)
}

export function triggerResultAnimations(el: HTMLDivElement) {
  requestAnimationFrame(() => {
    el.querySelectorAll(".sbar-fill").forEach((b: Element) => {
      const bar = b as HTMLElement
      setTimeout(() => { bar.style.width = bar.dataset.w + "%" }, 250)
    })
    const scoreEl = el.querySelector(".ant-score") as HTMLElement | null
    if (scoreEl) {
      const target = parseInt(scoreEl.dataset.target || "0", 10)
      animateScore(scoreEl, target)
    }
  })
}

export function easeOutQuad(t: number): number { return t * (2 - t) }

export function animateScore(el: HTMLElement, target: number, duration = 1100) {
  const start = performance.now()
  function tick(now: number) {
    const elapsed = now - start
    const progress = Math.min(elapsed / duration, 1)
    const value = Math.round(easeOutQuad(progress) * target)
    el.textContent = String(value)
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function buildSparkline(candles: Array<{ close: number }> | undefined, risk: string): string {
  if (!candles || candles.length < 2) return ""
  const closes = candles.map((c) => c.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const range = max - min || 1
  const w = 60, h = 30
  const points = closes.map((v, i) => {
    const x = (i / (closes.length - 1)) * w
    const y = h - ((v - min) / range) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(" ")
  const color = VERDICT_COLORS[risk] || "#555"
  return `<div class="sparkline"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
}

export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// Renders a quota status badge for the overlay header.
//
//   Free, plenty left  → dim "47/50"   (no border highlight)
//   Free, ≤ 5 left     → yellow "3/50" (warning state)
//   Free, at 0         → red link "0/50 → PRO" (clickable to /pricing)
//   Pro / Lifetime     → green "PRO"  / "LIFE" badge
//
// Returns null when quota is undefined so the header can omit the badge
// entirely (cached results pre-quota launch, anonymous traffic without
// identity headers, or API responses where CORS didn't expose the headers).
const QUOTA_WARN_THRESHOLD = 5

function buildQuotaBadge(quota?: QuotaStatus): HTMLElement | null {
  if (!quota) return null

  if (quota.tier === "pro" || quota.tier === "lifetime") {
    const label = quota.tier === "lifetime" ? "LIFE" : "PRO"
    return el(
      "span",
      {
        class: "quota-badge pro",
        title: `${quota.tier === "lifetime" ? "Lifetime" : "Pro"} · Unlimited scans`,
      },
      label,
    )
  }

  // Free tier — show "used/limit" and tier-up the urgency.
  const text = `${quota.used}/${quota.limit}`
  const remaining = quota.remaining

  if (remaining === 0) {
    // Limit reached — surface as a clickable link to the pricing page.
    // The base href is kept so the link works without JS (right-click "open
    // in new tab", crawlers, etc.); a click handler resolves the install_id
    // asynchronously and rewrites the URL to bake it into the checkout flow,
    // so when the user lands on /pricing the "Upgrade" button already has
    // the right identity to pass through to Lemonsqueezy.
    const link = el(
      "a",
      {
        class: "quota-badge danger",
        href: PRICING_URL,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Daily limit reached — upgrade to Pro for unlimited scans",
      },
      `${text} → PRO`,
    )
    link.addEventListener("click", (e) => {
      e.preventDefault()
      void getInstallId().then((installId) => {
        const url = installId
          ? `${PRICING_URL}?install=${encodeURIComponent(installId)}`
          : PRICING_URL
        window.open(url, "_blank", "noopener noreferrer")
      })
    })
    return link
  }

  const className =
    remaining <= QUOTA_WARN_THRESHOLD ? "quota-badge warn" : "quota-badge"
  return el(
    "span",
    {
      class: className,
      title: `${remaining} scan${remaining === 1 ? "" : "s"} remaining today`,
    },
    text,
  )
}

// Optional affiliate row — only rendered when:
//   1. PHOTON_REF is non-empty (we actually have a referral relationship)
//   2. The user is on the Free tier (Pro/Lifetime get a clean UI as part
//      of what they pay for)
//   3. The verdict is SAFE (don't promote trading on flagged tokens —
//      that would destroy the brand)
//
// Returns null in all other cases so callers can splat it into el() and
// the helper drops nulls automatically.
function buildAffiliateRow(
  ca: string,
  risk: string,
  quota?: QuotaStatus,
): HTMLElement | null {
  if (!PHOTON_REF) return null
  if (quota && (quota.tier === "pro" || quota.tier === "lifetime")) return null
  if (risk !== "SAFE") return null
  const url = buildPhotonUrl(ca)
  if (!url) return null

  return el("div", { class: "aff-row" },
    el(
      "a",
      {
        class: "aff-link",
        href: url,
        target: "_blank",
        rel: "noopener sponsored noreferrer",
        title: "Open on Photon — affiliate link, we earn a small fee on trades",
      },
      "Trade safely on Photon →",
    ),
    el(
      "span",
      { class: "aff-disclosure", title: "We earn a referral fee. Antares stays free for everyone." },
      "ad",
    ),
  )
}

function buildHeaderNode(quota?: QuotaStatus): HTMLElement {
  const dragIcon = el("span", { class: "drag-icon" })
  setStaticSvg(dragIcon, SVG_MOVE)
  const closeBtn = el("button", { class: "x", id: "ant-close" })
  setStaticSvg(closeBtn, SVG_CLOSE)
  // The el() helper filters out null children, so we can pass the badge
  // unconditionally — it just won't render when quota is undefined.
  return el("div", { class: "hd" },
    el("span", { class: "brand" }, "ANTARES"),
    buildQuotaBadge(quota),
    el("div", { class: "hd-right" }, dragIcon, closeBtn),
  )
}

export function buildHeader(): string {
  return buildHeaderNode().outerHTML
}

// Quota-exhausted state — rendered when a Free user has burned through
// their daily 25 scans and the API returns 429 with quota headers
// signalling remaining=0. Replaces the silent box-hide that made the
// extension look broken once the cap landed: now the user sees exactly
// what's happening and gets a primary upgrade CTA pointing at /pricing
// with their install_id baked in.
//
// Design intent: compact (don't dominate the page), no redundant
// header badge (the OUT OF SCANS message says it already), one-line
// CTA that fits the 290px width without wrapping the arrow.
//
// Click reliability: the install_id is baked into href synchronously
// at build time so the native <a target="_blank"> navigation works
// without any JS handler — that fixes the "click does nothing"
// regression where window.open() inside an async .then() lost its
// user-gesture grace and got popup-blocked.
export function buildQuotaExhaustedNode(
  quota: QuotaStatus,
  installId?: string | null,
): HTMLElement {
  if (state.boxEl) state.boxEl.className = "box caution"

  // Reset countdown — recomputed on every render. The interval below
  // updates the .reset-time text so the user sees the minutes tick
  // down without re-rendering the entire subtree.
  function fmtReset(): string {
    if (!quota.resetAt) return "midnight UTC"
    const ms = quota.resetAt - Date.now()
    if (ms <= 0) return "any moment"
    const totalMin = Math.floor(ms / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (h <= 0) return `${m}m`
    return `${h}h ${m}m`
  }
  const resetEl = el("span", { class: "qx-reset-time" }, fmtReset())

  // Cap the displayed counter at the limit — `quota.used` keeps
  // incrementing even past the cap (server INCRs first, then denies).
  // Showing "117/25" looks broken; users care that they're at the cap,
  // not by how much they've blown past it.
  const usedDisplay = Math.min(quota.used, quota.limit)

  // Bake install_id into href so the link works on a single user-click
  // without async indirection. Falls back to the bare URL when the
  // install_id is missing (rare — only on first scan before storage).
  const href = installId
    ? `${PRICING_URL}?install=${encodeURIComponent(installId)}`
    : PRICING_URL

  // Design picked from /quota-overlay-demos.html (#91) → Demo 3
  // "Premium / calm". White headline (no all-caps drama), outline
  // CTA (not screaming green button), price visible so the user
  // knows what they'd pay before clicking.
  const root = el("div", undefined,
    el("div", { class: "topbar" }),
    // Pass undefined so the header quota-badge is suppressed — the
    // body says it already, double signal was visual noise.
    buildHeaderNode(undefined),
    el("div", { class: "qx-vb" },
      el("h1", undefined, "Daily limit reached"),
      el("div", { class: "qx-sub" }, "resets in ", resetEl),
    ),
    el("div", { class: "qx-counter" },
      "You've used today's ",
      el("b", undefined, `${usedDisplay} / ${quota.limit}`),
      " scans",
    ),
    el("a", {
      class: "qx-cta",
      href,
      target: "_blank",
      rel: "noopener noreferrer",
      // No JS click handler — native <a> nav is reliable, async
      // window.open() loses the user-gesture grace and gets blocked.
    }, "Unlock unlimited"),
    el("div", { class: "qx-price" },
      el("b", undefined, "$24.99"),
      " for 30 days · USDC or SOL",
    ),
  )

  // Tick the reset string every 30s — coarse enough to not churn DOM,
  // fine enough to feel live.
  const interval = setInterval(() => {
    if (!resetEl.isConnected) {
      clearInterval(interval)
      return
    }
    resetEl.textContent = fmtReset()
  }, 30_000)

  return root
}

// Loading-state skeleton injected while a scan is in-flight. Exported as
// a Node so callers can `replaceChildren(buildSkeletonNode())` instead of
// stringifying — keeps the dynamic render path innerHTML-free, matching
// the pattern established in #292 for buildResultNode.
export function buildSkeletonNode(): DocumentFragment {
  const frag = document.createDocumentFragment()
  frag.appendChild(el("div", {
    class: "topbar",
    style: "background:linear-gradient(90deg,transparent,#3a3a3f,transparent)",
  }))
  frag.appendChild(buildHeaderNode())
  frag.appendChild(el("div", { class: "skel" },
    el("div", { class: "skel-verdict" }),
    el("div", { class: "skel-bar" }),
    el("div", { class: "skel-line" }),
    el("div", { class: "skel-line" }),
    el("div", { class: "skel-line" }),
  ))
  return frag
}

function buildSiBool(siLabel: string, val: unknown, invert = false): HTMLElement {
  if (val == null) {
    return el("div", { class: "si" },
      el("span", undefined, siLabel),
      el("b", { style: "color:#333" }, "\u2014"),
    )
  }
  const yes = invert ? !val : !!val
  return el("div", { class: "si" },
    el("span", undefined, siLabel),
    el("b", { class: yes ? "y" : "n" }, yes ? "\u2713" : "\u2717"),
  )
}

function buildSiLp(data: ScanResponseData): HTMLElement {
  if (data.lpBurned) {
    return el("div", { class: "si" },
      el("span", undefined, "LP Burned"),
      el("b", { class: "y" }, "\u2713"),
    )
  }
  if (data.lpLocked) {
    const pct = data.lpLockedPct != null ? ` ${data.lpLockedPct}%` : ""
    const dur = data.lpLockDurationDays != null ? ` (${data.lpLockDurationDays}d)` : ""
    return el("div", { class: "si" },
      el("span", undefined, "LP Locked" + pct + dur),
      el("b", { class: "y" }, "\u2713"),
    )
  }
  if (data.lpBurned == null && data.lpLocked == null) {
    return el("div", { class: "si" },
      el("span", undefined, "LP Lock"),
      el("b", { style: "color:#555" }, "\u2014"),
    )
  }
  return el("div", { class: "si" },
    el("span", undefined, "LP Lock"),
    el("b", { class: "n" }, "\u2717"),
  )
}

// Build the overlay's result tree as a live DOM node. Preferred over the
// legacy string variant — callers should use replaceChildren(node) instead
// of `el.innerHTML = string` so the surrounding container never has to
// re-parse markup at all.
export function buildResultNode(data: ScanResponseData, ca: string): HTMLElement {
  const riskClass = RISK_CLASS[data.risk] || "danger"
  const label = LABELS[data.risk] || data.risk
  const mint = data.resolvedMint || ca
  const liq = data.liquidity ?? data.pair?.liquidity?.usd ?? null

  const score = data.score || 0
  const barW = Math.min(100, Math.round(score / 10))

  const tokenName = data.tokenName || data.pair?.baseToken?.name || ""
  const tokenSymbol = data.tokenSymbol || data.pair?.baseToken?.symbol || ""

  if (state.boxEl) state.boxEl.className = `box ${riskClass}`

  const dotsCount = Math.round((score / 1000) * 5)
  const dotsNode = el("div", { class: "dots" },
    ...Array.from({ length: 5 }, (_, i) =>
      el("div", { class: `dt ${i < dotsCount ? "on" : "off"}` }),
    ),
  )

  // Same filter rules as the Critical Flags panel: drop bonus + info +
  // legacy "unavailable" warnings. Without this the summary shows
  // "1 flags detected" for tokens whose only flag is "Helius unavailable",
  // which scares users about token risk when only our pipeline is degraded.
  // Conf X% in the header already conveys upstream availability.
  const allFlags = (data.flags || []).filter((f: ScanResponseFlag) => {
    if (f.severity === "bonus" || f.severity === "info") return false
    if (typeof f.label === "string" && /\bunavailable\b/i.test(f.label)) return false
    return true
  })
  const flagCount = allFlags.length
  const critCount = allFlags.filter((f: ScanResponseFlag) => f.severity === "critical").length

  let summary = ""
  if (flagCount === 0) summary = "No issues found"
  else if (critCount > 0) summary = `${flagCount} flags \u2014 ${critCount} critical`
  else summary = `${flagCount} flags detected`

  const liqDisplay = liq !== null ? formatMcap(liq) : "\u2014"
  const liqClass: string | undefined =
    liq !== null && liq < 5000 ? "n" : liq !== null && liq > 50000 ? "y" : undefined

  const ssNode = el("div", { class: "ss" },
    el("div", { class: "si" },
      el("span", undefined, "Sell"),
      el("b", { class: data.honeypot ? "n" : "y" }, data.honeypot ? "\u2717" : "\u2713"),
    ),
    buildSiBool("Mint", data.mintAuthority, true),
    buildSiBool("Freeze", data.freezeAuthority, true),
    buildSiLp(data),
    el("div", { class: "si" },
      el("span", undefined, "Liq"),
      el("b", { class: liqClass }, liqDisplay),
    ),
  )

  // Footer buttons. The DexScreener external link was removed in favour
  // of an inline Critical Flags panel: traders rarely jumped out to
  // DexScreener from here, but they always wanted to see *why* a token
  // was flagged without losing their place. The panel mirrors AI Summary
  // \u2014 toggled inline via toggleCriticalFlags, never opens a new tab.
  //
  // Free-tier gating: Critical Flags, Full Analysis, and AI Summary are
  // Pro/Lifetime features. Free users still see all three buttons (so
  // they know what they're missing \u2014 invisible features don't sell
  // upgrades) but the buttons are visually locked, carry a small "PRO"
  // pill, and clicking any of them opens /pricing instead of activating
  // the underlying feature. We gate by `_quota.tier === "free"`
  // specifically: pre-quota cached responses without a _quota field
  // default to unlocked so we don't downgrade users who were paying
  // yesterday but whose response just happens to be missing the headers.
  const isFree = data._quota?.tier === "free"
  const foNode = el("div", { class: "fo" })

  // Click handler that opens /pricing with install_id baked in.
  // Used for all 3 locked buttons when isFree.
  function attachUpgradeRedirect(node: HTMLElement) {
    node.addEventListener("click", (e) => {
      e.stopPropagation()
      e.preventDefault()
      void getInstallId().then((installId) => {
        const url = installId
          ? `${PRICING_URL}?install=${encodeURIComponent(installId)}`
          : PRICING_URL
        window.open(url, "_blank", "noopener noreferrer")
      })
    })
  }

  const cfBtn = el("button", {
    class: isFree ? "cf-btn locked" : "cf-btn",
    id: "ant-critical-flags-btn",
    title: isFree ? "Unlock with Pro" : undefined,
  }, "\u26a0 Critical Flags")
  if (isFree) {
    cfBtn.appendChild(el("span", { class: "lock-pill" }, "PRO"))
    attachUpgradeRedirect(cfBtn)
  }
  foNode.appendChild(cfBtn)

  // Always neutral gray \u2014 verdict color is communicated by the verdict
  // headline and the Critical Flags panel; tinting the deep-dive button
  // red on RUG was confusing (read as "dangerous to click" instead of
  // "the token is dangerous").
  const faBtn = el("a", {
    href: isFree ? PRICING_URL : "#",
    id: "ant-full-analysis",
    "data-ca": encodeURIComponent(mint),
    class: isFree ? "locked" : undefined,
    title: isFree ? "Unlock with Pro" : undefined,
    target: isFree ? "_blank" : undefined,
    rel: isFree ? "noopener noreferrer" : undefined,
  }, "Full Analysis \u2192")
  if (isFree) {
    faBtn.appendChild(el("span", { class: "lock-pill" }, "PRO"))
    attachUpgradeRedirect(faBtn)
  }
  foNode.appendChild(faBtn)

  const aiBtn = el("button", {
    class: isFree ? "ai-btn ai-btn--active locked" : "ai-btn ai-btn--active",
    id: "ant-ai-summary-btn",
    title: isFree ? "Unlock with Pro" : undefined,
  }, "\u2b21 AI Summary")
  if (isFree) {
    aiBtn.appendChild(el("span", { class: "lock-pill" }, "PRO"))
    attachUpgradeRedirect(aiBtn)
  }
  foNode.appendChild(aiBtn)

  const tkNode = tokenSymbol
    ? el("div", { class: "tk" },
        el("b", undefined, tokenSymbol),
        tokenName ? " " + tokenName : "",
      )
    : null

  const root = el("div", undefined,
    el("div", { class: "topbar" }),
    buildHeaderNode(data._quota),
    tkNode,
    el("div", { class: "vb" },
      el("h1", undefined, label),
    ),
    el("div", { class: "sr" },
      el("span", { class: "n" },
        el("b", { class: "ant-score", "data-target": String(score) }, "0"),
        " / 1000",
      ),
      dotsNode,
    ),
    el("div", { class: "sbar" },
      el("div", { class: "sbar-fill", "data-w": String(barW) }),
    ),
    el("div", { class: "sum" }, summary),
    el("div", { class: "sep" }),
    ssNode,
    // Panels exist in the DOM for both tiers — buttons are visible to
    // free users (locked) so the panels need to be addressable too,
    // even though the toggleCriticalFlags / toggleAiSummary handlers
    // never run for free (the click handler short-circuits to /pricing
    // before they can fire).
    el("div", { class: "cf-panel", id: "ant-critical-flags" }),
    el("div", { class: "ai-panel", id: "ant-ai-summary" }),
    foNode,
    buildAffiliateRow(mint, data.risk, data._quota),
  )

  return root
}

// Backward-compatible string variant. Kept because xss-regression tests
// (PR #283) and any future caller that legitimately needs serialised HTML
// (e.g. for postMessage / saveToHistory) can rely on it. Callers writing
// into the live DOM should prefer buildResultNode + replaceChildren.
export function buildResult(data: ScanResponseData, ca: string): string {
  return buildResultNode(data, ca).innerHTML
}
