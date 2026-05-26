import type { ScanResponseFlag, ScanResponseData, QuotaStatus } from "../../shared/types"
import { RISK_CLASS, LABELS, ANALYSIS_PAGE, SVG_MOVE, SVG_CLOSE, VERDICT_COLORS, PHOTON_REF, buildPhotonUrl, PRICING_URL } from "./constants"
import { state, scanCache } from "./state"
import { SHADOW_CSS, injectFonts } from "./styles"
import { initDrag } from "./drag"
import { encodeHashPayload } from "../../shared/hash-payload"
import { toggleAiSummary } from "./ai-summary"
import { toggleCriticalFlags } from "./critical-flags"

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

// Renders a quota status badge for the overlay header.
//
//   Free, unlimited (limit = -1) → "FREE" badge (post-2026-05 model where
//                                  Free tier has unlimited scans; only the
//                                  paid features stay locked)
//   Pro / Lifetime               → green "PRO" / "LIFE" badge
//   Free, capped (legacy, kept for back-compat with stale cached responses):
//     Free, plenty left  → dim "47/50"
//     Free, ≤ 5 left     → yellow "3/50" (warning state)
//     Free, at 0         → red link "0/50 → PRO" (clickable to /pricing)
//
// Returns null when quota is undefined so the header can omit the badge
// entirely (cached results pre-quota launch, anonymous traffic without
// identity headers, or API responses where CORS didn't expose the headers).
const QUOTA_WARN_THRESHOLD = 5

function buildQuotaBadge(
  quota?: QuotaStatus,
  installId?: string | null,
): HTMLElement | null {
  if (!quota) return null

  if (quota.tier === "pro" || quota.tier === "yearly" || quota.tier === "lifetime") {
    // Badge text:
    //   "PRO"   = 30-day pass
    //   "YEAR"  = 1-year subscription (replaces "LIFE" as of 2026-05)
    //   "LIFE"  = grandfathered legacy tier — a small minority of users
    //             paid before the rename and keep their forever pass
    const label =
      quota.tier === "lifetime" ? "LIFE" : quota.tier === "yearly" ? "YEAR" : "PRO"
    const fullName =
      quota.tier === "lifetime" ? "Lifetime" : quota.tier === "yearly" ? "Yearly" : "Pro"
    return el(
      "span",
      {
        class: "quota-badge pro",
        title: `${fullName} · Unlimited scans`,
      },
      label,
    )
  }

  // Free tier with unlimited quota (limit=-1): show a plain FREE badge —
  // the count is meaningless when the cap is gone. The Pro-locked features
  // (Critical Flags, Full Analysis, AI Summary) stay locked via separate
  // gating in the UI; quota is now purely a tier label.
  if (quota.limit < 0) {
    return el(
      "span",
      { class: "quota-badge free", title: "Free · Unlimited scans" },
      "FREE",
    )
  }

  // Legacy Free tier with the 50/day cap (kept so cached pre-rollout
  // responses still render gracefully). Same visuals as before.
  const text = `${quota.used}/${quota.limit}`
  const remaining = quota.remaining

  if (remaining === 0) {
    // Limit reached — surface as a clickable link to the pricing page.
    // install_id is baked into href synchronously by the caller (passed
    // in via buildHeaderNode), so the native <a target="_blank"> nav
    // works on a single user-click. Earlier versions wrapped this in
    // an async window.open inside a click handler — that consumed the
    // user-gesture grace before the popup could open and silently got
    // popup-blocked, leaving the link dead.
    const href = installId
      ? `${PRICING_URL}?install=${encodeURIComponent(installId)}`
      : PRICING_URL
    return el(
      "a",
      {
        class: "quota-badge danger",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Daily limit reached — upgrade to Pro for unlimited scans",
      },
      `${text} → PRO`,
    )
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

function buildHeaderNode(
  quota?: QuotaStatus,
  installId?: string | null,
): HTMLElement {
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
  // Legacy quota-exhausted badge — only relevant when a Free user
  // hits the 50/day cap (quota.limit > 0 + remaining === 0). Render
  // it so the "0/50 → PRO" upgrade link still appears in that edge
  // case. For everything else (unlimited Free, Pro, no-quota), the
  // wordmark colour carries the full tier signal.
  const showLegacyCapPill =
    !!quota && !isPro && quota.limit > 0 && quota.remaining === 0
  return el("div", { class: "hd" },
    el("span", {
      class: `brand ${isPro ? "pro" : ""}`.trim(),
      title: tierTitle,
    }, "ANTARES"),
    showLegacyCapPill ? buildQuotaBadge(quota, installId) : null,
    el("div", { class: "hd-right" }, dragIcon, closeBtn),
  )
}

export function buildHeader(): string {
  return buildHeaderNode().outerHTML
}

// Quota-exhausted state — rendered when a Free user has burned through
// their daily 50 scans and the API returns 429 with quota headers
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
  // Showing "117/50" looks broken; users care that they're at the cap,
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
  )

  // Adaptive tick: when more than 2 minutes remain we tick once per
  // minute (matches the displayed precision — "1h 24m"), so the user
  // doesn't see a number sit unchanged for 60s then jump 2). Under
  // 2 minutes we tick every 10s so the final approach to "any moment"
  // feels live without single-digit flashing.
  let timer: ReturnType<typeof setTimeout> | null = null
  function schedule() {
    if (!resetEl.isConnected) {
      if (timer) clearTimeout(timer)
      timer = null
      return
    }
    resetEl.textContent = fmtReset()
    const ms = quota.resetAt ? quota.resetAt - Date.now() : 60_000
    const interval = ms > 120_000 ? 60_000 : 10_000
    timer = setTimeout(schedule, interval)
  }
  timer = setTimeout(schedule, 0)

  return root
}

