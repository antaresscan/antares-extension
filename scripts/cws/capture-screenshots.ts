/**
 * Chrome Web Store screenshot capture harness.
 *
 * Captures the 5 listing screenshots at exactly 1280×800 PNG, the
 * Chrome Web Store's primary supported size.
 *
 * Run:
 *   npm run build                                  # build the extension
 *   npx playwright install chromium                # one-off
 *   npx tsx scripts/cws/capture-screenshots.ts
 *
 * Strategy:
 *   - Shots 1-4: load the built extension into a Playwright-controlled
 *     Chromium, navigate to a real DexScreener token page, wait for
 *     the overlay to inject, and screenshot. Authentic content — same
 *     overlay the production user sees.
 *   - Shot 5: vanilla chromium, navigate to the public pricing page,
 *     screenshot. No extension needed.
 *
 * The DexScreener path needs a *headed* browser because Chromium
 * requires it for extension service workers to register reliably.
 * We run with `--headless=new` only on the pricing shot.
 */

import { chromium, type Page, type BrowserContext } from "@playwright/test"
import path from "path"
import fs from "fs/promises"

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "docs", "cws", "screenshots")
const EXTENSION_PATH = path.resolve(__dirname, "..", "..", "build", "chrome-mv3-prod")
const VIEWPORT = { width: 1280, height: 800 }

const WEBSITE_BASE =
  process.env.CWS_WEBSITE_BASE || "https://antares-website.vercel.app"

// Tokens chosen to give the gallery real SAFE → CAUTION → DANGER →
// RUG variety against production scoring (not the canned snapshots
// the demo page uses). Verified via /api/scan at capture time —
// re-verify and rotate if any drifts out of band.
const TOKENS = {
  // JUP — SAFE verdict (~908/1000). Established Solana token (Jupiter
  // aggregator), clean structural surface. Counter-balance proves
  // Antares isn't just a "scare" tool — clean tokens pass.
  jup: {
    ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    symbol: "JUP",
  },
  // FARTCOIN — CAUTION verdict (~825/1000). One concentration warning
  // on otherwise solid fundamentals — the canonical "informative not
  // scary" first impression the CWS checklist asks for.
  fartcoin: {
    ca: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    symbol: "FARTCOIN",
  },
  // BOME — DANGER verdict (~500/1000). Mid-band stacked-risk token,
  // shows the engine's middle warning band that's neither RUG nor
  // CAUTION. Rotates if BOME drifts; any token in 350-650 works.
  bome: {
    ca: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
    symbol: "BOME",
  },
  // HAWK — RUG verdict (~105/1000). Textbook concentration rug, the
  // dramatic red verdict that anchors the gallery's danger arc.
  hawk: {
    ca: "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump",
    symbol: "HAWK",
  },
} as const

async function ensureOutputDir(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true })
}

/**
 * Wait until the Antares overlay has injected into the page and
 * rendered its shadow DOM with content. The content script paints
 * into `#antares-host` (top-level element it inserts into the page),
 * with the actual overlay UI inside `shadowRoot`.
 */
async function waitForOverlay(page: Page, maxMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const ready = await page.evaluate(() => {
      const host = document.querySelector("#antares-host")
      if (!host) return false
      const sr = host.shadowRoot
      if (!sr) return false
      // Wait for an element that's only present once the verdict has
      // been computed (the score number or verdict pill).
      const hasScore = sr.querySelector('[class*="score"], [class*="verdict"], [class*="band"]')
      return !!hasScore && sr.innerHTML.length > 5_000
    })
    if (ready) return
    await page.waitForTimeout(500)
  }
  throw new Error("Overlay never reached ready state")
}

/**
 * Capture a DexScreener-with-overlay shot for a given token. Frames
 * the overlay in the upper-right of the viewport, with the chart
 * visible behind it.
 */
async function captureOverlay(
  context: BrowserContext,
  token: { ca: string; symbol: string },
  filename: string,
  panelToOpen?: "flags" | "summary",
): Promise<void> {
  const page = await context.newPage()
  try {
    // Set a clean viewport.
    await page.setViewportSize(VIEWPORT)

    // Navigate. DexScreener URLs by CA — DexScreener resolves to the
    // top-volume pair for that token automatically.
    const url = `https://dexscreener.com/solana/${token.ca}`
    console.log(`     navigating ${url}`)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })

    // The overlay's content script is registered on document_idle,
    // which fires after networkidle-equivalent. Wait for it.
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {})
    await waitForOverlay(page, 30_000)
    console.log(`     overlay ready`)

    // Optionally expand a panel to highlight a specific feature.
    // Buttons are at known IDs inside the overlay's shadow root:
    //   #ant-critical-flags-btn  (Critical Flags toggle)
    //   #ant-ai-summary-btn      (AI Summary toggle)
    // Both are <button> on Pro/Lifetime; <a> with .locked on Free.
    if (panelToOpen) {
      const id =
        panelToOpen === "flags"
          ? "#ant-critical-flags-btn"
          : "#ant-ai-summary-btn"
      const clicked = await page.evaluate((selector: string) => {
        const host = document.querySelector("#antares-host")
        const sr = host?.shadowRoot
        if (!sr) return "no-shadow-root"
        const btn = sr.querySelector<HTMLElement>(selector)
        if (!btn) return "no-button"
        if (btn.classList.contains("locked")) return "locked"
        btn.click()
        return "clicked"
      }, id)
      console.log(`     panel ${panelToOpen}: ${clicked}`)
      // Animation settle
      await page.waitForTimeout(900)
    }

    // Final settle for any animations
    await page.waitForTimeout(500)

    const outPath = path.join(OUTPUT_DIR, filename)
    await page.screenshot({
      path: outPath,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      type: "png",
    })
    console.log(`     saved ${path.relative(process.cwd(), outPath)}`)
  } finally {
    await page.close()
  }
}

