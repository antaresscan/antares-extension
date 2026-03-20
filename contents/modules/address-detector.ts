import { SOL_ADDR, WALKER_LIMIT } from "./constants"
import { state } from "./state"
import { resetState } from "./components"
import { isValid, scan } from "./scanner"

export function findBestAddress(): string {
  if (window.location.hostname.includes("photon") && !window.location.pathname.includes("/lp/")) return ""
  const scores = new Map<string, number>()
  const url    = window.location.href
  const add    = (addr: string, pts: number) => { if (!isValid(addr)) return; scores.set(addr, (scores.get(addr) || 0) + pts) }
  for (const el of document.querySelectorAll("[data-address],[data-token],[data-mint],[data-ca],[data-contract],[data-token-address],[data-mint-address]")) {
    for (const attr of ["data-address","data-token","data-mint","data-ca","data-contract","data-token-address","data-mint-address"]) {
      for (const m of ((el.getAttribute(attr) || "").match(SOL_ADDR) || [])) add(m, 200)
    }
  }
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || ""
    if (/solscan\.io\/token|solscan\.io\/address|explorer\.solana\.com\/address|solana\.fm\/address/.test(href)) {
      for (const m of (href.match(SOL_ADDR) || [])) add(m, 180)
    }
  }
  for (const m of (url.match(SOL_ADDR) || [])) add(m, 60)
  if (scores.size === 0) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
    let node: Node | null, count = 0
    while ((node = walker.nextNode()) && count < WALKER_LIMIT) {
      count++
      const t = (node.textContent || "").trim()
      if (t.length >= 32 && t.length <= 50) { for (const m of (t.match(SOL_ADDR) || [])) add(m, 120) }
    }
  }
  if (scores.size === 0) return ""
  for (const [addr, s] of scores) {
    if (addr.endsWith("pump")) scores.set(addr, s + 100)
    if (/[A-Z]/.test(addr) && /[a-z]/.test(addr)) scores.set(addr, (scores.get(addr) || 0) + 30)
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

export function poll() { const ca = findBestAddress(); if (!ca) return; void scan(ca) }

export function onNav() {
  const curPath = window.location.pathname
  const pathChanged = curPath !== state.lastNavPath
  state.lastNavPath = curPath

  if (state.navDebounce) clearTimeout(state.navDebounce)
  state.navDebounce = setTimeout(() => {
    state.navDebounce = null
    if (pathChanged) {
      resetState()
    }
    poll()
  }, 500)
}

export function setupNavListeners() {
  state.lastUrl = window.location.href
  new MutationObserver(() => {
    const cur = window.location.href
    if (cur !== state.lastUrl) { state.lastUrl = cur; onNav() }
  }).observe(document.documentElement, { childList: true, subtree: true })

  const _push    = history.pushState.bind(history)
  const _replace = history.replaceState.bind(history)
  history.pushState    = (...args) => { _push(...args);    onNav() }
  history.replaceState = (...args) => { _replace(...args); onNav() }
  window.addEventListener("popstate", onNav)
}
