// scripts/overlay-alignment.mjs
//
// CI guard for the overlay's "Sell / Mint / Freeze / LP lock / Liq" row, in a REAL browser.
//
// The row is five small cells: three check marks, a cross or a dash, and the liquidity figure. They are drawn with different techniques (borders rotated
// into a tick, two bars crossed into an X, a Bebas Neue figure, a dash), each pushed by a fraction of a pixel, and a change to any one of them moves it
// off the line of the others: the figure sat 2 px above the ticks and 4 px above the cross until #919. The unit tests only read the CSS text, they cannot
// see that. This script renders the REAL overlay (scanner + components + styles, bundled unchanged) in Chromium and MEASURES the ink of every mark.
//
// For every combination of verdict (SAFE / CAUTION / DANGER / RUG), plan (Free / Pro), liquidity (none, under $1K, red, white, green, millions, billions) and
// state of the checks (all clear, LP open / locked, mint active, freeze + honeypot, unknown, issuer asset, "Limited data") it asserts that
//   1. the five marks share one line: the vertical centres of their ink are within TOLERANCE_PX of each other;
//   2. the liquidity figure and every label are set in Bebas Neue (computed style) and that font is actually LOADED in the page, not a fallback;
//   3. the figure is in the figure's own class (`liq`, or `dash` when no liquidity could be read), whatever its colour.
// It repeats a reduced sweep at the usual screen scalings (100 % to 300 %, a phone, and 8x for hair-line precision) and with a host page that sets aggressive typography
// (the shadow host resets it with `all: initial`: this proves the reset holds). The sweeps run side by side, in separate pages.
//
// The two panels under the card (Critical Flags, AI Summary) are checked the same way, at the usual screen scalings: every text in them is Bebas Neue (weight 400, no italic), the
// round marks are exact circles (the number of a section: 16 x 16 px, a pill only from two digits; the cross, !, i and tick: 14 x 14 px) and the ink of each one sits on the
// centre of its circle. They were oval, and drawn by whichever font the page fell back to.
//
// Run: `npm run overlay:check` (a Chromium is needed: `npx playwright install chromium`). Locally set OVERLAY_CHROMIUM to the path of a Chromium or Chrome
// binary to use one that is already installed. Exit code 1 on any failure, with the failing combinations printed.
// Debugging aids: --quick (a reduced matrix), OVERLAY_SKIP_FULL=1 (only the scaling sweeps), OVERLAY_DSFS=1,2 (choose the scalings), OVERLAY_TOL / OVERLAY_TOL_FRACTIONAL (the
// limits), OVERLAY_SHOTS=<dir> (keep the measured row of every render as a PNG), OVERLAY_DUMP=<file> (write the bundled overlay and stop: it can be loaded in any page).

import { build } from "esbuild"
import { chromium } from "@playwright/test"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CA = "So1anaTokenAddressForTests11111111111111111"
// The measured spread on master is 0.13 px at 8x and 0.5 px at the usual scalings; the bug it guards against was 2 px (up to 3.9 px between the figure and
// the cross). 0.75 px keeps a margin for a browser update that moves a glyph by a fraction of a pixel and still fails on any real misalignment.
const TOLERANCE_PX = Number(process.env.OVERLAY_TOL ?? 0.75)
// At a fractional scaling (125 %, 150 %, 175 %, 225 %...) every drawn shape and every glyph is rounded to whole device pixels on its own: two identical ticks side by side already
// differ by 0.4 px, a tilted cross and a straight bar by up to 1 px. The limit is therefore strict where the measurement is clean (1x, 2x, 3x, 8x) and a little wider on the fractional
// scalings, which are there to catch an offset that only shows up at one of them. The bug this guards against is 2 px, and was 2 px at every scaling.
const FRACTIONAL_TOLERANCE_PX = Number(process.env.OVERLAY_TOL_FRACTIONAL ?? 1.1)
const tolFor = (dsf) => (Number.isInteger(dsf) ? TOLERANCE_PX : Math.max(TOLERANCE_PX, FRACTIONAL_TOLERANCE_PX))
const QUICK = process.argv.includes("--quick")
// OVERLAY_SHOTS=<dir>: keep the measured row of every render as a PNG (to look at what was measured).
const SHOTS = process.env.OVERLAY_SHOTS
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

