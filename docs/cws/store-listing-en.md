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
Real-time Solana token scanner. Multi-source verdict on every token page. Free unlimited scans, Pro for power users.
```

(116 chars — leaves headroom for future tagline tweaks)

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
>
> Corrected 2026-10-17 (file-by-file audit): every sentence below now says
> what the code does. Five data sources instead of "seven layers"; no
> blacklists; no scan history or CSV/JSON export; Critical Actors on the
> Full Analysis page, not in the overlay. Paste this version into the
> dashboard (the published listing still carries the old sentences).

```
ANTARES — REAL-TIME SOLANA TOKEN PROTECTION

Antares scans every Solana token you encounter while browsing the major
trading platforms and surfaces a multi-source verdict in seconds. SAFE /
CAUTION / DANGER / RUG, with a 1000-point composite score and the
reasons behind it.

You don't paste contract addresses. You don't switch tabs. You don't
sign anything. You don't even need an account. The verdict appears in
a draggable overlay as soon as you open a token's page.

WHY ANTARES IS DIFFERENT

Most rug detectors look at one signal. Antares reads five independent
data sources and combines them through a weighted geometric mean, then
cross-checks the chain against GoPlus:

  • Market: liquidity, volume, token age, price action
  • Contract: mint and freeze authority read from the chain, whether the
    token itself can block a sale, Token-2022 transfer fees
  • Risk flags: deceptive names, creator rug history, unlocked liquidity
  • Holders: holder count, top holder and top-10 concentration
  • Chart: blow-off tops, wick traps, stair-step patterns

One bad source can't hide; one false positive can't flip a clean token
to RUG. A Safe Gate blocks a SAFE verdict whenever a hard flag is
present (open liquidity, a sale-blocking mechanism, an active mint or
freeze authority, a deceptive name, severe holder concentration).

WHAT YOU GET

In the overlay, live on every supported page:
  • The 1000-point score, color-coded by verdict
  • Critical Flags panel — why this token was flagged, ranked by impact
  • AI Summary — the verdict explained in a few short paragraphs
  • Sell / Mint / Freeze / LP / Liquidity status grid

In the Full Analysis page, the top 3 holders (Critical Actors, with
creator and cluster tags) and five specialised tabs:
  • Insider Watch — what the 10 biggest wallets did in the last 6 hours
  • Buy/Sell Flow — buys and sells across 5 min / 1 h / 6 h windows
  • Wash Volume — a 0–100 wash-trading score from DexScreener trades
  • Sniper Map — how much of the supply the top 10 wallets hold, and any
    sniper or bundle signal
  • Exit Liquidity — slippage at $100 / $1K / $5K / $10K / $20K sell sizes

PRICING — HONEST AND CAPPED

  • Free       $0          Unlimited scans, verdict + score + safety grid,
                           subject to per-minute rate limits

  • Pro        $24.99/30d  Critical Flags + AI Summary + Full Analysis
                           page

  • Yearly     $149.99/yr  Everything in Pro. Pay six months, get twelve.

Pay in 200+ cryptocurrencies via NOWPayments hosted checkout. Your tier
syncs across every device where you sign in to your Antares account.
No license keys to paste, no manual activation.

The Free tier is, and stays, unlimited.

PRIVACY

  • Optional account (email + password) — only needed for paid tiers
    and cross-device sync. Free works without one.
  • The API receives the contract address you scan, a random install
    identifier, your sign-in token if you are signed in, and standard
    HTTPS metadata (IP, user-agent).
  • Scans are recorded per installation (the most recent ones), linked
    to your account if you have one, never sold.
  • No third-party analytics, no tracking pixels, no fingerprinting.
    Crash reports go to Sentry with e-mail addresses, IP addresses and
    query strings removed.
  • We do not read form fields, credentials or cookies. The extension only
    compares the addresses of your open tabs, on your device, to reuse an
    analysis tab that is already open; they are never stored or sent.
  • On the Antares website only, the extension hands the page your install
    identifier (to attach a purchase to your install) and keeps the
    sign-in token the page gives it.
  • Full disclosure: https://antaresscan.com/privacy

LIMITATIONS — READ THIS

Antares is a probabilistic risk screen, not a guarantee. It detects
what its data sources surface at scan time. Novel exploits,
coordinated dumps via fresh wallets, or social-engineering attacks may
not register. SAFE means "no critical signal from any of our data
sources" — not "guaranteed money".

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

Real-time Solana token scanner — multi-source verdict, 1000-point score,
delivered as an overlay on every token page you open.

Free: unlimited scans.
Pro $24.99/30d · Yearly $149.99/yr · pay in 200+ cryptos.
Cross-device sync · no tracking.

Install → [link]
```
