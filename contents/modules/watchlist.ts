// contents/modules/watchlist.ts — toggleable watchlist panel for the overlay.
//
// Mirrors the structure of ai-summary.ts and critical-flags.ts: a single
// `toggleWatchlist(ca)` function the footer button calls, mutex with the
// sibling AI/Flags panels, all DOM construction via createElement +
// textContent so user-controlled token addresses cannot become an HTML
// injection vector.
//
// Unlike the AI/Flags panels (static content, render once), watchlist is
// fully dynamic:
//   - Every open re-fetches GET /api/watchlist (state can have changed
//     across rescans or concurrent tabs)
//   - "Add this token" issues POST, then re-renders the list
//   - Per-item "✕" issues DELETE, then re-renders the list
//   - Free tier limit_reached (402) flips the add button to an upgrade link
//
// The list ZSET is bounded (free 5 / pro 50), so we never paginate.

import { state } from "./state"
import { getInstallId } from "../../shared/install-id"
import { logger } from "../../shared/logger"
import { WATCHLIST_API, PRICING_URL } from "./constants"

interface WatchlistItem {
  address: string
  addedAt: number
}

interface WatchlistResponse {
  items: WatchlistItem[]
  count: number
  max: number
  tier: "free" | "pro" | "lifetime"
}

interface AddResponse {
  added?: boolean
  count?: number
  max?: number
  reason?: "already_present" | "limit_reached"
  tier?: string
}

// ── DOM helpers (textContent-only — no HTML interpretation) ──────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | undefined>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) node.setAttribute(k, v)
    }
  }
  if (text != null) node.textContent = text
  return node
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

// ── Network ──────────────────────────────────────────────────────────────────

async function fetchWatchlist(installId: string): Promise<WatchlistResponse | null> {
  try {
    const res = await fetch(WATCHLIST_API, {
      method: "GET",
      headers: { "X-Antares-Install": installId },
    })
    if (!res.ok) {
      logger.warn("watchlist", "GET failed", { status: res.status })
      return null
    }
    const raw: unknown = await res.json()
    if (!raw || typeof raw !== "object") return null
    const o = raw as Record<string, unknown>
    if (!Array.isArray(o.items)) return null
    return o as unknown as WatchlistResponse
  } catch (err) {
    logger.warn("watchlist", "GET network error", err)
    return null
  }
}

async function postAdd(installId: string, address: string): Promise<{ status: number; body: AddResponse }> {
  try {
    const res = await fetch(WATCHLIST_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Antares-Install": installId,
      },
      body: JSON.stringify({ address }),
    })
    const raw: unknown = await res.json().catch(() => ({}))
    const body =
      raw && typeof raw === "object"
        ? (raw as AddResponse)
        : ({} as AddResponse)
    return { status: res.status, body }
  } catch (err) {
    logger.warn("watchlist", "POST network error", err)
    return { status: 0, body: {} }
  }
}

async function deleteItem(installId: string, address: string): Promise<boolean> {
  try {
    const url = `${WATCHLIST_API}?address=${encodeURIComponent(address)}`
    const res = await fetch(url, {
      method: "DELETE",
      headers: { "X-Antares-Install": installId },
    })
    return res.ok
  } catch (err) {
    logger.warn("watchlist", "DELETE network error", err)
    return false
  }
}

// ── Renderers ────────────────────────────────────────────────────────────────

function renderHeader(panel: HTMLElement, data: WatchlistResponse | null): void {
  const head = el("div", { class: "wl-head" })

  head.appendChild(el("span", { class: "wl-title" }, "Watchlist"))

  if (!data) {
    head.appendChild(el("span", { class: "wl-meta" }, "—"))
    panel.appendChild(head)
    return
  }

  const tierLabel =
    data.tier === "lifetime" ? "Lifetime" : data.tier === "pro" ? "Pro" : "Free"
  const meta = el("span", { class: "wl-meta" }, `${tierLabel} · ${data.count}/${data.max}`)
  if (data.tier === "free" && data.count >= data.max) {
    meta.classList.add("wl-meta-limit")
  }
  head.appendChild(meta)

  panel.appendChild(head)
}