// ── The overlay, bundled unchanged, with the browser APIs it needs stubbed ───────────────────────────────────────────────────────────────────────
const STUB = `
const store = new Map();
const local = {
  get: (keys, cb) => { const list = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys]; const out = {}; for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k)); cb(out); },
  set: (items, cb) => { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); cb && cb(); },
  remove: (keys, cb) => { for (const k of [].concat(keys)) store.delete(k); cb && cb(); },
};
window.chrome = { storage: { local }, runtime: { lastError: undefined, sendMessage: (m, cb) => { cb && cb({ ok: true }); return Promise.resolve(); } } };
let nextBody = null, nextTier = "free";
window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(nextBody),
  headers: new Headers({ "X-Antares-Quota-Tier": nextTier, "X-Antares-Quota-Used": "3", "X-Antares-Quota-Limit": "-1", "X-Antares-Quota-Remaining": "-1", "X-Antares-Quota-Reset": "0" }) });
window.__stub = { setScan: (body, tier) => { nextBody = body; nextTier = tier; }, clear: () => store.clear() };
`
const ENTRY = `
import "virtual:stub"
import { scan } from "./contents/modules/scanner"
import { state, scanCache, resetSourceGap } from "./contents/modules/state"
window.__overlay = {
  scan,
  reset: () => {
    scanCache.clear(); resetSourceGap(); window.__stub.clear() // the scan result is also cached in chrome.storage: a second card would otherwise be the first one again
    document.documentElement.querySelector("#antares-host")?.remove()
    Object.assign(state, { host: null, shadow: null, boxEl: null, lastCA: "", manuallyDismissed: false })
  },
  // The shadow root is CLOSED: only the reference the extension itself holds reaches it.
  ready: () => state.shadow?.querySelector(".ss") != null,
  // The card slides in (a .2 s transition on the box): measure only once the row has stopped moving. The transitions are switched off for the measurement, they move the card
  // as a whole and have nothing to do with the alignment of the marks inside the row.
  settle: async () => {
    const sh = state.shadow
    if (sh && !sh.querySelector("#alignment-no-motion")) {
      const s = document.createElement("style"); s.id = "alignment-no-motion"; s.textContent = "*,*::before,*::after{transition:none !important}"; sh.appendChild(s)
    }
    let last = "", same = 0
    for (let i = 0; i < 180 && same < 4; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      const r = sh?.querySelector(".ss")?.getBoundingClientRect()
      const k = r ? [r.x, r.y, r.width, r.height].join(",") : ""
      same = k === last ? same + 1 : 0
      last = k
    }
  },
  cells: () => [...(state.shadow?.querySelectorAll(".ss .si") ?? [])].map((cell) => {
    const b = cell.querySelector("b"), span = cell.querySelector("span")
    const r = b.getBoundingClientRect()
    return {
      label: (span?.textContent ?? "").trim(), text: (b.textContent ?? "").trim(), cls: b.className,
      font: getComputedStyle(b).fontFamily, size: getComputedStyle(b).fontSize, labelFont: span ? getComputedStyle(span).fontFamily : "",
      x: r.x, y: r.y, w: r.width, h: r.height,
    }
  }),
  row: () => { const r = state.shadow.querySelector(".ss").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } },
  // The two panels under the card. Opening one is the click the user makes; the panel scrolls after 140 px, so it is unfolded to put every mark on screen, and the card is moved
  // to the top of the page so that nothing is cut by the bottom of the window.
  openPanel: (which) => {
    state.shadow.querySelector(which === "cf" ? "#ant-critical-flags-btn" : "#ant-ai-summary-btn").click()
    const s = document.createElement("style"); s.textContent = ".cf-panel-inner,.ai-panel-inner{max-height:none !important;overflow:visible !important}"; state.shadow.appendChild(s)
    const h = document.getElementById("antares-host"); h.style.transform = "translate(" + h.getBoundingClientRect().x + "px, 10px)"
  },
  panelMarks: () => [...state.shadow.querySelectorAll("#ant-critical-flags .cf-section-count, #ant-critical-flags .cf-flag-icon")].map((e) => {
    const r = e.getBoundingClientRect()
    return { kind: e.className.indexOf("cf-section-count") >= 0 ? "count" : "mark", text: (e.textContent || "").trim(), x: r.x, y: r.y, w: r.width, h: r.height }
  }),
  panelText: (id) => [...state.shadow.querySelectorAll("#" + id + " *")]
    .filter((e) => e.className.indexOf("cf-flag-icon") < 0 && [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent || "").trim() !== ""))
    .map((e) => { const cs = getComputedStyle(e); return { cls: e.className, family: cs.fontFamily, weight: cs.fontWeight, style: cs.fontStyle } }),
}
`
const plugin = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^virtual:stub$/ }, () => ({ path: "stub", namespace: "stub" }))
    b.onResolve({ filter: /^data-base64:/ }, () => ({ path: "icon", namespace: "icon" }))
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: STUB, loader: "js" }))
    b.onLoad({ filter: /.*/, namespace: "icon" }, () => ({ contents: 'export default "data:image/png;base64,iVBORw0KGgo="', loader: "js" }))
  },
}
async function bundle() {
  const res = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "overlay-alignment-entry.ts", loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "browser", logLevel: "error", plugins: [plugin],
    define: {
      "process.env.NODE_ENV": '"production"', "process.env.PLASMO_PUBLIC_SENTRY_DSN": "undefined", "process.env.PLASMO_PUBLIC_PHOTON_REF": "undefined",
      "process.env.PLASMO_PUBLIC_API_URL": "undefined", "process.env.PLASMO_PUBLIC_API_BASE": "undefined", "process.env.PLASMO_PUBLIC_ANALYSIS_URL": "undefined",
    },
  })
  return res.outputFiles[0].text
}

