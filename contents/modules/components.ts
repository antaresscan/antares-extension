import type { ScanResponseFlag, ScanResponseData, QuotaStatus } from "../../shared/types"
import { RISK_CLASS, ANALYSIS_PAGE, SVG_MOVE, SVG_CLOSE, VERDICT_COLORS, PHOTON_REF, buildPhotonUrl, PRICING_URL } from "./constants"
import { verdictLabel } from "./verdict-label"
import { state, scanCache, resetSourceGap } from "./state"
import { SHADOW_CSS, injectFonts } from "./styles"
import { initDrag } from "./drag"
import { encodeHashPayload } from "../../shared/hash-payload"
import { toggleAiSummary } from "./ai-summary"
import { toggleCriticalFlags } from "./critical-flags"
import { isHoldersUnverifiedFlag } from "../../shared/holders-unverified"
import { LOADING_HINT, SOURCE_GAP_TITLE, LIMITED_DATA_LABEL, LIMITED_DATA_SUMMARY, LIMITED_BUTTONS_TITLE, sourceGapOf } from "./resilience"

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

/**
 * Makes a footer button do nothing: while the card is Limited data no verdict is known, so Critical Flags, Full Analysis and AI Summary have nothing true to open.
 * Not a link (no href, no target: nothing to follow, nothing to focus), a real <button> is disabled, aria-disabled says so, and attachClose / attachAnalysisBtn
 * skip it so that no click handler is ever bound. The CSS dims it and ignores the pointer (the tooltip is on the footer).
 */
function makeInert<T extends HTMLElement>(btn: T): T {
  btn.setAttribute("aria-disabled", "true")
  btn.setAttribute("tabindex", "-1")
  btn.classList.add("disabled")
  for (const attr of ["href", "target", "rel", "title"]) btn.removeAttribute(attr)
  if (btn instanceof HTMLButtonElement) btn.disabled = true
  return btn
}

/** True for a footer button made inert by makeInert. */
const isInert = (btn: Element | null): boolean => btn?.getAttribute("aria-disabled") === "true"

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
  if (state.recoveryTimer) { clearTimeout(state.recoveryTimer); state.recoveryTimer = null }
  if (state.staleExpiryTimer) { clearTimeout(state.staleExpiryTimer); state.staleExpiryTimer = null }
  state.recoveryCa = ""
  state.recoveryAttempt = 0
  state.recoveryStartedAt = 0
  resetSourceGap()
  state.failureView = null
  state.rescanCount = 0
  state.rescanCountCA = ""
  hideBox()
}

/**
 * The line that says the verdict on screen is from memory: "Scanned 6 min ago", centred at the foot of the card, in the voice of the card's
 * other small labels. It is plain text: nothing from the server goes in it.
 */
export function appendScannedAgo(root: ParentNode, text: string): void {
  const line = el("div", { class: "scanned-ago", role: "status", title: "The scanner cannot be reached right now. Trying again." }, text)
  const card = root.querySelector(".vb")?.parentNode ?? root
  card.appendChild(line)
}

/** Refresh the age in the line without rebuilding the card (a panel the user has open stays open). */
export function updateScannedAgo(root: ParentNode, text: string): void {
  const line = root.querySelector(".scanned-ago")
  if (line) line.textContent = text
}

/**
 * The line that says a data source did not answer and counts down to the next try: "Rescanning in 24s". Same place and
 * same voice as "Scanned 6 min ago" (the two never share a card). Plain text: nothing from the server goes in it.
 */
export function appendSourceGap(root: ParentNode, text: string): void {
  const line = el("div", { class: "source-gap", role: "status", title: SOURCE_GAP_TITLE }, text)
  const card = root.querySelector(".vb")?.parentNode ?? root
  card.appendChild(line)
}

/** Change the words of the line without rebuilding the card (a panel the user has open stays open). Returns false when there is no line. */
export function updateSourceGap(root: ParentNode, text: string): boolean {
  const line = root.querySelector(".source-gap")
  if (!line) return false
  line.textContent = text
  return true
}

