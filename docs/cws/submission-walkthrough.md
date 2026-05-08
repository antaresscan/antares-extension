# Chrome Web Store — Submission Walkthrough (v1.3.1)

> Step-by-step procedure for taking the v1.3.1 build from local to a
> live Chrome Web Store listing. Companion to `store-listing-en.md`
> (copy), `permission-justifications.md` (privacy field text) and
> `screenshots-checklist.md` (visual spec).

---

## Prerequisites

  - [ ] $5 USD on a card or in PayPal (one-time CWS dev fee)
  - [ ] Google account dedicated to the project (avoid the founder's
        personal account so support email + brand identity are clean)
  - [ ] Built ZIP at `antares-extension-v1.3.1.zip` (510 KB) — produced
        by `npm run build` then archiving `build/chrome-mv3-prod`
  - [ ] 5 screenshots captured at `docs/cws/screenshots/*.png`,
        verified at exactly 1280 × 800 PNG
  - [ ] Privacy policy live at
        `https://antares-website.vercel.app/privacy`

## 1 — Create the developer account

  1. Visit <https://chrome.google.com/webstore/devconsole/>
  2. Sign in with the project Google account
  3. Accept the Chrome Web Store Developer Program Policies
  4. Pay the **$5 one-time registration fee** — credit card or PayPal
  5. Verify your email if prompted

Time: 5–10 minutes. The fee is one-off; one account can hold any
number of items.

## 2 — Create the new item

  1. Dashboard → **"New Item"**
  2. Upload `antares-extension-v1.3.1.zip`
  3. Wait 30–60 seconds for the manifest validator to parse it. The
     dashboard auto-fills the name, version, description from the
     manifest.

If the upload errors out, the most common causes are:
  - Permissions outside the manifest's `permissions` array (e.g. a
    leftover `<all_urls>` host) — the manifest already excludes these
  - A leftover `key` field in the manifest from local development —
    `plasmo build` strips it; verify with
    `node -e "console.log(JSON.parse(require('fs').readFileSync('build/chrome-mv3-prod/manifest.json')).key)"`
    (should print `undefined`)

## 3 — Fill the **Store listing** tab

Source: `docs/cws/store-listing-en.md`. Fields and where each block
goes:

| Field | Source block | Notes |
|---|---|---|
| Title (75 chars) | `## Name` | "Antares — Anti-Scam Scanner for Solana" |
| Summary (132 chars) | `## Short description / Summary` | 112 chars, leaves headroom |
| Description (16k chars) | `## Detailed description` | Paste the entire fenced block |
| Category | Productivity | Secondary: Developer Tools |
| Language | English | Add French later as a separate listing variant |

**Screenshots** — upload in this order so the gallery hero is the
first image:

  1. `01-hero-caution-fartcoin.png`   (FARTCOIN, CAUTION verdict)
  2. `02-verdict-safe-jup.png`        (JUP, SAFE verdict)
  3. `03-verdict-danger-bome.png`     (BOME, DANGER verdict)
  4. `04-verdict-rug-hawk.png`        (HAWK, RUG verdict)
  5. `05-pricing.png`                 (Pricing tiers)

Optional:
  - **Promotional tile 440×280** — adapt `og-image.svg` from the
    website repo, crop to 440×280
  - **Marquee 1400×560** — same source, wider crop

**URLs**:
  - Website: `https://antares-website.vercel.app`
  - Support: `https://github.com/COMEALAMAISONGROUPE/antares-extension/issues`

## 4 — Fill the **Privacy practices** tab

Source: `docs/cws/permission-justifications.md`.

  1. **Single-purpose justification** → paste the
     `## Single-purpose justification` block verbatim
  2. **Permission justifications** → for each of `storage`,
     `notifications`, `activeTab`, `alarms`, `tabs`, paste the
     matching block under `## API permissions`
  3. **Host permission justifications** → for each of the 8 declared
     hosts (DexScreener, pump.fun, Axiom, Photon, Birdeye,
     GeckoTerminal, GMGN, Telemetry), paste the matching block under
     `## Host permissions`
  4. **Privacy practices certification** — answer per the
     `## Privacy practices summary` table:
       - ☑ Website content (public token addresses on supported sites)
       - ☐ All other categories (PII, finance, health, auth, comms,
         location, web history, user activity)
       - ☐ Data sold to third parties: NO
       - ☐ Data used for unrelated purposes: NO
  5. **Privacy policy URL** → `https://antares-website.vercel.app/privacy`
  6. **Remote code use** → "No, I am not using remote code"
     (Antares ships the entire scoring engine in the bundle; the API
     it calls returns JSON only, never executable code)

## 5 — Fill the **Distribution** tab

  - **Visibility**: Public
  - **Distribution**: All regions (no geo restrictions)
  - **Pricing**: Free
    (Pro/Yearly upgrades are processed via NOWPayments outside the
    extension — declared in the description; CWS does not need its
    own pricing config)

## 6 — Submit for review

Click **"Submit for review"** at the top of the dashboard.

Expected timelines:
  - **Initial review**: 1–7 days. Most submissions land within 24h.
  - **Re-review after fixes**: usually <24h once the reviewer has
    seen the original

If rejected, the email lists the specific policy section. Common
gotchas for our shape of extension:
  - Permission justification too vague → expand the single-line
    answer with the user-visible feature (already done in our
    `permission-justifications.md`)
  - Privacy disclosure missing for "Website content" → we explicitly
    declare it (public token addresses on supported sites)
  - Single-purpose unclear → our SP statement names the user-facing
    purpose (warning about Solana scam tokens) and ties every
    permission to it

## 7 — Post-submission

  1. Tag the local repo with `v1.3.1`:
     `git tag -a v1.3.1 -m "v1.3.1: AI summary fidelity" && git push --tags`
  2. Cut a GitHub Release with the ZIP attached so testers can
     side-load while CWS reviews
  3. Update `docs/cws/store-listing-en.md` with the live store URL
     once the listing goes live
  4. Tweet the launch (template in `store-listing-en.md` →
     "Promotional copy")

## Re-submission flow (for v1.3.2+)

  1. Bump `package.json` version
  2. Add a CHANGELOG entry
  3. `npm run build`
  4. Archive `build/chrome-mv3-prod` → `antares-extension-v1.3.2.zip`
  5. Re-run `npx tsx scripts/cws/capture-screenshots.ts` if the
     overlay UI changed
  6. Dashboard → existing item → **"Upload Updated Package"**
  7. Update store listing fields if copy changed
  8. Submit for review

Existing users get the update auto-pushed once the new version is
approved. CWS doesn't require manual action from end-users.