// ── The combinations ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const VERDICTS = [["SAFE", 920], ["CAUTION", 800], ["DANGER", 500], ["RUG", 100]]
const TIERS = ["free", "pro"]
// liquidity → the colour class the figure gets: none (dash), n (< $5K), white (between), y (> $50K)
const LIQUIDITIES = [null, 999, 3000, 40_400, 120_000, 4_360_000, 1_250_000_000]
const FACTS = {
  "all clear": { lpBurned: true },
  "LP open": { lpBurned: false, lpLocked: false },
  "LP locked": { lpBurned: false, lpLocked: true },
  "mint active": { mintAuthority: true },
  "freeze + honeypot": { freezeAuthority: true, honeypot: true },
  "unknown checks": { mintAuthority: null, freezeAuthority: null, honeypot: null, lpBurned: null, lpLocked: null },
  "issuer asset": { issuerKind: "stablecoin" },
  "limited data": { degraded: true, sourceGap: true, freshForSec: 30, staleLeftSec: 0 },
}
const body = (risk, score, liq, facts) => ({
  score, risk, pair: null, resolvedMint: CA, confidence: 90, sources_used: ["dexscreener", "helius"], holders: 3754, marketCap: 172_000, priceUsd: 0.0001809,
  liquidity: liq, tokenSymbol: "TKN", tokenName: "Token", lpBurned: true, lpLocked: false, safeBlocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false,
  freshForSec: 300, staleLeftSec: 1200, fetchedAt: Date.now(), aiSummary: "A summary.",
  flags: risk === "SAFE" ? [] : [{ label: "A critical flag", severity: "critical", impact: 30 }, { label: "A warning", severity: "warning", impact: 10 }],
  ...facts,
})

