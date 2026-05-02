# Chrome Web Store — Screenshots & Promotional Tile Checklist

> CWS requires 1–5 screenshots at **1280 × 800** or **640 × 400** PNG/JPEG,
> plus optional promotional tiles. This file lists what to capture and
> how, so the listing tells a coherent story instead of a random gallery.

---

## Screenshots — recommended capture order

The CWS gallery is ordered: the first screenshot is the hero. Optimise
for stopping a scrolling user, then deepen the explanation in the next
slots.

### 1. Hero — overlay on a real Solana token (1280 × 800)

  • Browser at full width on DexScreener, a token page mid-scroll
  • Antares overlay docked top-right, **CAUTION** verdict (yellow band)
    with score around 600–700 — this reads as "informative" rather than
    "scary" and makes the user curious about the breakdown
  • Critical Flags panel **collapsed** (cleaner first impression)
  • Capture the token symbol + name visible in the overlay header

Recommended token to scan: pick something with score 600–750 from the
demo page on the website (`/demo.html`).

### 2. Verdict variety — RUG vs SAFE side-by-side (1280 × 800)

  • Two browser windows tiled side-by-side, each showing the overlay on
    a different token: one **SAFE** (green band, score 850+), one **RUG**
    (red band, score < 200)
  • Crops/labels in the screenshot title: "Two scans. One verdict each."
  • Demonstrates the binary clarity of the output

Sample tokens: see `docs/cws/screenshots-source-tokens.md` (TBD — pick
stable ones from the corpus that won't disappear before review).

### 3. Critical Flags panel expanded (1280 × 800)

  • Same overlay but with the "⚠ Critical Flags" panel open
  • Shows the per-flag impact, severity dots, and ranked list
  • Demonstrates the *evidence* layer behind the verdict

### 4. AI Summary panel expanded (1280 × 800)

  • Overlay with the "⬡ AI Summary" panel open
  • 2–4 sentence explanation visible
  • Demonstrates the human-readable layer alongside the numbers

### 5. Pricing tiers (1280 × 800)

  • Browser pointed at https://antares-website.vercel.app/pricing
  • All three tiers in frame: Free / Pro Monthly / Lifetime
  • Lifetime card showing the "1000 spots" counter
  • Demonstrates the honest model and gives users a clear next step

---

## Promotional tile (optional but recommended)

  • Small tile  440 × 280  PNG  — stylised Antares logo + "Solana token scanner"
  • Marquee     1400 × 560 PNG  — same hero motif, wider crop, suitable for
                                  CWS "Featured" promo if we ever land there

The website's `og-image.png` (1200 × 630) is close to the small-tile
ratio and can be cropped to fit. See `og-image.svg` in the website repo
for the editable source.

---

## Capture process

1. Build the production extension: `npm run build`
2. Load `build/chrome-mv3-prod` as an unpacked extension in a clean
   Chrome profile
3. Disable other extensions (no toolbar pollution in screenshots)
4. Set browser zoom to **100 %** — anything else throws off the 1280
   width measurements
5. Use Chrome DevTools' **device toolbar** (Responsive, set viewport
   1280 × 800) to lock the dimensions before capturing
6. Capture with the OS screenshot tool (full window, no crop) — saves
   directly at the correct dimensions
7. Save PNGs to `docs/cws/screenshots/` (gitignored, regenerated each
   time we update the listing)

---

## Pre-submission visual QA

Before uploading, eyeball each screenshot for:

  • [ ] No personal data visible (wallet addresses except known testnet
        ones, no email, no clipboard history in the URL bar)
  • [ ] No other tabs visible (single-tab Chrome window)
  • [ ] Overlay is **fully** visible (not clipped at the edge)
  • [ ] Token symbol/name is *readable* at thumbnail size — store
        thumbnails are aggressively scaled down
  • [ ] Verdict colour matches the score (sanity check we didn't capture
        a stale or cached state)
  • [ ] Free-tier quota badge visible in the header (sells the freemium
        story implicitly without needing copy)