/**
 * Write `antares_dev_tier` into chrome.storage.local so the
 * background worker treats this install as a paid tier. We need an
 * extension-page context (chrome-extension://...) to access
 * chrome.storage; we use the extension's options page since it's
 * declared in the manifest.
 */
async function setDevTier(
  context: BrowserContext,
  tier: "free" | "pro" | "yearly" | "lifetime",
): Promise<void> {
  // Find the extension ID from the registered service worker.
  const sw = context.serviceWorkers()[0]
  if (!sw) throw new Error("no service worker registered")
  const extensionId = sw.url().split("/")[2]

  // Open the options page (a chrome-extension:// URL where chrome.*
  // APIs are available) just long enough to write the storage key.
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await page.evaluate((t: string) => {
    return new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (globalThis as any).chrome
      if (!c?.storage?.local) {
        resolve()
        return
      }
      c.storage.local.set({ antares_dev_tier: t }, () => resolve())
    })
  }, tier)
  await page.close()
  console.log(`     dev tier set to "${tier}"`)
}

async function captureWithExtension(): Promise<void> {
  // launchPersistentContext is the supported way to load an unpacked
  // extension in Playwright. Empty userDataDir keeps each run clean.
  const context = await chromium.launchPersistentContext("", {
    headless: false, // service worker registration is unreliable headless
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--disable-default-apps",
      "--disable-blink-features=AutomationControlled",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height + 80}`, // +80 for chrome chrome
      "--lang=en-US,en",
    ],
    viewport: VIEWPORT,
    locale: "en-US",
    colorScheme: "dark",
  })

  // Wait for the service worker to register so the content script is
  // active when we navigate.
  if (context.serviceWorkers().length === 0) {
    await context.waitForEvent("serviceworker", { timeout: 15_000 })
  }

  // Narrative arc across the 4 in-extension shots: CAUTION → SAFE →
  // DANGER → RUG. Hero leads with CAUTION (the most common real-world
  // verdict and the "informative not scary" framing the checklist
  // asks for); SAFE proves the engine isn't just a scare tool; DANGER
  // and RUG demonstrate the catch range. At thumbnail scale this reads
  // as a colour spectrum (yellow → green → orange → red).
  console.log("[1/5] → 01-hero-caution-fartcoin.png")
  await captureOverlay(context, TOKENS.fartcoin, "01-hero-caution-fartcoin.png")

  console.log("[2/5] → 02-verdict-safe-jup.png")
  await captureOverlay(context, TOKENS.jup, "02-verdict-safe-jup.png")

  console.log("[3/5] → 03-verdict-danger-bome.png")
  await captureOverlay(context, TOKENS.bome, "03-verdict-danger-bome.png")

  console.log("[4/5] → 04-verdict-rug-hawk.png")
  await captureOverlay(context, TOKENS.hawk, "04-verdict-rug-hawk.png")

  await context.close()
}

async function capturePricing(): Promise<void> {
  console.log("[5/5] → 05-pricing.png  (vanilla chromium)")
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-US",
    colorScheme: "dark",
  })
  const page = await context.newPage()
  try {
    await page.goto(`${WEBSITE_BASE}/pricing.html`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const outPath = path.join(OUTPUT_DIR, "05-pricing.png")
    await page.screenshot({
      path: outPath,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      type: "png",
    })
    console.log(`     saved ${path.relative(process.cwd(), outPath)}`)
  } finally {
    await page.close()
    await context.close()
    await browser.close()
  }
}

async function main(): Promise<void> {
  await ensureOutputDir()

  try {
    await captureWithExtension()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`extension capture FAILED: ${msg}`)
    process.exit(1)
  }

  try {
    await capturePricing()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`pricing capture FAILED: ${msg}`)
    process.exit(1)
  }

  console.log(`\n5/5 screenshots → ${path.relative(process.cwd(), OUTPUT_DIR)}`)
}

void main().catch((err) => {
  console.error("capture failed:", err)
  process.exit(1)
})