// ── The measurement ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Ink of one cell = the rows of pixels that differ from the cell's own background, inside the mark's box (± 3 px). Decoded in the page, from the screenshot.
async function inkRows(page, shotB64, clip, dsf, cells) {
  return page.evaluate(async ([b64, clip, dsf, cells]) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode()
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0)
    return cells.map((cell) => {
      const x0 = Math.max(0, Math.floor((cell.x - clip.x) * dsf)), y0 = Math.max(0, Math.floor((cell.y - clip.y - 3) * dsf))
      const w = Math.min(img.width - x0, Math.ceil(cell.w * dsf)), h = Math.min(img.height - y0, Math.ceil((cell.h + 6) * dsf))
      if (w <= 0 || h <= 0) return null
      const d = g.getImageData(x0, y0, w, h).data, bg = [d[0], d[1], d[2]]
      let top = -1, bot = -1
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 90) { if (top < 0) top = y; bot = y }
      }
      return top < 0 ? null : { top: (y0 + top) / dsf + clip.y, bot: (y0 + bot + 1) / dsf + clip.y }
    })
  }, [shotB64, clip, dsf, cells])
}

const HOSTILE = "html{font-size:23px;line-height:2.4;letter-spacing:.12em;word-spacing:7px;font-family:Times,serif;text-transform:uppercase}body{margin:0;zoom:1}*{box-sizing:content-box}"
const failures = []
let renders = 0, worstSpread = 0, worstWhere = ""
let panelChecks = 0, panelWorst = 0, panelWorstWhere = ""
const colourClass = (liq) => (liq === null ? "dash" : liq < 5000 ? "liq n" : liq > 50_000 ? "liq y" : "liq")

async function sweep(browser, js, { name, dsf, tiers, verdicts, liquidities, facts, hostile }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: dsf })
  await context.route("**/*", (r) => (/^(data|about):/.test(r.request().url()) ? r.continue() : r.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" })))
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)))
  await page.setContent(`<!doctype html><html><head><title>host</title>${hostile ? `<style>${HOSTILE}</style>` : ""}</head><body style="background:#0e1014;height:2000px"></body></html>`)
  await page.addScriptTag({ content: js })
  let fontChecked = false
  for (const tier of tiers) for (const [risk, score] of verdicts) for (const [factName, facts_] of facts) for (const liq of liquidities) {
    const where = `${name} | ${tier} | ${risk} | ${factName} | liq ${liq === null ? "none" : liq}`
    renders++
    try {
      await page.evaluate(() => window.__overlay.reset())
      await page.evaluate(async ([b, t, ca]) => { window.__stub.setScan(b, t); await window.__overlay.scan(ca) }, [body(risk, score, liq, facts_), tier, CA])
      await page.waitForFunction(() => window.__overlay.ready(), null, { timeout: 15_000 })
      await page.evaluate(() => window.__overlay.settle())
      if (!fontChecked) {
        const loaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => /Bebas Neue/.test(f.family) && f.status === "loaded").length })
        if (loaded === 0) failures.push(`${where}: Bebas Neue is not loaded in the page (the overlay would draw in a fallback font)`)
        fontChecked = true
      }
      const cells = await page.evaluate(() => window.__overlay.cells())
      const row = await page.evaluate(() => window.__overlay.row())
      const clip = { x: row.x - 4, y: row.y - 6, width: row.w + 8, height: row.h + 12 }
      const shot = (await page.screenshot({ clip })).toString("base64")
      const ink = await inkRows(page, shot, clip, dsf, cells)
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, where.replace(/[^A-Za-z0-9.]+/g, "_") + ".png"), Buffer.from(shot, "base64"))
      if (cells.length !== 5) { failures.push(`${where}: the row has ${cells.length} cells, not 5`); continue }
      const centres = ink.map((i) => (i ? (i.top + i.bot) / 2 : NaN))
      const missing = centres.map((c, k) => (Number.isNaN(c) ? cells[k].label : null)).filter(Boolean)
      if (missing.length) { failures.push(`${where}: nothing drawn in ${missing.join(", ")}`); continue }
      const spread = Math.max(...centres) - Math.min(...centres)
      if (spread > worstSpread) { worstSpread = spread; worstWhere = where }
      if (spread > tolFor(dsf)) {
        const detail = cells.map((c, k) => `${c.label || "?"} ${(centres[k] - centres[0] >= 0 ? "+" : "") + (centres[k] - centres[0]).toFixed(2)}`).join(", ")
        failures.push(`${where}: the five marks are ${spread.toFixed(2)} px apart (limit ${tolFor(dsf)}) [${detail}, relative to Sell]`)
      }
      const figure = cells[4]
      if (figure.label.toLowerCase() !== "liq") failures.push(`${where}: the last cell is "${figure.label}", not Liq`)
      if (figure.cls !== colourClass(liq)) failures.push(`${where}: the figure has class "${figure.cls}", expected "${colourClass(liq)}"`)
      if (liq !== null && !/Bebas Neue/.test(figure.font)) failures.push(`${where}: the liquidity figure is set in ${figure.font}, not Bebas Neue`)
      if (liq !== null && figure.size !== "11px") failures.push(`${where}: the liquidity figure is ${figure.size}, not 11px`)
      for (const c of cells) if (!/Bebas Neue/.test(c.labelFont)) failures.push(`${where}: the label "${c.label}" is set in ${c.labelFont}, not Bebas Neue`)
    } catch (e) {
      failures.push(`${where}: ${String(e.message || e).split("\n")[0]}`)
    }
  }
  if (pageErrors.length) failures.push(`${name}: page errors: ${pageErrors.slice(0, 2).join(" | ")}`)
  await context.close()
}