export function attachClose(
  aiSummary?: string | null,
  flags?: ScanResponseFlag[] | null,
  verdict?: string | null,
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
  if (aiBtn && !aiBtn.classList.contains("locked") && !isInert(aiBtn)) {
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
  if (cfBtn && !cfBtn.classList.contains("locked") && !isInert(cfBtn)) {
    const fresh = cfBtn.cloneNode(true) as HTMLElement
    cfBtn.parentNode?.replaceChild(fresh, cfBtn)
    fresh.addEventListener("click", (e) => {
      e.stopPropagation()
      e.preventDefault()
      toggleCriticalFlags(flags ?? null, verdict ?? null)
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
  // Limited data: the button is inert, nothing opens the token page (see makeInert).
  if (isInert(btn)) return

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
    // Score bar fills synchronously with the score number animation —
    // both kicked off in the same frame so they finish together. The
    // previous 250ms setTimeout made the bar lag noticeably behind the
    // score, which read as "two animations" instead of "one verdict
    // landing". CSS handles the actual width tween (1.1s cubic-bezier).
    el.querySelectorAll(".sbar-fill").forEach((b: Element) => {
      const bar = b as HTMLElement
      bar.style.width = bar.dataset.w + "%"
    })
    const scoreEl = el.querySelector(".ant-score") as HTMLElement | null
    if (scoreEl) {
      const target = parseInt(scoreEl.dataset.target || "0", 10)
      animateScore(scoreEl, target)
    }
  })
}

/**
 * Apply the final score + bar values WITHOUT animation. Used by silent
 * rescan paths (login/logout sync, tab focus) where playing the entrance
 * tween would feel like a reload — but the values STILL have to be
 * written into the DOM. buildResultNode renders the score node with
 * textContent "0" and the bar with width 0%; the actual numbers live in
 * the data-target / data-w attributes and get written here.
 *
 * Without this fix the silent path showed "0 / 1000" plus a 0%-wide bar
 * for every freshly-rendered card after a session change, even though
 * the dots and the verdict colour reflected the real (correct) score —
 * read as "the extension is broken after I logged in/out".
 */
export function applyFinalAnimationValues(el: HTMLDivElement) {
  el.querySelectorAll(".sbar-fill").forEach((b: Element) => {
    const bar = b as HTMLElement
    bar.style.width = (bar.dataset.w || "0") + "%"
  })
  const scoreEl = el.querySelector(".ant-score") as HTMLElement | null
  if (scoreEl) scoreEl.textContent = scoreEl.dataset.target || "0"
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
  if (quota && (quota.tier === "pro" || quota.tier === "yearly" || quota.tier === "lifetime")) return null
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
  // Tier signal lives entirely on the ANTARES wordmark colour itself
  // — gray for Free, gold for Pro/Yearly/Lifetime. No separate badge
  // logo, no PRO/YEAR/LIFE pill. Title attribute on the span carries
  // the tier-specific copy for hover.
  const isPro = !!quota && (
    quota.tier === "pro" ||
    quota.tier === "yearly" ||
    quota.tier === "lifetime"
  )
  const tierTitle =
    quota?.tier === "lifetime" ? "Lifetime · Unlimited scans"
    : quota?.tier === "yearly" ? "Yearly · Unlimited scans"
    : quota?.tier === "pro"    ? "Pro · Unlimited scans"
    : "Free · Unlimited scans"
  return el("div", { class: "hd" },
    el("span", {
      class: `brand ${isPro ? "pro" : ""}`.trim(),
      title: tierTitle,
    }, "ANTARES"),
    el("div", { class: "hd-right" }, dragIcon, closeBtn),
  )
}

export function buildHeader(): string {
  return buildHeaderNode().outerHTML
}

// Loading-state skeleton injected while a scan is in-flight. Exported as
// a Node so callers can `replaceChildren(buildSkeletonNode())` instead of
// stringifying — keeps the dynamic render path innerHTML-free, matching
// the pattern established in #292 for buildResultNode.
//
// The .skel-slow-hint child carries a CSS animation with `animation-delay: 3s`
// — invisible for the first 3 seconds (typical fast-network responses), then
// fades in with LOADING_HINT ("Still loading…") so the user knows the
// extension isn't stuck on slow connections. Past the scan's limit (the request
// failed, or SCAN_BUDGET_MS is over) scanner.ts swaps the text for SLOW_SCAN_HINT
// ("Taking longer than usual, still on it"), which then stays while the
// overlay retries. Once the skeleton is replaced by buildResultNode the element
// disappears and the animation is gone — no JS timer to manage.
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
    el("div", { class: "skel-slow-hint" }, LOADING_HINT),
  ))
  return frag
}

// The little dash of a check that is neither passed nor failed (Sell on Solana, a source that did not answer, an issuer's authority): the same under every label.
const dashNode = (): HTMLElement => el("b", { style: "color:#333" }, "\u2014")

