# Antares — Anti-Scam Scanner for Solana

**Antares** is a Chrome extension that automatically detects the Solana token address on any page you visit and runs a real-time multi-source security scan.

## What it does

- Detects mint/freeze authority, honeypots, blacklists and proxy contracts (GoPlus)
- Checks LP burn/lock status and holder concentration (RugCheck)
- Analyses on-chain holder distribution (Helius)
- Detects chart manipulation patterns: parabolic pumps, blow-off tops, wash trading (DexScreener OHLCV)
- Identifies copycat / brand-imitation tokens
- Displays a verdict — **SAFE / CAUTION / DANGER / RUG** — with a score out of 1000

## Scoring

Score starts at **1000** and is reduced by weighted penalties across 6 layers:

| Layer | What it checks |
|---|---|
| L1 | Smart contract flags (GoPlus) |
| L2 | On-chain metadata & LP (RugCheck) |
| L3 | Liquidity & pool health (DexScreener) |
| L4 | Holder distribution (RugCheck + Helius) |
| L5 | Identity / copycat detection |
| L6 | Chart pattern risk (DexScreener OHLCV) |

A token can only reach **SAFE** if it passes all critical gates regardless of score.

## Stack

- Extension: [Plasmo](https://plasmo.com) + TypeScript
- Backend API: Vercel Serverless (Node)
- Rate limiting: Upstash Redis (sliding window 20 req/min per IP)
- Data sources: DexScreener · RugCheck · GoPlus · Helius

## Development

```bash
npm install
npm run dev      # extension hot-reload
npm run build    # production build
npm run package  # zip for Chrome Web Store
```

Set the following environment variables in Vercel:

```
HELIUS_API_KEY=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

## License

MIT