// ── The two panels under the card ──────────────────────────────────────────────────────
// A card with every kind of flag (one section of ten warnings, so that a count has two digits), Pro (the panels are the Pro buttons), a CAUTION verdict (which shows the info and
// the bonus sections).
const PANEL_BODY = {
  ...body("CAUTION", 800, 40_400, { lpBurned: true }),
  flags: [
    { label: "Mint Authority enabled", severity: "critical", impact: 40 },
    ...Array.from({ length: 10 }, (_, i) => ({ label: i ? "Sniper activity detected " + i : "Liquidity < $50k", severity: "warning", impact: 5 })),
    { label: "Top 10 hold 38%", severity: "info", impact: 0 },
    { label: "LP Burned ✓", severity: "bonus", impact: 0 },
  ],
  aiSummary: "A first sentence that gives the verdict. A second one with a detail. A third one to finish.",
}
// Where the ink of a mark sits relative to the centre of its own circle (or pill), in CSS px: the pixels that differ from the fill of the element, inside its shape.
async function inkCentre(page, b64, g, dsf, pad) {
  return page.evaluate(async ([b64, g, dsf, pad]) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode()
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, img.width, img.height).data
    const px = (x, y) => { const k = (Math.round(y) * img.width + Math.round(x)) * 4; return [d[k], d[k + 1], d[k + 2]] }
    const cx = (pad + g.w / 2) * dsf, cy = (pad + g.h / 2) * dsf, R = (g.h / 2) * dsf, straight = Math.max(0, (g.w / 2) * dsf - R)
    const fill = px((pad + 2.2) * dsf, cy)
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      if (Math.hypot(Math.max(0, Math.abs(x - cx) - straight), y - cy) > R - 1.2 * dsf) continue // inside the shape, away from its anti-aliased edge
      const p = px(x, y)
      if (Math.abs(p[0] - fill[0]) + Math.abs(p[1] - fill[1]) + Math.abs(p[2] - fill[2]) > 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    }
    return x1 < 0 ? null : { dx: ((x0 + x1 + 1) / 2 - cx) / dsf, dy: ((y0 + y1 + 1) / 2 - cy) / dsf }
  }, [b64, g, dsf, pad])
}