// Loading-state skeleton injected while a scan is in-flight. Exported as
// a Node so callers can `replaceChildren(buildSkeletonNode())` instead of
// stringifying — keeps the dynamic render path innerHTML-free, matching
// the pattern established in #292 for buildResultNode.
//
// The .skel-slow-hint child carries a CSS animation with `animation-delay: 3s`
// — invisible for the first 3 seconds (typical fast-network responses), then
// fades to "Still loading…" so the user knows the extension isn't stuck on
// slow connections. Once the skeleton is replaced by buildResultNode the
// element disappears and the animation is gone — no JS timer to manage.
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
    el("div", { class: "skel-slow-hint" }, "Still loading…"),
  ))
  return frag
}

/**
 * Error state — rendered when a scan fails after `fetchWithRetry`'s 3 retries
 * (~10.5s total). Replaces the previous silent `display: none` behavior that
 * just made the overlay vanish without explanation. The user now sees:
 *
 *   - A neutral "Connection failed" headline (no all-caps panic)
 *   - A short subtitle explaining what was attempted
 *   - A primary "Retry scan" button that calls `onRetry()` synchronously
 *
 * The header (with brand + close button) is preserved so the user can dismiss
 * the box manually if they don't care to retry.
 *
 * Click reliability: the retry button is a real <button>, not an <a>, so we
 * wire its handler directly. No async indirection, no popup-blocker risk.
 */
export function buildErrorNode(onRetry: () => void): HTMLElement {
  if (state.boxEl) state.boxEl.className = "box caution"

  const retryBtn = el("button", {
    class: "err-retry",
    type: "button",
  }, "Retry scan")

  retryBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    e.preventDefault()
    onRetry()
  })

  return el("div", undefined,
    el("div", { class: "topbar" }),
    buildHeaderNode(undefined),
    el("div", { class: "err-vb" },
      el("div", { class: "err-icon" }, "⚠"),
      el("h2", undefined, "Connection failed"),
      el("div", { class: "err-sub" }, "Couldn't reach the scanner."),
    ),
    retryBtn,
  )
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
export function buildResultNode(
  data: ScanResponseData,
  ca: string,
  installId?: string | null,
): HTMLElement {
  const riskClass = RISK_CLASS[data.risk] || "danger"
  const label = LABELS[data.risk] || data.risk
  const mint = data.resolvedMint || ca
  const liq = data.liquidity ?? data.pair?.liquidity?.usd ?? null

  const score = data.score || 0
  const barW = Math.min(100, Math.round(score / 10))

  const tokenName = data.tokenName || data.pair?.baseToken?.name || ""
  const tokenSymbol = data.tokenSymbol || data.pair?.baseToken?.symbol || ""

  // Watermark renders on every overlay regardless of tier (Free + Pro
  // get the same visual). Driven by .box::after in styles.ts — no
  // tier-gating class needed here.
  if (state.boxEl) state.boxEl.className = `box ${riskClass}`

  const dotsCount = Math.round((score / 1000) * 5)
  const dotsNode = el("div", { class: "dots" },
    ...Array.from({ length: 5 }, (_, i) =>
      el("div", { class: `dt ${i < dotsCount ? "on" : "off"}` }),
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
  const summaryFlags = (data.flags || []).filter((f: ScanResponseFlag) => {
    if (f.severity === "bonus" || f.severity === "info") return false
    if (PIPELINE_STATUS_PATTERN_C.test(f.label)) return false
    return true
  })
  const flagCount = summaryFlags.length
  const critCount = summaryFlags.filter((f: ScanResponseFlag) => f.severity === "critical").length

  // Plain, neutral wording \u2014 never editorialise about data quality. The
  // panel surfaces each flag's actual label so users can read the
  // specifics there. The summary is just a count + critical breakdown.
  let summary = ""
  if (flagCount === 0) summary = "No issues found"
  else if (critCount > 0) summary = `${flagCount} flag${flagCount > 1 ? "s" : ""} \u2014 ${critCount} critical`
  else summary = `${flagCount} flag${flagCount > 1 ? "s" : ""} detected`

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
      "\u26a0 Critical Flags",
      el("span", { class: "lock-pill" }, "PRO"),
    )
  } else {
    cfBtn = el("button", {
      class: "cf-btn",
      id: "ant-critical-flags-btn",
    }, "\u26a0 Critical Flags")
  }
  foNode.appendChild(cfBtn)

  // Full Analysis \u2014 always <a>. For Pro, attachAnalysisBtn binds a
  // chrome.runtime.sendMessage handler (delegates tab creation to the
  // background worker because chrome.tabs.create isn't available in
  // content scripts in MV3). For Free (locked), attachAnalysisBtn
  // skips the rebind, leaving the synchronous href in charge.
  const faBtn = el("a", {
    href: isFree ? upgradeHref : "#",
    id: "ant-full-analysis",
    "data-ca": encodeURIComponent(mint),
    class: isFree ? "locked" : undefined,
    title: isFree ? "Unlock with Pro" : undefined,
    target: isFree ? "_blank" : undefined,
    rel: isFree ? "noopener noreferrer" : undefined,
  }, "Full Analysis \u2192")
  if (isFree) {
    faBtn.appendChild(el("span", { class: "lock-pill" }, "PRO"))
  }
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
      "\u2b21 AI Summary",
      el("span", { class: "lock-pill" }, "PRO"),
    )
  } else {
    aiBtn = el("button", {
      class: "ai-btn ai-btn--active",
      id: "ant-ai-summary-btn",
    }, "\u2b21 AI Summary")
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
    buildHeaderNode(data._quota, installId),
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
    buildAffiliateRow(mint, data.risk, data._quota),
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