function buildSiBool(siLabel: string, val: unknown, invert = false): HTMLElement {
  if (val == null) {
    return el("div", { class: "si" },
      el("span", undefined, siLabel),
      dashNode(),
    )
  }
  const yes = invert ? !val : !!val
  return el("div", { class: "si" },
    el("span", undefined, siLabel),
    el("b", { class: yes ? "ok" : "no" }),
  )
}

function buildSiLp(data: ScanResponseData): HTMLElement {
  if (data.lpBurned) {
    return el("div", { class: "si" },
      el("span", undefined, "LP Burned"),
      el("b", { class: "ok" }),
    )
  }
  if (data.lpLocked) {
    const pct = data.lpLockedPct != null ? ` ${data.lpLockedPct}%` : ""
    const dur = data.lpLockDurationDays != null ? ` (${data.lpLockDurationDays}d)` : ""
    return el("div", { class: "si" },
      el("span", undefined, "LP Locked" + pct + dur),
      el("b", { class: "ok" }),
    )
  }
  if (data.lpBurned == null && data.lpLocked == null) {
    return el("div", { class: "si" },
      el("span", undefined, "LP Lock"),
      dashNode(),
    )
  }
  return el("div", { class: "si" },
    el("span", undefined, "LP Lock"),
    el("b", { class: "no" }),
  )
}