const once = (message) => { if (!failures.includes(message)) failures.push(message) } // (a panel of ten flags would otherwise report the same font ten times)
async function panelSweep(browser, js, { name, dsf }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1800 }, deviceScaleFactor: dsf })
  await context.route("**/*", (r) => (/^(data|about):/.test(r.request().url()) ? r.continue() : r.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" })))
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)))
  await page.setContent('<!doctype html><html><head><title>host</title></head><body style="background:#0e1014;height:2000px"></body></html>')
  await page.addScriptTag({ content: js })
  const open = async (which) => {
    await page.evaluate(() => window.__overlay.reset())
    await page.evaluate(async ([b, ca]) => { window.__stub.setScan(b, "pro"); await window.__overlay.scan(ca) }, [PANEL_BODY, CA])
    await page.waitForFunction(() => window.__overlay.ready(), null, { timeout: 15_000 })
    await page.evaluate(() => window.__overlay.settle())
    await page.evaluate((w) => window.__overlay.openPanel(w), which)
    await page.waitForTimeout(250)
  }
  try {
    // 1. every text of both panels is Bebas Neue, weight 400, not italic (Bebas Neue has neither: the browser would fake them)
    for (const [which, id] of [["cf", "ant-critical-flags"], ["ai", "ant-ai-summary"]]) {
      await open(which)
      const texts = await page.evaluate((id) => window.__overlay.panelText(id), id)
      if (texts.length < 3) failures.push(`${name} | ${id}: only ${texts.length} text(s) found in the panel (the check is blind)`)
      for (const t of texts) {
        if (!/^["']?Bebas Neue/.test(t.family)) once(`${name} | ${id} | .${t.cls}: set in ${t.family}, not Bebas Neue`)
        if (t.weight !== "400") once(`${name} | ${id} | .${t.cls}: weight ${t.weight}, Bebas Neue has only 400`)
        if (t.style !== "normal") once(`${name} | ${id} | .${t.cls}: ${t.style}, Bebas Neue has no italic`)
      }
    }
    // 2. the round marks of the Critical Flags panel: exact circles, ink on their centre
    await open("cf")
    const marks = await page.evaluate(() => window.__overlay.panelMarks())
    if (marks.length < 12) failures.push(`${name}: only ${marks.length} round marks found in the Critical Flags panel (the check is blind)`)
    const seen = new Set()
    const tol = Math.max(tolFor(dsf), dsf < 2 ? 1.1 : 0)
    for (const g of marks) {
      const where = `${name} | ${g.kind} "${g.text}"`
      if (g.kind === "count") {
        if (g.text.length === 1 && Math.abs(g.w - g.h) > 0.05) once(`${where}: the circle is ${g.w.toFixed(2)} x ${g.h.toFixed(2)} px, an oval`)
        if (g.h !== 16) once(`${where}: ${g.h} px high, not 16`)
      } else if (Math.abs(g.w - 14) > 0.05 || Math.abs(g.h - 14) > 0.05) once(`${where}: ${g.w.toFixed(2)} x ${g.h.toFixed(2)} px, not 14 x 14`)
      const key = g.kind + g.text + g.w.toFixed(1)
      if (seen.has(key)) continue
      seen.add(key)
      const pad = 3
      const shot = (await page.screenshot({ clip: { x: g.x - pad, y: g.y - pad, width: g.w + pad * 2, height: g.h + pad * 2 } })).toString("base64")
      const ink = await inkCentre(page, shot, g, dsf, pad)
      if (!ink) { failures.push(`${where}: nothing drawn in the circle`); continue }
      const limit = g.kind === "count" ? Math.max(tol, 1.0) : tol
      if (Math.abs(ink.dx) > limit || Math.abs(ink.dy) > limit) failures.push(`${where}: the ink is ${ink.dx.toFixed(2)} px right and ${ink.dy.toFixed(2)} px down of the centre of its circle (limit ${limit})`)
      const off = Math.max(Math.abs(ink.dx), Math.abs(ink.dy)); if (off > panelWorst) { panelWorst = off; panelWorstWhere = where }
    }
    panelChecks += marks.length
  } catch (e) {
    failures.push(`${name}: ${String(e.message || e).split("\n")[0]}`)
  }
  if (pageErrors.length) failures.push(`${name}: page errors: ${pageErrors.slice(0, 2).join(" | ")}`)
  await context.close()
}

async function launch() {
  const executablePath = process.env.OVERLAY_CHROMIUM || undefined
  return chromium.launch({ executablePath })
}

const js = await bundle()
if (process.env.OVERLAY_DUMP) { (await import("node:fs")).writeFileSync(process.env.OVERLAY_DUMP, js); console.log("bundle written to", process.env.OVERLAY_DUMP); process.exit(0) }
const browser = await launch()
const t0 = Date.now()
const factsOf = (...names) => names.map((n) => [n, FACTS[n]])
const jobs = []
// 1. The full matrix at 2x (a quarter of a pixel of precision), one job per verdict.
if (!process.env.OVERLAY_SKIP_FULL) {
  for (const v of VERDICTS) jobs.push({ name: `2x ${v[0]}`, dsf: 2, tiers: ["pro"], verdicts: [v], liquidities: QUICK ? [null, 3000, 40_400, 120_000] : LIQUIDITIES, facts: Object.entries(FACTS), hostile: false })
  // The plan only changes the three footer buttons: the Free card is checked on the states that matter, not crossed with every combination.
  jobs.push({ name: "2x free", dsf: 2, tiers: ["free"], verdicts: VERDICTS, liquidities: [null, 3000, 40_400, 120_000], facts: factsOf("all clear", "limited data"), hostile: false })
}
// 2. A reduced sweep at the usual screen scalings and at 8x (hair-line precision).
const reduced = { tiers: ["pro"], verdicts: [VERDICTS[0], VERDICTS[2]], liquidities: [null, 3000, 40_400, 120_000], facts: factsOf("all clear", "LP open", "issuer asset", "limited data") }
// Windows scalings 100 / 125 / 150 / 175 / 200 / 225 / 250 / 300 %, a phone (2.625), and 8x for hair-line precision. A glyph and a drawn shape are rounded to whole device pixels differently at
// every fractional scaling, which is why each one is measured (the dash was a glyph and landed one device pixel off the line at 150 %).
const DSFS = process.env.OVERLAY_DSFS ? process.env.OVERLAY_DSFS.split(",").map(Number) : QUICK ? [1, 1.25, 1.5] : [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.625, 3, 8]
for (const dsf of DSFS) jobs.push({ name: `${dsf}x`, dsf, ...reduced, hostile: false })
// 3. A host page with aggressive typography (the shadow host resets it).
jobs.push({ name: "hostile host page", dsf: 2, ...reduced, hostile: true })
// 4. The two panels under the card (fonts, round marks), at the same screen scalings.
for (const dsf of DSFS) jobs.push({ name: `panels ${dsf}x`, dsf, panels: true })
// The jobs run side by side (each in its own page): the measurement waits for animation frames, so it is the waiting that is shared out.
const POOL = Math.max(2, Math.min(4, os.availableParallelism?.() ?? 2))
let next = 0
await Promise.all(Array.from({ length: POOL }, async () => { while (next < jobs.length) { const job = jobs[next++]; await (job.panels ? panelSweep : sweep)(browser, js, job) } }))
await browser.close()

console.log(`overlay alignment: ${renders} renders in real Chromium, ${((Date.now() - t0) / 1000).toFixed(0)} s; worst spread of the five marks ${worstSpread.toFixed(2)} px (limit ${TOLERANCE_PX}) at ${worstWhere}`)
console.log(`panels: ${panelChecks} round marks measured, worst offset of a mark from the centre of its circle ${panelWorst.toFixed(2)} px at ${panelWorstWhere}`)
if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s):`)
  for (const f of failures.slice(0, 40)) console.error("  - " + f)
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`)
  process.exit(1)
}
console.log("OK: the check marks, the cross, the dashes and the liquidity figure share one line and one font in every verdict, plan, colour and state; the panels are Bebas Neue with round, centred marks.")
