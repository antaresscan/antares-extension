# Chrome Web Store — Listing Copy (English)

> Paste the strings below into the Chrome Web Store Developer Dashboard
> when submitting / updating the Antares listing. Keep this file in sync
> with the actual store page; treat it as the canonical source.

---

## Name (max 75 chars)

```
Antares — Anti-Scam Scanner for Solana
```

---

## Short description / Summary (max 132 chars)

```
Real-time Solana token scanner. 7-layer scoring on every token page. Free unlimited scans, Pro for power users.
```

(112 chars — leaves headroom for future tagline tweaks)

---

## Category

Primary: **Productivity**
Secondary: **Developer Tools**

---

## Detailed description

> Rebuilt after CWS rejection on 2026-05-09 (case Yellow Argon — Spam in
> keywords). The reviewer specifically flagged the "SUPPORTED PLATFORMS"
> bullet list with its `(domain.tld)` parentheticals as keyword stuffing.
> The version below removes the explicit platform list, drops the false
> "open source" claim (repo is private), and updates the privacy URL to
> the antaresscan.com custom domain. Each upstream API and each platform
> name appears at most once, in context, never as a flat keyword list.

```
ANTARES — REAL-TIME SOLANA TOKEN PROTECTION

Antares scans every Solana token you encounter while browsing the major
trading platforms and surfaces a 7-layer verdict in seconds. SAFE /
CAUTION / DANGER / RUG, with a 1000-point composite score and the
reasons behind it.

You don't paste contract addresses. You don't switch tabs. You don't
sign anything. You don't even need an account. The verdict appears in
a draggable overlay as soon as you open a token's page.

WHY ANTARES IS DIFFERENT

Most rug detectors look at one signal. Antares aggregates seven and
combines them through a published geometric-mean formula:

  • Liquidity, volume, age, price action
  • Honeypot risk, top holders, deceptive-name detection
  • Sell-tax, blacklists, mint and freeze authority
  • Real holders, creator history, supply distribution
  • Transfer signature and market structure
  • Chart engine — blow-off, wick trap, staircase patterns
  • Cross-validation sanity check across all six layers

One bad source can't hide; one false positive can't flip a clean token
to RUG. A Safe Gate overrides on hard-kill flags (open LP, honeypot,
active mint authority, deceptive name).

WHAT YOU GET

In the overlay, live on every supported page:
  • The 1000-point score, color-coded by verdict
  • Critical Flags panel — why this token was flagged, ranked by impact
  • AI Summary — the verdict explained in 2–4 sentences
  • Sell / Mint / Freeze / LP / Liquidity status grid
  • Critical Actors — top 3 holders enriched with creator and cluster data

In the Full Analysis page, five specialised tabs:
  • Insider Watch — heatmap of top wallets, who is accumulating vs dumping
  • Buy/Sell Flow — money in vs money out across 5 min / 1 h / 6 h windows
  • Wash Volume — 0–100 wash score, real-vs-reported volume estimate
  • Sniper Map — launch-block bot activity and retention status
  • Exit Liquidity — slippage at $100 / $1K / $5K / $10K / $20K sell sizes

PRICING — HONEST AND CAPPED

  • Free       $0          Unlimited scans, verdict + score + safety grid,
                           subject to per-minute rate limits

  • Pro        $24.99/30d  Critical Flags + AI Summary + Full Analysis
                           page + scan history + CSV/JSON export

  • Yearly     $149.99/yr  Everything in Pro. Pay six months, get twelve.

Pay in 200+ cryptocurrencies via NOWPayments hosted checkout. Your tier
syncs across every device where you sign in to your Antares account.
No license keys to paste, no manual activation.

The Free tier is, and stays, unlimited.

PRIVACY

  • Optional account (email + password) — only needed for paid tiers
    and cross-device sync. Free works without one.
  • The API receives the contract address you scan plus standard HTTPS
    metadata (IP, user-agent) used only for rate limiting.
  • Scan history (Pro feature) is bound to your account, never sold.
  • No third-party analytics, no tracking pixels, no fingerprinting.
  • We do not read form fields, credentials, cookies, or browsing history.
  • Full disclosure: https://antaresscan.com/privacy

LIMITATIONS — READ THIS

Antares is a probabilistic risk screen, not a guarantee. It detects
what seven independent sources surface at scan time. Novel exploits,
coordinated dumps via fresh wallets, or social-engineering attacks may
not register. SAFE means "no critical signals across our seven layers" —
not "guaranteed money".

Always do your own research. The score is a tool, not a recommendation.
```

(~3,200 chars — well under the 16,000 limit)

---

## Tags / Keywords

CWS does not expose a separate tags / keywords field — search ranking
comes from the listing copy itself. Do not paste a flat keyword list
anywhere on the dashboard: that is exactly the pattern flagged as
Yellow Argon (Spam in keywords) on 2026-05-09.

---

## Promotional copy — Twitter announcement

```
Antares v1.3 is live on the Chrome Web Store.

Real-time Solana token scanner — 7-layer verdict, 1000-point score,
delivered as an overlay on every token page you open.

Free: unlimited scans.
Pro $24.99/30d · Yearly $149.99/yr · pay in 200+ cryptos.
Cross-device sync · no tracking.

Install → [link]
```