function renderAddBtn(
  panel: HTMLElement,
  ca: string,
  isWatched: boolean,
  data: WatchlistResponse | null,
  reload: () => void,
): void {
  if (isWatched) {
    const btn = el("button", { class: "wl-add wl-add-watched", type: "button" }, "✓ Watching · Remove")
    btn.addEventListener("click", async () => {
      btn.disabled = true
      btn.textContent = "..."
      const installId = await getInstallId()
      if (!installId) {
        btn.textContent = "✗ Anonymous"
        return
      }
      const ok = await deleteItem(installId, ca)
      if (ok) reload()
      else {
        btn.textContent = "✗ Failed"
        btn.disabled = false
      }
    })
    panel.appendChild(btn)
    return
  }

  // Limit-reached path: convert into an upgrade CTA *before* the user
  // clicks. Avoids the disappointing "click → error" cycle.
  if (data && data.tier === "free" && data.count >= data.max) {
    const btn = el(
      "a",
      {
        class: "wl-add wl-add-limit",
        href: PRICING_URL,
        target: "_blank",
        rel: "noopener noreferrer",
      },
      "Limit reached → Upgrade to Pro for 50 slots",
    )
    btn.addEventListener("click", (e) => {
      e.preventDefault()
      void getInstallId().then((installId) => {
        const url = installId
          ? `${PRICING_URL}?install=${encodeURIComponent(installId)}`
          : PRICING_URL
        window.open(url, "_blank", "noopener noreferrer")
      })
    })
    panel.appendChild(btn)
    return
  }

  // Default add path
  const btn = el("button", { class: "wl-add", type: "button" }, "+ Add this token")
  btn.addEventListener("click", async () => {
    btn.disabled = true
    btn.textContent = "..."
    const installId = await getInstallId()
    if (!installId) {
      btn.textContent = "✗ Anonymous · install id required"
      return
    }
    const result = await postAdd(installId, ca)
    if (result.status === 200 && result.body.added) {
      reload()
      return
    }
    if (result.status === 200 && result.body.reason === "already_present") {
      reload()
      return
    }
    if (result.status === 402) {
      reload() // re-fetch — count should now show 5/5 with limit CTA
      return
    }
    btn.textContent = "✗ Failed"
    btn.disabled = false
  })
  panel.appendChild(btn)
}

function renderList(
  panel: HTMLElement,
  data: WatchlistResponse,
  reload: () => void,
): void {
  if (data.items.length === 0) {
    panel.appendChild(el("div", { class: "wl-empty" }, "No tokens yet"))
    return
  }

  const ul = el("ul", { class: "wl-list" })
  // Newest first feels more useful — "what was I just watching"
  const sorted = [...data.items].sort((a, b) => b.addedAt - a.addedAt)
  for (const item of sorted) {
    const li = el("li", { class: "wl-row" })

    const addrSpan = el("span", { class: "wl-addr", title: item.address }, shortAddr(item.address))
    li.appendChild(addrSpan)

    const ageSpan = el("span", { class: "wl-age" }, timeAgo(item.addedAt))
    li.appendChild(ageSpan)

    const removeBtn = el(
      "button",
      { class: "wl-remove", type: "button", "aria-label": "Remove from watchlist" },
      "✕",
    )
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true
      removeBtn.textContent = "..."
      const installId = await getInstallId()
      if (!installId) {
        removeBtn.textContent = "!"
        return
      }
      const ok = await deleteItem(installId, item.address)
      if (ok) reload()
      else {
        removeBtn.textContent = "!"
        removeBtn.disabled = false
      }
    })
    li.appendChild(removeBtn)

    ul.appendChild(li)
  }
  panel.appendChild(ul)
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Open or close the watchlist panel for the given current token.
 * Mutex with the AI / Critical Flags panels (matches their existing
 * behaviour — only one expands the overlay at a time).
 */
export function toggleWatchlist(ca: string): void {
  const panel = state.shadow?.querySelector("#ant-watchlist") as HTMLElement | null
  if (!panel) return

  const isOpen = panel.classList.contains("open")
  if (isOpen) {
    panel.classList.remove("open")
    return
  }

  // Mutex: close any sibling panel first
  const aiPanel = state.shadow?.querySelector("#ant-ai-summary") as HTMLElement | null
  const cfPanel = state.shadow?.querySelector("#ant-critical-flags") as HTMLElement | null
  aiPanel?.classList.remove("open")
  cfPanel?.classList.remove("open")

  panel.classList.add("open")
  void load(panel, ca)
}

async function load(panel: HTMLElement, ca: string): Promise<void> {
  // Render a placeholder while the fetch is in flight so the panel
  // never appears empty / broken to the user.
  panel.replaceChildren()
  panel.appendChild(el("div", { class: "wl-loading" }, "Loading…"))

  const installId = await getInstallId()
  if (!installId) {
    panel.replaceChildren()
    panel.appendChild(el("div", { class: "wl-empty" }, "Install ID not detected — try again in a few seconds."))
    return
  }

  const data = await fetchWatchlist(installId)
  panel.replaceChildren()

  if (!data) {
    panel.appendChild(el("div", { class: "wl-empty" }, "Watchlist unavailable. Check connection and retry."))
    return
  }

  const reload = (): void => {
    void load(panel, ca)
  }

  renderHeader(panel, data)

  const isWatched = data.items.some((item) => item.address === ca)
  renderAddBtn(panel, ca, isWatched, data, reload)

  panel.appendChild(el("div", { class: "wl-divider" }))
  renderList(panel, data, reload)
}