// Build the overlay's result tree as a live DOM node. Preferred over the
// legacy string variant — callers should use replaceChildren(node) instead
// of `el.innerHTML = string` so the surrounding container never has to
// re-parse markup at all.
export function buildResultNode(
  data: ScanResponseData,
  ca: string,
  installId?: string | null,
): HTMLElement {
  // A source did not answer: no verdict, the Limited data card (same layout and type as the others, the four verdict colours mixed).
  const limited = sourceGapOf(data)
  const riskClass = limited ? "limited" : RISK_CLASS[data.risk] || "danger"
  const label = limited ? LIMITED_DATA_LABEL : verdictLabel(data.risk, data.rugKind)
  const mint = data.resolvedMint || ca
  const liq = data.liquidity ?? data.pair?.liquidity?.usd ?? null

  const score = data.score || 0
  const SCORE_BAND: Record<string, number> = { SAFE: 1000, CAUTION: 750, DANGER: 500, RUG: 250 }
  const displayScore = SCORE_BAND[data.risk] ?? score
  const barW = Math.min(100, Math.round(displayScore / 10))

  const tokenName = data.tokenName || data.pair?.baseToken?.name || ""
  const tokenSymbol = data.tokenSymbol || data.pair?.baseToken?.symbol || ""

  // Watermark renders on every overlay regardless of tier (Free + Pro
  // get the same visual). Driven by .box::after in styles.ts — no
  // tier-gating class needed here.
  if (state.boxEl) state.boxEl.className = `box ${riskClass}`

  const dotsCount = Math.round((displayScore / 1000) * 4)
  const dotsNode = el("div", { class: "dots" },
    ...Array.from({ length: 4 }, (_, i) =>
      el("div", { class: limited ? `dt lim lim-${i}` : `dt ${i < dotsCount ? "on" : "off"}` }),
    ),
  )

  // Summary count includes EVERY warning + critical flag, even
  // provider-availability ones ("Helius unavailable \u2014 holder concentration
  // unverified"). Why: those are exactly what triggers CAUTION via the
  // safeBlock layer (see api/_lib/layers.ts). Hiding them from the count
  // produces "No issues found" on a CAUTION verdict, which lies to the
  // user \u2014 they then can't tell whether to trust the score.
  //
  // Bonus and pure-info flags stay filtered: those don't affect verdict
  // and would inflate the count for "good news" rows like "LP burned \u2713".
  // Pipeline-status flags ("Helius unavailable", "GoPlus unavailable")
  // are excluded from the summary count — they describe OUR plumbing,
  // not the token. Founder rule, matches the Critical Flags panel.
  const PIPELINE_STATUS_PATTERN_C =
    /^(Helius|GoPlus|RugCheck|Solscan|DexScreener|Birdeye|Helius RPC) (unavailable|rate[- ]limited|timed out|degraded)\b|Holder data unreliable|broken upstream/i
  // Pure price-pump flags used to be excluded here too (so a SAFE token
  // whose only flags were pump notices wouldn't show a contradictory "N
  // flags detected"). That's now handled unconditionally by the SAFE
  // hard-backstop below, so excluding pump flags from the count served
  // no purpose for SAFE \u2014 and it actively broke non-SAFE verdicts:
  // a DANGER token whose only flags are pump-pattern ones collapsed to
  // flagCount 0 and printed "No issues found" while the Warnings panel
  // (unfiltered) correctly showed those same flags. Keep pump flags in
  // the count so the summary never contradicts what the panel renders.
  const summaryFlags = (data.flags || []).filter((f: ScanResponseFlag) => {
    if (f.severity === "bonus" || f.severity === "info") return false
    // "Holder concentration unverified" is the one status flag that stays
    // visible: it is why a CAUTION verdict is not SAFE (see
    // shared/holders-unverified.ts).
    if (PIPELINE_STATUS_PATTERN_C.test(f.label) && !isHoldersUnverifiedFlag(f.label)) return false
    return true
  })
  const flagCount = summaryFlags.length
  const critCount = summaryFlags.filter((f: ScanResponseFlag) => f.severity === "critical").length

  // Plain, neutral wording \u2014 never editorialise about data quality. The
  // panel surfaces each flag's actual label so users can read the
  // specifics there. The summary is just a count + critical breakdown.
  //
  // Hard backstop: SAFE always reads "No issues found", full stop. The
  // verdict is the single source of truth for "is this safe" \u2014 if the
  // server says SAFE, nothing in this summary is allowed to contradict
  // it, even if some future flag/label mismatch reintroduces a counting
  // gap like the two above. determineVerdict already guarantees SAFE
  // means zero warning/critical flags; this just makes that guarantee
  // impossible to violate on the display side too.
  let summary = ""
  // "No issues found" is for SAFE only: a verdict that is not SAFE without a flag to count (a source did not answer, so SAFE was not
  // granted) says so, instead of reading "No issues found" next to CAUTION.
  // A SAFE held or reached while a source is silent says so: "No issues found" would claim a check that could not be made.
  if (data.risk === "SAFE") summary = "No issues found"
  else if (flagCount === 0) summary = data.risk === "CAUTION" ? "Limited data" : "Risk detected"
  else if (critCount > 0) summary = `${flagCount} flag${flagCount > 1 ? "s" : ""} \u2014 ${critCount} critical`
  else summary = `${flagCount} flag${flagCount > 1 ? "s" : ""} detected`

  if (limited) summary = LIMITED_DATA_SUMMARY

  const liqDisplay = liq !== null ? formatMcap(liq) : "\u2014"
  const liqClass: string | undefined =
    liq !== null && liq < 5000 ? "n" : liq !== null && liq > 50000 ? "y" : undefined

  // The checks come from sources, some of which did not answer: none is shown as passed or failed ("\u2014"), the liquidity is public market data.
  // An issuer's asset (a stablecoin, a tokenized stock, a liquid staking token...) holds its mint and freeze authorities by design and its liquidity is not what backs it: next to a SAFE verdict,
  // red crosses under Mint, Freeze and LP Lock read as a contradiction, so those three are a dash too (the server says which tokens: issuerKind).
  const issuerAsset = typeof data.issuerKind === "string" && data.issuerKind !== ""
  const facts = limited
    ? { ...data, honeypot: null, mintAuthority: null, freezeAuthority: null, lpBurned: null, lpLocked: null }
    : issuerAsset ? { ...data, mintAuthority: null, freezeAuthority: null, lpBurned: null, lpLocked: null } : data
  const ssNode = el("div", { class: "ss" },
    buildSiBool("Sell", facts.honeypot, true),
    buildSiBool("Mint", facts.mintAuthority, true),
    buildSiBool("Freeze", facts.freezeAuthority, true),
    buildSiLp(facts),
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
  // Pro/Lifetime features. Free users still see all three buttons at
  // full colour (so they know what they're missing \u2014 invisible features
  // don't sell upgrades), with a giant translucent "PRO" watermark behind
  // the label (.pro-ghost, see styles.ts) instead of a corner pill \u2014
  // clicking any of them opens /pricing instead of activating the
  // underlying feature. We gate by `_quota.tier === "free"`
  // specifically: pre-quota cached responses without a _quota field
  // default to unlocked so we don't downgrade users who were paying
  // yesterday but whose response just happens to be missing the headers.
  const isFree = data._quota?.tier === "free"
  const foNode = el("div", { class: "fo" })

  // Locked buttons render as <a target="_blank"> with install_id baked
  // synchronously into the href. Earlier versions used a click handler
  // that did e.preventDefault() + await getInstallId() + window.open()
  // \u2014 the async gap consumed the user-gesture grace, so the popup got
  // blocked and clicks did nothing. Native <a> nav has no such gap.
  const upgradeHref = installId
    ? `${PRICING_URL}?install=${encodeURIComponent(installId)}`
    : PRICING_URL

  // Critical Flags \u2014 <a> for Free (locked, navigates), <button> for
  // Pro/Lifetime (toggles panel). Same id either way so attachClose
  // can find it; the attachClose path skips rebinding when .locked.
  let cfBtn: HTMLElement
  if (isFree) {
    cfBtn = el("a", {
      class: "cf-btn locked",
      id: "ant-critical-flags-btn",
      href: upgradeHref,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Unlock with Pro",
    },
      el("span", { class: "pro-ghost" }, "PRO"),
      el("span", { class: "locked-label" }, "Critical Flags"),
    )
  } else {
    cfBtn = el("button", {
      class: "cf-btn",
      id: "ant-critical-flags-btn",
    }, "Critical Flags")
  }
  if (limited) makeInert(cfBtn)
  foNode.appendChild(cfBtn)

  // Full Analysis \u2014 always <a>. For Pro, attachAnalysisBtn binds a
  // chrome.runtime.sendMessage handler (delegates tab creation to the
  // background worker because chrome.tabs.create isn't available in
  // content scripts in MV3). For Free (locked), attachAnalysisBtn
  // skips the rebind, leaving the synchronous href in charge.
  const faBtn = isFree
    ? el("a", {
        href: upgradeHref,
        id: "ant-full-analysis",
        "data-ca": encodeURIComponent(mint),
        class: "locked",
        title: "Unlock with Pro",
        target: "_blank",
        rel: "noopener noreferrer",
      },
        el("span", { class: "pro-ghost" }, "PRO"),
        el("span", { class: "locked-label" }, "Full Analysis"),
      )
    : el("a", {
        href: "#",
        id: "ant-full-analysis",
        "data-ca": encodeURIComponent(mint),
      }, "Full Analysis")
  if (limited) makeInert(faBtn)
  foNode.appendChild(faBtn)

  // AI Summary \u2014 same shape as cf-btn above.
  let aiBtn: HTMLElement
  if (isFree) {
    aiBtn = el("a", {
      class: "ai-btn ai-btn--active locked",
      id: "ant-ai-summary-btn",
      href: upgradeHref,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Unlock with Pro",
    },
      el("span", { class: "pro-ghost" }, "PRO"),
      el("span", { class: "locked-label" }, "AI Summary"),
    )
  } else {
    aiBtn = el("button", {
      class: "ai-btn ai-btn--active",
      id: "ant-ai-summary-btn",
    }, "AI Summary")
  }
  if (limited) makeInert(aiBtn)
  foNode.appendChild(aiBtn)
  // The tooltip sits on the footer: the inert buttons ignore the pointer, so it is the footer that is hovered.
  if (limited) foNode.setAttribute("title", LIMITED_BUTTONS_TITLE)

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
        limited ? el("b", undefined, "\u2014") : el("b", { class: "ant-score", "data-target": String(displayScore) }, "0"),
        " / 1000",
      ),
      dotsNode,
    ),
    limited
      ? el("div", { class: "sbar lim" }, el("i"), el("i"), el("i"), el("i"))
      : el("div", { class: "sbar" }, el("div", { class: "sbar-fill", "data-w": String(barW) })),
    el("div", { class: "sum" }, summary),
    el("div", { class: "sep" }),
    ssNode,
    // Panels live inside a shared .panel-area wrapper — the wrapper
    // reserves a constant slot, and both panels sit position:absolute
    // overlapping inside it. Switching from AI Summary to Critical
    // Flags (or vice-versa) never changes .box height because the
    // wrapper's min-height is sized to the larger of the two panels.
    // Eliminates the "overlay grows for a frame on panel-swap" bug.
    el("div", { class: "panel-area" },
      el("div", { class: "cf-panel", id: "ant-critical-flags" }),
      el("div", { class: "ai-panel", id: "ant-ai-summary" }),
    ),
    foNode,
    buildAffiliateRow(mint, limited ? "LIMITED" : data.risk, data._quota),
  )

  return root
}

// Backward-compatible string variant. Kept because xss-regression tests
// (PR #283) and any future caller that legitimately needs serialised HTML
// (e.g. for postMessage / saveToHistory) can rely on it. Callers writing
// into the live DOM should prefer buildResultNode + replaceChildren.
export function buildResult(
  data: ScanResponseData,
  ca: string,
  installId?: string | null,
): string {
  return buildResultNode(data, ca, installId).innerHTML
}
