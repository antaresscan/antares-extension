// js/token-app.js — Entry point + render() orchestrator for /token.html.
//
// This file is intentionally thin: it boots the page, fetches the scan,
// and composes the layout by stitching together HTML strings produced
// by ./views.js, then wires up event handlers from ./ui-setup.js. All
// the heavy lifting (formatters, business logic, view building, event
// handling, network) lives in dedicated modules so each piece can be
// understood and tested in isolation.
//
// Module map:
//   ./formatters.js  — pure formatters (fmt, pct, age, escapeHtml, …)
//   ./compute.js     — pure business logic (computeExitLiquidity, parsePctFromFlags)
//   ./views.js       — HTML-string builders (buildXxx tab bodies)
//   ./ui-setup.js    — DOM/event wiring (setupXxx + loadInsiderActivity)
//   ./api-client.js  — HTTP layer (fetchWithRetry + API constants)

import {
  fmt,
  pct,
  age,
  fmtPrice,
  formatAgeHours,
  escapeHtml,
  getFlagDescription,
} from "./formatters.js";
import {
  buildSparkline,
  buildSniperMapTab,
  buildExitLiquidityTab,
  buildCriticalActorsPreview,
  buildInsiderWatchTab,
  buildBuySellFlowTab,
  buildWashVolumeTab,
  buildSourceListRows,
} from "./views.js";
import {
  setupCursorGlow,
  setupStickyNav,
  setupCollapsibles,
  setupTabs,
  setupRefreshButton,
  setupFreshnessTicker,
  setupRevealObserver,
  loadInsiderActivity,
  renderDemoInsiderActivity,
} from "./ui-setup.js";
import { API, fetchWithRetry } from "./api-client.js";

// ──────────────────────────────────────────────────────────────────────
// Boot — parse the CA from the URL, kick off the initial fetch, and
// wire up the manual retry button.
// ──────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const _raw = params.get("ca") || params.get("token") || "";
const ca = CA_RE.test(_raw) ? _raw : "";
const caShort = ca ? ca.slice(0, 6) + "…" + ca.slice(-4) : "—";
document.getElementById("ca-disp").textContent = caShort;

const isDemo = params.get("demo") === "1";

// ──────────────────────────────────────────────────────────────────────
// DEMO_DATA — hardcoded snapshots for the 4 marketing demo tokens.
// Scores use clean display values: SAFE=1000 CAUTION=750 DANGER=500 RUG=250.
// Served when token.html is opened with ?demo=1 from antaresscan.com/demo,
// bypassing the live /api/scan call entirely.
// ──────────────────────────────────────────────────────────────────────
const _demoTs = Date.now();
const DEMO_DATA = {
  "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv": {
    score: 1000, risk: "SAFE", confidence: 80,
    tokenSymbol: "PENGU", tokenName: "Pudgy Penguins",
    resolvedMint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    mintAuthority: false, freezeAuthority: false, honeypot: false,
    lpBurned: true, lpLocked: false, lpLockedPct: 100,
    liquidity: 9083893, marketCap: 639294195, priceUsd: 0.01017,
    holders: 544390, volume24h: 12480000, volume1h: 520000,
    priceChange5m: 0.18, priceChange1h: 0.91, priceChange24h: 3.71,
    solscanTokenAgeHours: 137,
    tokenLogo: "https://cdn.dexscreener.com/cms/images/9d5188f603b49ab02f7a75e5d2c2959ec2947c98181501fb11688672e9394efd?width=800&height=800&quality=95&format=auto",
    flags: [
      { severity: "info", label: "Helius unavailable" },
      { severity: "bonus", label: "LP Burned 100% (GoPlus) ✓" },
      { severity: "bonus", label: "Established token (30d+) ✓" },
    ],
    pair: {
      url: "https://dexscreener.com/solana/5zpphebh8qcevbbpz848p3rjbvqxw7bh18samuygseyb",
      info: {
        websites: [{ url: "https://www.pudgypenguins.com", label: "Website" }],
        socials: [
          { url: "https://x.com/pudgypenguins", type: "twitter" },
          { url: "https://discord.gg/pudgypenguins", type: "discord" },
        ],
      },
      txns: {
        m5:  { buys: 6,    sells: 4    },
        h1:  { buys: 75,   sells: 50   },
        h6:  { buys: 450,  sells: 300  },
        h24: { buys: 1800, sells: 1200 },
      },
      volume: { m5: 41667, h1: 520000, h6: 3120000, h24: 12480000 },
    },
    // SAFE narrative — well-distributed holders, no whale dominance.
    // top10 < 15 + top1 < 5 + 0 sniper flags → "CLEAN LAUNCH" verdict
    // in the Sniper Map tab.
    topHolderPct: 2.8, top10HolderPct: 9.4,
    criticalActors: [],
    holderActivity: { rows: [], netFlowPct: 0, netFlowDirection: "flat" },
    outcomeStats: null,
    verdictHistory: [{ ts: _demoTs - 3600000, verdict: "SAFE", score: 1000, event: "Helius unavailable" }],
    sources_used: ["dexscreener", "rugcheck", "goplus", "solscan", "chart"],
    aiSummary: "PENGU shows a SAFE profile with fully burned LP and 30d+ established trading on Solana. Helius source temporarily unavailable lowers confidence to 80% but RugCheck and GoPlus cross-validate the safe verdict. No critical flags detected — strong holder distribution across 544,390 wallets with no concentration risk.",
    fetchedAt: _demoTs,
    // demoActivity — pre-baked top-10 wallet snapshot + 6h activity feed.
    // Story: legitimate treasury + market makers, organic retail flow,
    // tiny positive net flow. The wallets[] order drives the rank pill
    // (#1..#10) and the per-wallet color in the feed rows.
    demoActivity: {
      wallets: [
        { walletFull: "7XHk9aRpDjeqLvCpTreasury2024MultiSigYpKvXp4N", wallet: "7XHk…Xp4N", pctSupply: 2.8, holdings: 6720000000, active: true },
        { walletFull: "5kQwT3vYpFcN8aHmFoundationVaultPENGUbCdEf9K", wallet: "5kQw…f9K",  pctSupply: 1.9, holdings: 4560000000, active: true },
        { walletFull: "9MnPrTYzKvPjQrLmBinanceHotWalletPENGUxXY3Z", wallet: "9MnP…Y3Z",  pctSupply: 1.4, holdings: 3360000000, active: true },
        { walletFull: "2DfGhJ7nVqWxRpKzMarketMakerWintermutePNGUuq", wallet: "2DfG…uq",   pctSupply: 1.1, holdings: 2640000000, active: false },
        { walletFull: "8VxByU6tQzRpKjmCoinbaseColdStoragePNGUaBcD", wallet: "8VxB…aBcD", pctSupply: 0.8, holdings: 1920000000, active: false },
        { walletFull: "3JtNcWzQXyPm4QrPRaydiumLPProviderPENGUxyz1", wallet: "3JtN…xyz1", pctSupply: 0.6, holdings: 1440000000, active: false },
        { walletFull: "6KsXzVnPmQyJ8rT9LongTermHolderPENGUaBcDeF7", wallet: "6KsX…DeF7", pctSupply: 0.5, holdings: 1200000000, active: false },
        { walletFull: "4FmAqRrTsPyVx8WhDiamondHandsPENGUaBcDeFgHi", wallet: "4FmA…FgHi", pctSupply: 0.4, holdings: 960000000,  active: false },
        { walletFull: "7HbCxQrPmVtKgN2DActiveTraderPENGUxXyZ2bC3d", wallet: "7HbC…2bC3d", pctSupply: 0.3, holdings: 720000000,  active: false },
        { walletFull: "9PnErWqXyZ3MkYWaWhaleHolderPENGUjJkLmNoP4q", wallet: "9PnE…NoP4q", pctSupply: 0.2, holdings: 480000000,  active: false },
      ],
      activity: [
        { action: "BOUGHT", walletFull: "9MnPrTYzKvPjQrLmBinanceHotWalletPENGUxXY3Z", wallet: "9MnP…Y3Z",  usdValue: 1140, tokenAmount: 112000, ageMin: 8  },
        { action: "BOUGHT", walletFull: "7XHk9aRpDjeqLvCpTreasury2024MultiSigYpKvXp4N", wallet: "7XHk…Xp4N", usdValue: 320,  tokenAmount: 31500,  ageMin: 24 },
        { action: "SOLD",   walletFull: "5kQwT3vYpFcN8aHmFoundationVaultPENGUbCdEf9K", wallet: "5kQw…f9K",  usdValue: -180, tokenAmount: 17700,  ageMin: 47 },
        { action: "BOUGHT", walletFull: "9MnPrTYzKvPjQrLmBinanceHotWalletPENGUxXY3Z", wallet: "9MnP…Y3Z",  usdValue: 240,  tokenAmount: 23600,  ageMin: 89 },
        { action: "SOLD",   walletFull: "7XHk9aRpDjeqLvCpTreasury2024MultiSigYpKvXp4N", wallet: "7XHk…Xp4N", usdValue: -425, tokenAmount: 41800,  ageMin: 142 },
        { action: "BOUGHT", walletFull: "5kQwT3vYpFcN8aHmFoundationVaultPENGUbCdEf9K", wallet: "5kQw…f9K",  usdValue: 815,  tokenAmount: 80100,  ageMin: 218 },
      ],
      walletsWithActivity: 3,
      totalCheckedWallets: 10,
      netFlowUsd: 1910,
      windowHours: 6,
    },
  },
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump": {
    score: 750, risk: "CAUTION", confidence: 100,
    tokenSymbol: "Fartcoin", tokenName: "Fartcoin",
    resolvedMint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    mintAuthority: false, freezeAuthority: false, honeypot: false,
    lpBurned: true, lpLocked: false, lpLockedPct: 99.71,
    liquidity: 7634137, marketCap: 205604372, priceUsd: 0.2056,
    holders: 164066, volume24h: 4080000, volume1h: 198000,
    priceChange5m: -0.12, priceChange1h: -0.93, priceChange24h: 3.39,
    solscanTokenAgeHours: 13384,
    tokenLogo: "https://cdn.dexscreener.com/cms/images/9af5672845c89585e9ff1e3b26a640090324aa4d92222052d1043e60ef8182de?width=800&height=800&quality=95&format=auto",
    flags: [
      { severity: "warning", label: "Single wallet holds 11% of supply" },
      { severity: "bonus", label: "LP Burned 100% (GoPlus) ✓" },
      { severity: "bonus", label: "Established token (30d+) ✓" },
    ],
    pair: {
      url: "https://dexscreener.com/solana/bzc9nzfmqkxr6fz1dbph7bdf9broyef6pnzesp7v5iiw",
      info: {
        websites: [{ url: "https://www.infinitebackrooms.com/dreams/conversation-1721540624-scenario-terminal-of-truths-txt", label: "Website" }],
        socials: [{ url: "https://x.com/FartCoinOfSOL", type: "twitter" }],
      },
      // CAUTION narrative — slightly more sells than buys (distribution
      // pressure from the 10.5% wallet's smaller siblings) but volume
      // is genuine (avg trade $2.4K on $7.6M LP → no wash).
      txns: {
        m5:  { buys: 3,    sells: 4    },
        h1:  { buys: 35,   sells: 50   },
        h6:  { buys: 175,  sells: 250  },
        h24: { buys: 700,  sells: 1000 },
      },
      volume: { m5: 17000, h1: 198000, h6: 1020000, h24: 4080000 },
    },
    topHolderPct: 10.54, top10HolderPct: 33.81,
    criticalActors: [
      { type: "insider", tag: "Insider", pct: 10.5, addr: "9SLP…7a2w", repLbl: "Concentration risk · single wallet", repWidth: 91.5, repWarn: false, desc: "Holds <b>10.5%</b> of supply — one-wallet dump would crash the price." },
    ],
    holderActivity: {
      rows: [
        { role: "bot", label: "Static", avatar: "Insider", pctChange: 0, pctChangeDisp: "±0%", addr: "9SLP…KpKS", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
        { role: "whale-big", label: "Static", avatar: "Whale", pctChange: 0, pctChangeDisp: "±0%", addr: "u6PJ…Xq2w", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
        { role: "whale-big", label: "Static", avatar: "Whale", pctChange: 0, pctChangeDisp: "±0%", addr: "E2Rv…atYy", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
      ],
      netFlowPct: 0, netFlowDirection: "flat",
    },
    outcomeStats: {
      timeToRugMedianDisp: "2d", timeToRugMedianHours: 48, timeToRugSampleSize: 180,
      pctRugged24h: 54, pctSlowDeath: 30, pctAlive30d: 16,
      distribution: [1,1.5,2,2.5,3,3.5,4,4.5,5,5,4.5,4,3.5,3,2.7,2.5,2.3,2.1,2,1.9,1.8,1.7,1.6,1.5,1.4,1.3,1.2,1.2,1.1,1.1,1,1,1.1,1.5,2,2.5],
      youBucketIndex: 25,
      mostSimilar: [
        { symbol: "FORGOTBOY", ruggedAfterHours: 72, loss: -78.2 },
        { symbol: "DEADCOIN", ruggedAfterHours: 168, loss: -82.5 },
        { symbol: "BLEEDR", ruggedAfterHours: 240, loss: -88 },
      ],
    },
    verdictHistory: [{ ts: _demoTs - 3600000, verdict: "CAUTION", score: 750, event: "Single wallet holds 11% of supply" }],
    sources_used: ["dexscreener", "rugcheck", "goplus", "helius", "solscan", "chart"],
    aiSummary: "Fartcoin lands on CAUTION because a single wallet holds 11% of supply — a meaningful concentration risk even with otherwise solid fundamentals. LP is fully burned, mint and freeze authorities are revoked, no honeypot, and the token has 30d+ of trading history. The verdict is not DANGER because the rest of the structural posture is clean; it is not SAFE because the concentrated wallet alone has enough leverage to swing the price.",
    fetchedAt: _demoTs,
    // CAUTION narrative — the 10.5% insider wallet (#1) is mostly idle
    // but #2 + #3 (its smaller siblings) drip-sell. Net flow slightly
    // negative. Mostly retail noise underneath. Several rows so the
    // scrollable feed actually demonstrates the new scroll behaviour.
    demoActivity: {
      wallets: [
        { walletFull: "9SLP7vTw5KpKS3rN8FQzMxYHcVgPq2DnEjRbWaXuKpKS", wallet: "9SLP…KpKS", pctSupply: 10.5, holdings: 105000000, active: true  },
        { walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", pctSupply: 6.8,  holdings: 68000000,  active: true  },
        { walletFull: "E2RvKpL5atYyN8mQzXq2wEr8tYrKpL5nVcBxHaGfDjSw", wallet: "E2Rv…atYy", pctSupply: 4.2,  holdings: 42000000,  active: true  },
        { walletFull: "3LpMwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEfG", wallet: "3LpM…CdEfG", pctSupply: 3.1,  holdings: 31000000,  active: true  },
        { walletFull: "7BfNzVxYpQrTsUwXyZaBcDeFgHjKlMnOpQrStUvWxYz5", wallet: "7BfN…WxYz5", pctSupply: 2.4,  holdings: 24000000,  active: false },
        { walletFull: "5CgMwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEf8", wallet: "5CgM…CdEf8", pctSupply: 1.8,  holdings: 18000000,  active: true  },
        { walletFull: "8DhNwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEfH", wallet: "8DhN…CdEfH", pctSupply: 1.5,  holdings: 15000000,  active: false },
        { walletFull: "4EiOwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEfP", wallet: "4EiO…CdEfP", pctSupply: 1.4,  holdings: 14000000,  active: false },
        { walletFull: "6FjPwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEfQ", wallet: "6FjP…CdEfQ", pctSupply: 1.2,  holdings: 12000000,  active: false },
        { walletFull: "2GkQwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEfR", wallet: "2GkQ…CdEfR", pctSupply: 0.9,  holdings: 9000000,   active: false },
      ],
      activity: [
        { action: "SOLD",   walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", usdValue: -2450, tokenAmount: 11900,   ageMin: 12  },
        { action: "BOUGHT", walletFull: "3LpMwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEfG", wallet: "3LpM…CdEfG", usdValue: 612,   tokenAmount: 2980,    ageMin: 31  },
        { action: "SOLD",   walletFull: "E2RvKpL5atYyN8mQzXq2wEr8tYrKpL5nVcBxHaGfDjSw", wallet: "E2Rv…atYy", usdValue: -1820, tokenAmount: 8860,    ageMin: 58  },
        { action: "SOLD",   walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", usdValue: -890,  tokenAmount: 4330,    ageMin: 84  },
        { action: "BOUGHT", walletFull: "5CgMwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEf8", wallet: "5CgM…CdEf8", usdValue: 1240,  tokenAmount: 6030,    ageMin: 112 },
        { action: "SOLD",   walletFull: "9SLP7vTw5KpKS3rN8FQzMxYHcVgPq2DnEjRbWaXuKpKS", wallet: "9SLP…KpKS", usdValue: -1380, tokenAmount: 6710,    ageMin: 147 },
        { action: "BOUGHT", walletFull: "3LpMwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEfG", wallet: "3LpM…CdEfG", usdValue: 425,   tokenAmount: 2070,    ageMin: 189 },
        { action: "SOLD",   walletFull: "E2RvKpL5atYyN8mQzXq2wEr8tYrKpL5nVcBxHaGfDjSw", wallet: "E2Rv…atYy", usdValue: -2680, tokenAmount: 13040,   ageMin: 234 },
        { action: "BOUGHT", walletFull: "5CgMwQrTsVxYzBcDeFgHjKlMnOpQrStUvWxYzAbCdEf8", wallet: "5CgM…CdEf8", usdValue: 318,   tokenAmount: 1550,    ageMin: 281 },
        { action: "SOLD",   walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", usdValue: -1140, tokenAmount: 5540,    ageMin: 326 },
      ],
      walletsWithActivity: 5,
      totalCheckedWallets: 10,
      netFlowUsd: -7765,
      windowHours: 6,
    },
  },
  "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump": {
    score: 500, risk: "DANGER", confidence: 100,
    tokenSymbol: "pippin", tokenName: "Pippin",
    resolvedMint: "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump",
    mintAuthority: false, freezeAuthority: false, honeypot: false,
    lpBurned: true, lpLocked: false, lpLockedPct: 100,
    liquidity: 4448431, marketCap: 26242298, priceUsd: 0.02743,
    holders: 26601, volume24h: 3060000, volume1h: 158000,
    priceChange5m: -0.41, priceChange1h: -2.18, priceChange24h: -6.91,
    solscanTokenAgeHours: 12838,
    tokenLogo: "https://cdn.dexscreener.com/cms/images/d237de55618e54fd7d66593ff2adf3ad8c092398f9049a31f1dcb1b23ad1dff8?width=800&height=800&quality=95&format=auto",
    flags: [
      { severity: "critical", label: "Single wallet holds 27% of supply" },
      { severity: "warning", label: "Top 10 wallets hold 67% of supply" },
      { severity: "bonus", label: "LP Burned 100% (GoPlus) ✓" },
      { severity: "bonus", label: "Established token (30d+) ✓" },
    ],
    pair: {
      url: "https://dexscreener.com/solana/8wwcnqdzjcy5pt7akhupafknv2txca9sq6ybkgzlbvdt",
      info: {
        websites: [{ url: "https://pippin.love/", label: "Website" }],
        socials: [
          { url: "https://x.com/ThePippinCo", type: "twitter" },
          { url: "http://t.me/ThePippinCo", type: "telegram" },
        ],
      },
      // DANGER narrative — clear distribution pressure (sells dominate
      // in every window). volume/LP ratio 0.7× = no wash flag; the
      // verdict comes from concentration, not wash.
      txns: {
        m5:  { buys: 4,   sells: 9    },
        h1:  { buys: 70,  sells: 145  },
        h6:  { buys: 380, sells: 700  },
        h24: { buys: 540, sells: 1010 },
      },
      volume: { m5: 12750, h1: 158000, h6: 768000, h24: 3060000 },
    },
    topHolderPct: 27.44, top10HolderPct: 68.11,
    criticalActors: [
      { type: "insider", tag: "Insider", pct: 27.4, addr: "u6PJ…Xq2w", repLbl: "Concentration risk · single wallet", repWidth: 95, repWarn: false, desc: "Holds <b>27.4%</b> of supply — one-wallet dump would crash the price." },
    ],
    holderActivity: {
      rows: [
        { role: "bot", label: "Static", avatar: "Insider", pctChange: 0, pctChangeDisp: "±0%", addr: "u6PJ…Xq2w", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
        { role: "whale-big", label: "Static", avatar: "Whale", pctChange: 0, pctChangeDisp: "±0%", addr: "9ZPs…E4Y4", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
        { role: "whale-big", label: "Static", avatar: "Whale", pctChange: 0, pctChangeDisp: "±0%", addr: "4QuB…s5ru", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
      ],
      netFlowPct: 0, netFlowDirection: "flat",
    },
    outcomeStats: {
      timeToRugMedianDisp: "11h", timeToRugMedianHours: 11, timeToRugSampleSize: 312,
      pctRugged24h: 76, pctSlowDeath: 16, pctAlive30d: 8,
      distribution: [3,5,8,11,14,12,9,7,5,4,3,2.5,2,1.8,1.6,1.4,1.2,1,0.9,0.8,0.7,0.7,0.6,0.6,0.5,0.5,0.4,0.4,0.3,0.3,0.3,0.3,0.4,0.5,0.7,0.9],
      youBucketIndex: 17,
      mostSimilar: [
        { symbol: "PUMPDUMP", ruggedAfterHours: 18, loss: -94.1 },
        { symbol: "FAKEMOON", ruggedAfterHours: 28, loss: -91.6 },
        { symbol: "SLOWBLEED", ruggedAfterHours: 48, loss: -85.4 },
      ],
    },
    verdictHistory: [{ ts: _demoTs - 3600000, verdict: "DANGER", score: 500, event: "Single wallet holds 27% of supply" }],
    sources_used: ["dexscreener", "rugcheck", "goplus", "helius", "solscan", "chart"],
    aiSummary: "Pippin lands on DANGER because of stacked concentration risk — a single wallet holds 27% of supply and the top 10 wallets together control 67%. Either of those alone would already trigger a soft block; together they make a coordinated dump trivially possible. The LP is burned and the contract is clean (no mint, no freeze, no honeypot), which keeps the verdict from collapsing all the way to RUG, but the holder structure alone is enough to treat this as exit-liquidity risk.",
    fetchedAt: _demoTs,
    // DANGER narrative — the 27% insider wallet (#1) is actively
    // dumping. Top-10 cluster all selling in coordination. Net flow
    // strongly negative. Feed scrolls past viewport so the user sees
    // the cascade. The story: someone with concentration is leaving.
    demoActivity: {
      wallets: [
        { walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", pctSupply: 27.4, holdings: 273000000, active: true  },
        { walletFull: "9ZPsKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaGfDj", wallet: "9ZPs…E4Y4", pctSupply: 11.2, holdings: 112000000, active: true  },
        { walletFull: "4QuBpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAbCd", wallet: "4QuB…s5ru", pctSupply: 8.7,  holdings: 87000000,  active: true  },
        { walletFull: "7TwCpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb12", wallet: "7TwC…Ab12", pctSupply: 5.4,  holdings: 54000000,  active: true  },
        { walletFull: "5VxDpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb34", wallet: "5VxD…Ab34", pctSupply: 4.1,  holdings: 41000000,  active: true  },
        { walletFull: "3YzEpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb56", wallet: "3YzE…Ab56", pctSupply: 3.6,  holdings: 36000000,  active: true  },
        { walletFull: "8AwFpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb78", wallet: "8AwF…Ab78", pctSupply: 2.9,  holdings: 29000000,  active: false },
        { walletFull: "6BvGpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb90", wallet: "6BvG…Ab90", pctSupply: 2.4,  holdings: 24000000,  active: true  },
        { walletFull: "2CuHpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAbAB", wallet: "2CuH…AbAB", pctSupply: 1.7,  holdings: 17000000,  active: false },
        { walletFull: "9DtIpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAbCD", wallet: "9DtI…AbCD", pctSupply: 0.7,  holdings: 7000000,   active: false },
      ],
      activity: [
        { action: "SOLD",   walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", usdValue: -18400, tokenAmount: 670680,  ageMin: 6   },
        { action: "SOLD",   walletFull: "9ZPsKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaGfDj", wallet: "9ZPs…E4Y4", usdValue: -9650,  tokenAmount: 351850,  ageMin: 14  },
        { action: "SOLD",   walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", usdValue: -12200, tokenAmount: 444770,  ageMin: 23  },
        { action: "SOLD",   walletFull: "4QuBpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAbCd", wallet: "4QuB…s5ru", usdValue: -6840,  tokenAmount: 249360,  ageMin: 37  },
        { action: "SOLD",   walletFull: "7TwCpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb12", wallet: "7TwC…Ab12", usdValue: -4250,  tokenAmount: 154940,  ageMin: 52  },
        { action: "SOLD",   walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", usdValue: -15800, tokenAmount: 575870,  ageMin: 71  },
        { action: "BOUGHT", walletFull: "3YzEpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb56", wallet: "3YzE…Ab56", usdValue: 1840,   tokenAmount: 67080,   ageMin: 88  },
        { action: "SOLD",   walletFull: "5VxDpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb34", wallet: "5VxD…Ab34", usdValue: -3920,  tokenAmount: 142890,  ageMin: 104 },
        { action: "SOLD",   walletFull: "9ZPsKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaGfDj", wallet: "9ZPs…E4Y4", usdValue: -7320,  tokenAmount: 266860,  ageMin: 132 },
        { action: "SOLD",   walletFull: "6BvGpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb90", wallet: "6BvG…Ab90", usdValue: -2180,  tokenAmount: 79470,   ageMin: 158 },
        { action: "SOLD",   walletFull: "u6PJ4mQzXq2wEr8tYrKpL5nVcBxHaGfDjSwRtPmNxQ2w", wallet: "u6PJ…Xq2w", usdValue: -21400, tokenAmount: 780170,  ageMin: 183 },
        { action: "BOUGHT", walletFull: "3YzEpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb56", wallet: "3YzE…Ab56", usdValue: 920,    tokenAmount: 33540,   ageMin: 215 },
        { action: "SOLD",   walletFull: "4QuBpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAbCd", wallet: "4QuB…s5ru", usdValue: -5680,  tokenAmount: 207090,  ageMin: 248 },
        { action: "SOLD",   walletFull: "9ZPsKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaGfDj", wallet: "9ZPs…E4Y4", usdValue: -4140,  tokenAmount: 150930,  ageMin: 284 },
        { action: "SOLD",   walletFull: "7TwCpNxMs5ruWyZaBcDeFgHjKlMnOpQrStUvWxYzAb12", wallet: "7TwC…Ab12", usdValue: -2860,  tokenAmount: 104280,  ageMin: 321 },
      ],
      walletsWithActivity: 7,
      totalCheckedWallets: 10,
      netFlowUsd: -111880,
      windowHours: 6,
    },
  },
  "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump": {
    score: 250, risk: "RUG", confidence: 100,
    tokenSymbol: "HawkTuah", tokenName: "Hawk Tuah",
    resolvedMint: "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump",
    mintAuthority: false, freezeAuthority: false, honeypot: false,
    lpBurned: true, lpLocked: false, lpLockedPct: 100,
    liquidity: 70520, marketCap: 155682, priceUsd: 0.0001702,
    holders: 7430, volume24h: 1245, volume1h: 84,
    priceChange5m: -1.8, priceChange1h: -4.2, priceChange24h: -12.6,
    solscanTokenAgeHours: 16275,
    tokenLogo: "https://cdn.dexscreener.com/cms/images/17c35e4d62131992b5c58bf5cb9d9878a64828389eddc2416416ffac68b38d25?width=800&height=800&quality=95&format=auto",
    flags: [
      { severity: "critical", label: "Single wallet holds 44% of supply" },
      { severity: "bonus", label: "LP Burned 100% (GoPlus) ✓" },
      { severity: "bonus", label: "Established token (30d+) ✓" },
    ],
    pair: {
      url: "https://dexscreener.com/solana/errdtwwykdz37ogvjdruq2txnc9ntx78x32pnxwpeq7l",
      info: {
        websites: [
          { url: "https://hawktuah.vip/", label: "Website" },
          { url: "https://coinmarketcap.com/currencies/hawk-tuah", label: "CMC" },
          { url: "https://www.coingecko.com/en/coins/hawk-tuah", label: "Coin Gecko" },
        ],
        socials: [
          { url: "https://x.com/solhawktuah", type: "twitter" },
          { url: "https://t.me/hawktuah_sol", type: "telegram" },
        ],
      },
      // RUG narrative — abandoned token. Tiny trades cycling on thin
      // LP triggers a wash warning (avg $30 trade on $70K LP). Strong
      // distribution skew. Volume too small for volRatioScore.
      txns: {
        m5:  { buys: 0,  sells: 1  },
        h1:  { buys: 1,  sells: 3  },
        h6:  { buys: 4,  sells: 14 },
        h24: { buys: 12, sells: 28 },
      },
      volume: { m5: 18, h1: 84, h6: 380, h24: 1245 },
    },
    topHolderPct: 43.98, top10HolderPct: 53.64,
    criticalActors: [
      { type: "insider", tag: "Insider", pct: 44, addr: "HsXp…wG31", repLbl: "Concentration risk · single wallet", repWidth: 95, repWarn: false, desc: "Holds <b>44.0%</b> of supply — one-wallet dump would crash the price." },
    ],
    holderActivity: {
      rows: [
        { role: "bot", label: "Static", avatar: "Insider", pctChange: 0, pctChangeDisp: "±0%", addr: "HsXp…wG31", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
        { role: "whale-big", label: "Static", avatar: "Whale", pctChange: 0, pctChangeDisp: "±0%", addr: "CcSX…1e82", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
        { role: "real", label: "Static", avatar: "Retail", pctChange: 0, pctChangeDisp: "±0%", addr: "9eop…AjHo", desc: "No movement <b>last 1h</b>. Position dormant — wallets at this size often wake near concentration peaks." },
      ],
      netFlowPct: 0, netFlowDirection: "flat",
    },
    outcomeStats: {
      timeToRugMedianDisp: "11h", timeToRugMedianHours: 11, timeToRugSampleSize: 312,
      pctRugged24h: 76, pctSlowDeath: 16, pctAlive30d: 8,
      distribution: [3,5,8,11,14,12,9,7,5,4,3,2.5,2,1.8,1.6,1.4,1.2,1,0.9,0.8,0.7,0.7,0.6,0.6,0.5,0.5,0.4,0.4,0.3,0.3,0.3,0.3,0.4,0.5,0.7,0.9],
      youBucketIndex: 17,
      mostSimilar: [
        { symbol: "PUMPDUMP", ruggedAfterHours: 18, loss: -94.1 },
        { symbol: "FAKEMOON", ruggedAfterHours: 28, loss: -91.6 },
        { symbol: "SLOWBLEED", ruggedAfterHours: 48, loss: -85.4 },
      ],
    },
    verdictHistory: [{ ts: _demoTs - 3600000, verdict: "RUG", score: 250, event: "Single wallet holds 44% of supply" }],
    sources_used: ["dexscreener", "rugcheck", "goplus", "helius", "solscan", "chart"],
    aiSummary: "Hawk Tuah is the textbook concentration rug — a single wallet holds 44% of total supply, more than enough to crash the price to zero in one transaction. LP is technically burned and the token has 30d+ of trading history, but those signals are completely overridden by the wallet concentration: the dev (or whoever controls that wallet) can dump at any moment and the remaining holders cannot defend the price. Hard kill. Treat any remaining liquidity as exit-only.",
    fetchedAt: _demoTs,
    // RUG narrative — abandoned post-pump. Dev wallet (#1, 44%) made
    // its big exit weeks ago; the remaining holders are slowly bleeding
    // out into a near-dead LP. Net flow tiny but every trade is a sell.
    demoActivity: {
      wallets: [
        { walletFull: "HsXpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaGwG31", wallet: "HsXp…wG31", pctSupply: 44.0, holdings: 440000000, active: true  },
        { walletFull: "CcSXKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHa1e82", wallet: "CcSX…1e82", pctSupply: 4.8,  holdings: 48000000,  active: true  },
        { walletFull: "9eopKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaAjHo", wallet: "9eop…AjHo", pctSupply: 1.6,  holdings: 16000000,  active: false },
        { walletFull: "5RxpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB1c", wallet: "5Rxp…aB1c", pctSupply: 1.2,  holdings: 12000000,  active: true  },
        { walletFull: "3FjpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB2d", wallet: "3Fjp…aB2d", pctSupply: 0.7,  holdings: 7000000,   active: false },
        { walletFull: "8DwpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB3e", wallet: "8Dwp…aB3e", pctSupply: 0.4,  holdings: 4000000,   active: false },
        { walletFull: "2GxpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB4f", wallet: "2Gxp…aB4f", pctSupply: 0.3,  holdings: 3000000,   active: false },
        { walletFull: "6HypKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB5g", wallet: "6Hyp…aB5g", pctSupply: 0.25, holdings: 2500000,   active: false },
        { walletFull: "4JzpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB6h", wallet: "4Jzp…aB6h", pctSupply: 0.2,  holdings: 2000000,   active: false },
        { walletFull: "7KapKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB7i", wallet: "7Kap…aB7i", pctSupply: 0.15, holdings: 1500000,   active: false },
      ],
      activity: [
        { action: "SOLD", walletFull: "HsXpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaGwG31", wallet: "HsXp…wG31", usdValue: -47,  tokenAmount: 276000,  ageMin: 23  },
        { action: "SOLD", walletFull: "CcSXKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHa1e82", wallet: "CcSX…1e82", usdValue: -28,  tokenAmount: 164500,  ageMin: 67  },
        { action: "SOLD", walletFull: "5RxpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB1c", wallet: "5Rxp…aB1c", usdValue: -12,  tokenAmount: 70500,   ageMin: 118 },
        { action: "SOLD", walletFull: "HsXpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaGwG31", wallet: "HsXp…wG31", usdValue: -82,  tokenAmount: 481800, ageMin: 174 },
        { action: "SOLD", walletFull: "CcSXKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHa1e82", wallet: "CcSX…1e82", usdValue: -18,  tokenAmount: 105800, ageMin: 234 },
        { action: "SOLD", walletFull: "5RxpKvWyE4Y4nR8TmQzXq2wEr8tYrKpL5nVcBxHaaB1c", wallet: "5Rxp…aB1c", usdValue: -9,   tokenAmount: 52900,  ageMin: 298 },
      ],
      walletsWithActivity: 3,
      totalCheckedWallets: 10,
      netFlowUsd: -196,
      windowHours: 6,
    },
  },
};

function setLoadingStatus(msg) {
  const el = document.getElementById("loading-status");
  if (el) el.textContent = msg;
}

function showError(msg) {
  document.getElementById("loading").style.display = "none";
  const errEl = document.getElementById("err");
  const msgEl = document.getElementById("err-msg");
  if (msgEl) msgEl.textContent = msg || "Analysis failed. Please try again.";
  errEl.style.display = "block";
  const retryBtn = document.getElementById("err-retry");
  if (retryBtn) retryBtn.style.display = "inline-block";
}

const onRetryStatus = (attempt, max) =>
  setLoadingStatus(`Retrying... (${attempt}/${max})`);

if (!ca) {
  document.getElementById("loading").style.display = "none";
  showError("No token address provided.");
} else if (isDemo && DEMO_DATA[ca]) {
  document.getElementById("loading").style.display = "none";
  render(DEMO_DATA[ca], ca);
} else {
  document.getElementById("err-retry").addEventListener("click", () => {
    document.getElementById("err").style.display = "none";
    document.getElementById("loading").style.display = "flex";
    setLoadingStatus("");
    fetchWithRetry(`${API}?ca=${ca}`, { onRetry: onRetryStatus })
      .then((d) => render(d, ca))
      .catch(() => showError("Analysis failed after multiple attempts. Please try again later."));
  });

  fetchWithRetry(`${API}?ca=${ca}`, { onRetry: onRetryStatus })
    .then((d) => render(d, ca))
    .catch(() => showError("Analysis failed after multiple attempts. Please try again later."));
}

// ──────────────────────────────────────────────────────────────────────
// render(d, ca) — compose the full page layout from a /api/scan response
// and wire up event handlers. Idempotent: safe to call again on manual
// refresh; the setupXxx helpers all guard with `window.__xxxInit` flags
// so listeners don't double-bind.
// ──────────────────────────────────────────────────────────────────────
function render(d, ca) {
  document.getElementById("loading").style.display = "none";

  const RC = { SAFE: "safe", CAUTION: "caution", DANGER: "danger", RUG: "rug" };
  const LB = { SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER", RUG: "RUG PULL" };
  const rc = RC[d.risk] || "danger";
  const lb = LB[d.risk] || d.risk;
  document.body.className = `risk-${rc}`;

  const score = d.score || 0;
  const SCORE_BAND = { SAFE: 1000, CAUTION: 750, DANGER: 500, RUG: 250 };
  const displayScore = SCORE_BAND[d.risk] ?? score;
  const barW = Math.min(100, Math.round(displayScore / 10));
  const conf = typeof d.confidence === "number" ? d.confidence : null;

  const mc = d.marketCap ?? d.pair?.marketCap ?? null;
  const liq = d.liquidity ?? d.pair?.liquidity?.usd ?? null;
  const vol24 = d.volume24h ?? d.pair?.volume?.h24 ?? null;
  const vol1h = d.volume1h ?? d.pair?.volume?.h1 ?? null;
  const priceUsd = d.priceUsd ?? d.pair?.priceUsd ?? null;

  const pc5m = d.priceChange5m ?? d.pair?.priceChange?.m5 ?? null;
  const pc1h = d.priceChange1h ?? d.pair?.priceChange?.h1 ?? null;
  const pc6h = d.pair?.priceChange?.h6 ?? null;
  const pc24h = d.priceChange24h ?? d.pair?.priceChange?.h24 ?? null;

  const name = d.tokenName || d.pair?.baseToken?.name || "";
  const sym = d.tokenSymbol || d.pair?.baseToken?.symbol || "";
  const mint = d.resolvedMint || ca;
  const logo = d.tokenLogo ?? d.pair?.info?.imageUrl ?? null;
  const ageStr = age(d.solscanTokenAgeHours);
  const pairCreated = d.pairCreatedAt ?? d.pair?.pairCreatedAt ?? null;
  const pairDate = pairCreated
    ? new Date(pairCreated).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : null;

  const websites = d.pair?.info?.websites || [];
  const socials = d.pair?.info?.socials || [];
  const candles = d.candles || [];

  const mintAuth = d.mintAuthority ?? null;
  const freezeAuth = d.freezeAuthority ?? null;
  const sellOk = d.honeypot === false || d.risk !== "RUG";

  // Drop bonus + info + legacy "unavailable" warnings from every count
  // and listing on this page. info-severity flags (e.g. "Helius
  // unavailable", "GoPlus unavailable") describe pipeline health, not
  // token risk — they show up under Conf X% already, no need to also
  // appear in flag totals or the Critical Flags expansion.
  const fAll = (d.flags || []).filter((f) => {
    if (f.severity === "bonus" || f.severity === "info") return false;
    if (typeof f.label === "string" && /\bunavailable\b/i.test(f.label)) return false;
    return true;
  });
  const fCrit = fAll.filter((f) => f.severity === "critical");
  const fWarn = fAll.filter((f) => f.severity !== "critical");
  const flagSummary =
    fAll.length === 0
      ? "No issues found"
      : fCrit.length > 0
        ? `${fAll.length} flags — ${fCrit.length} critical`
        : `${fAll.length} flags detected`;

  // ── Update sticky nav (visible on scroll past hero)
  document.getElementById("nav-ticker").innerHTML = sym
    ? `<b>${escapeHtml(sym)}</b>${priceUsd ? " · " + escapeHtml(fmtPrice(priceUsd)) : ""}`
    : "—";
  document.getElementById("nav-verdict").textContent = lb;
  document.getElementById("nav-score").textContent = `${displayScore}/1000`;

  // Host-allowlist for hrefs interpolated into the page. Replaces the
  // earlier regex-based check (^https?://) that accepted ANY HTTPS
  // host — including attacker-controlled ones if a DexScreener pair's
  // `websites[].url` / `socials[].url` / `pair.url` was crafted by a
  // hostile token creator. Clicking from an Antares-trusted page
  // would have lent our reputation to a phishing site.
  //
  // Allows HTTPS only (no HTTP downgrade), exact-match or subdomain
  // of an explicitly-trusted host. New crypto-ecosystem hosts can be
  // added here; everything else collapses to "#" so the anchor renders
  // but does nothing. Anchors also need rel="noopener noreferrer" at
  // the call site (already in place — see lines below).
  const ALLOWED_HOSTS = new Set([
    // Token data / explorers
    "dexscreener.com", "solscan.io", "rugcheck.xyz", "birdeye.so",
    "geckoterminal.com", "explorer.solana.com", "solana.fm", "xray.helius.xyz",
    // Pump / aggregators / DEXes
    "pump.fun", "raydium.io", "jup.ag", "orca.so", "meteora.ag",
    "axiom.trade", "photon-sol.tinyastro.io", "gmgn.ai",
    // Socials (DexScreener returns these in pair.info.socials)
    "x.com", "twitter.com", "t.me", "telegram.org",
    "discord.gg", "discord.com", "github.com", "medium.com",
    "youtube.com", "youtu.be",
    // Antares-owned
    "antaresscan.com", "antares-extension.vercel.app",
  ]);
  function safeUrl(u) {
    if (typeof u !== "string") return "#";
    let parsed;
    try { parsed = new URL(u); } catch { return "#"; }
    if (parsed.protocol !== "https:") return "#";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (ALLOWED_HOSTS.has(host)) return u;
    // Subdomain match — `foo.dexscreener.com` is OK if `dexscreener.com`
    // is on the allowlist. Endswith `.${host}` (with the dot) prevents
    // `evildexscreener.com` from matching `dexscreener.com`.
    for (const allowed of ALLOWED_HOSTS) {
      if (host.endsWith("." + allowed)) return u;
    }
    return "#";
  }
  const dexUrl = d.pair?.url || `https://dexscreener.com/solana/${mint}`;
  document.getElementById("nav-actions").innerHTML = `
    <span class="ca-pill" id="ca-disp">${escapeHtml(caShort)}</span>
    <a href="${safeUrl(dexUrl)}" target="_blank" rel="noopener noreferrer">↗ DexScreener</a>
    <a href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer">↗ Solscan</a>
    <a href="https://rugcheck.xyz/tokens/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer" class="warn">⚠ RugCheck</a>
  `;

  // ── Build flag rows with severity dots
  function severityClass(sev) {
    if (sev === "critical") return "s3";
    if (sev === "warning" || sev === "high") return "s2";
    return "s1";
  }
  const flagsRowsHtml =
    fAll.length === 0
      ? `<div class="flag-row"><div class="flag-icon g">✓</div><div class="flag-body"><div class="flag-label ok">No critical flags detected</div><div class="flag-desc">All sources agree — this token has no automated red flags.</div></div><div></div></div>`
      : fAll
          .filter((f) => {
            const l = f.label || f;
            return !String(l).toLowerCase().includes("unavailable");
          })
          .map((f) => {
            const sev = f.severity || "warning";
            const isCrit = sev === "critical";
            const cls = isCrit ? "cr" : "wr";
            const ic = isCrit ? "r" : "y";
            const ico = isCrit ? "✕" : "!";
            const desc = getFlagDescription(f.label || f);
            return `<div class="flag-row">
            <div class="flag-icon ${ic}">${ico}</div>
            <div class="flag-body">
              <div class="flag-label ${cls}">${escapeHtml(f.label || f)}</div>
              ${desc ? `<div class="flag-desc">${escapeHtml(desc)}</div>` : ""}
            </div>
            <div class="sev ${severityClass(sev)}"><div class="d"></div><div class="d"></div><div class="d"></div></div>
          </div>`;
          })
          .join("");

  const flagsCount =
    fAll.length === 0 ? "0 flags detected" : `${fAll.length} flags detected`;
  const critWarnText =
    fCrit.length > 0 || fWarn.length > 0 ? `${fCrit.length} critical · ${fWarn.length} warning` : "";

  // ── Security strip cells
  function siBool(label, val, invert) {
    if (val == null)
      return `<div class="sec-cell neu"><div class="lbl">${label}</div><div class="val">—</div></div>`;
    const yes = invert ? !val : !!val;
    return `<div class="sec-cell ${yes ? "y" : "n"}"><div class="lbl">${label}</div><div class="val">${yes ? "✓" : "✕"}</div></div>`;
  }
  const lpCell = (() => {
    if (d.lpBurned) return `<div class="sec-cell y"><div class="lbl">LP</div><div class="val">BURN</div></div>`;
    if (d.lpLocked) return `<div class="sec-cell w"><div class="lbl">LP</div><div class="val">LOCK</div></div>`;
    if (d.lpBurned == null && d.lpLocked == null)
      return `<div class="sec-cell neu"><div class="lbl">LP</div><div class="val">—</div></div>`;
    return `<div class="sec-cell n"><div class="lbl">LP</div><div class="val">✕</div></div>`;
  })();
  const liqCell =
    liq != null
      ? `<div class="sec-cell ${liq < 5000 ? "n" : liq > 50000 ? "y" : "w"}"><div class="lbl">Liq</div><div class="val">${escapeHtml(fmt(liq))}</div></div>`
      : `<div class="sec-cell neu"><div class="lbl">Liq</div><div class="val">—</div></div>`;
  const secStripHtml = `
    <div class="sec-cell ${sellOk ? "y" : "n"}"><div class="lbl">Sell</div><div class="val">${sellOk ? "✓" : "✕"}</div></div>
    ${siBool("Mint", mintAuth, true)}
    ${siBool("Freeze", freezeAuth, true)}
    ${lpCell}
    ${liqCell}
  `;

  // ── Hero pieces
  const tkLineHtml = sym
    ? `<div class="tk-line"><b>${escapeHtml(sym)}</b>${name ? " " + escapeHtml(name) : ""}</div>`
    : "";
  const ageBadgeHtml = ageStr
    ? `<span class="age-badge">${escapeHtml(ageStr)}${d.holders != null ? " · " + d.holders.toLocaleString() + " holders" : ""}</span>`
    : pairDate
      ? `<span class="age-badge">Pair: ${escapeHtml(pairDate)}</span>`
      : "";
  // Logo wrap : fallback letters always rendered as the bottom layer; the
  // <img> sits on top via z-index. If the image fails to load (CORS, 404,
  // bad scheme) onerror removes it and the fallback shows through.
  const tokenLogoHtml =
    logo || sym
      ? `<div class="token-logo-wrap">
        ${sym ? `<div class="token-logo-fallback">${escapeHtml(sym.slice(0, 4))}</div>` : ""}
        ${logo ? `<img class="token-logo" src="${safeUrl(logo)}" alt="${escapeHtml(sym)}" onerror="this.remove()"/>` : ""}
      </div>`
      : "";

  const socialsHtml = [
    ...websites.map(
      (w) =>
        `<a class="soc" href="${safeUrl(w.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.label || "Website")}</a>`,
    ),
    ...socials.map(
      (s) =>
        `<a class="soc" href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.type || "Social")}</a>`,
    ),
  ].join("");

  // Market Cap card — sparkline still uses price candles (live signal),
  // but the headline metric is FDV market cap. Sub-line keeps the unit
  // price as secondary context.
  const sparklineHtml = buildSparkline(candles);
  const change24 = pc24h != null ? pct(pc24h) : null;
  const priceCardHtml = `
    <div class="m-card">
      <div class="m-label-row"><div class="m-label">Market Cap</div></div>
      <div class="m-big alt">${escapeHtml(mc != null ? fmt(mc) : "—")}</div>
      ${sparklineHtml}
      ${change24 ? `<div class="m-sub ${change24.cls}">${escapeHtml(change24.txt)} · 24h</div>` : priceUsd ? `<div class="m-sub">${escapeHtml(fmtPrice(priceUsd))} per token</div>` : ""}
    </div>
  `;

  // ── Holder concentration card (only if data present)
  function extractPctFromFlag(flags, regex) {
    for (const f of flags || []) {
      const label = String(f.label || "");
      const m = label.match(regex);
      if (m) return Math.min(100, Math.max(0, parseInt(m[1])));
    }
    return null;
  }
  const top10Pct =
    typeof d.top10HolderPct === "number"
      ? Math.round(d.top10HolderPct)
      : extractPctFromFlag(d.flags, /Top\s*10\s*holders\s*[>≥]\s*(\d+)\s*%/i);
  const top1Pct =
    typeof d.topHolderPct === "number"
      ? Math.round(d.topHolderPct)
      : extractPctFromFlag(d.flags, /Single\s*wallet\s*holds\s*(\d+)\s*%/i) ??
        extractPctFromFlag(d.flags, /(?:Owner|Creator)\s*holds\s*[>≥]\s*(\d+)\s*%/i);

  let holdersSectionHtml = "";
  if (top10Pct !== null && d.holders != null) {
    const t1 = top1Pct !== null ? Math.min(top1Pct, top10Pct) : Math.round(top10Pct * 0.3);
    const t10 = top10Pct - t1;
    const remainder = 100 - top10Pct;
    const t50 = Math.round(remainder * 0.5);
    const rest = 100 - t1 - t10 - t50;
    holdersSectionHtml = `
      <div class="section-label" data-toggle="holders-card">
        <span>Holder Concentration</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="holders-card" id="holders-card">
        <div class="lbl">${escapeHtml(d.holders.toLocaleString())} holders · top wallets dominate supply</div>
        <div class="hbar">
          <div class="seg top1" style="width:${t1}%">${t1 >= 6 ? t1 + "%" : ""}</div>
          <div class="seg top10" style="width:${t10}%">${t10 >= 6 ? t10 + "%" : ""}</div>
          <div class="seg top50" style="width:${t50}%">${t50 >= 6 ? t50 + "%" : ""}</div>
          <div class="seg rest" style="width:${rest}%">${rest >= 6 ? rest + "%" : ""}</div>
        </div>
        <div class="hbar-legend">
          <span><span class="dot top1"></span>Top 1${top1Pct !== null ? "" : " (est.)"}</span>
          <span><span class="dot top10"></span>Top 2–10</span>
          <span><span class="dot top50"></span>Top 11–50 (est.)</span>
          <span><span class="dot rest"></span>Rest</span>
        </div>
      </div>
    `;
  } else if (d.holders != null) {
    holdersSectionHtml = `
      <div class="section-label" data-toggle="holders-card">
        <span>Holder Concentration</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="holders-card" id="holders-card">
        <div class="lbl">${escapeHtml(d.holders.toLocaleString())} holders · distribution data unavailable</div>
      </div>
    `;
  }

  // ── On-chain grid
  const onChainCells = [
    d.holders != null && ["Holders", d.holders.toLocaleString()],
    d.solscanTrades24h != null && ["Trades 24h", d.solscanTrades24h.toLocaleString()],
    d.solscanTraders24h != null && ["Traders 24h", d.solscanTraders24h.toLocaleString()],
    d.solscanTokenAgeHours != null && ["Token Age", formatAgeHours(d.solscanTokenAgeHours)],
    d.tokenSupply != null && ["Supply", fmt(d.tokenSupply).replace("$", "")],
    d.tokenCreator && [
      "Creator",
      `<a href="https://solscan.io/account/${encodeURIComponent(d.tokenCreator)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.tokenCreator.slice(0, 6) + "…" + d.tokenCreator.slice(-4))}<span class="ext">↗</span></a>`,
    ],
  ].filter(Boolean);
  const onChainHtml =
    onChainCells.length > 0
      ? onChainCells
          .map(
            ([label, val]) =>
              `<div class="oc-cell"><div class="lbl">${escapeHtml(label)}</div><div class="val">${val}</div></div>`,
          )
          .join("")
      : "";

  // ── Deep Analysis tabs
  const sniperMapTabHtml = buildSniperMapTab(d);
  const exitLiquidityTabHtml = buildExitLiquidityTab(liq);
  const criticalActorsHtml = buildCriticalActorsPreview(d);
  const insiderWatchTabHtml = buildInsiderWatchTab(d);
  const buySellFlowTabHtml = buildBuySellFlowTab(d);
  const washVolumeTabHtml = buildWashVolumeTab(d);

  // ── Source breakdown rows
  const sourceListHtml = buildSourceListRows(d);

  // ── Sources marquee (deduplicated)
  const FIXED_SOURCES = ["DexScreener", "RugCheck", "Helius", "Solscan", "Chart Analysis"];
  const apiSources = Array.isArray(d.sources_used) ? d.sources_used : [];
  const allSources = [
    ...new Map([...FIXED_SOURCES, ...apiSources].map((s) => [String(s).toLowerCase(), s])).values(),
  ];
  const marqueeItem = (s) => `<div class="mi"><span class="ok">✓</span>${escapeHtml(s)}</div>`;
  const marqueeOnce = allSources.map(marqueeItem).join("");
  const marqueeHtml = marqueeOnce + marqueeOnce;

  // ── AI summary state: render now if available, else placeholder + async fetch
  const aiBodyHtml = d.aiSummary
    ? `<div class="ai-body">${escapeHtml(d.aiSummary)}</div>`
    : `<div class="ai-loading">Generating analysis…</div>`;

  // SVG icons for tabs — custom line-stroke set, monochrome (currentColor).
  // Keys match the tab `data-tab` values used in the deep-analysis strip.
  const ICONS = {
    insider: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="5" r="2.4"/><path d="M2 12 C2 9.5 4.5 8 7 8 C9.5 8 12 9.5 12 12"/></svg>`,
    flow: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4 L11 4 M8.5 1.5 L11 4 L8.5 6.5"/><path d="M12 10 L3 10 M5.5 7.5 L3 10 L5.5 12.5"/></svg>`,
    wash: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8 C3 6 4 9 5.5 7.5 C7 6 8 9 9.5 7.5 C11 6 11.5 8 12.5 7.5"/><path d="M1.5 11 C3 9 4 12 5.5 10.5 C7 9 8 12 9.5 10.5 C11 9 11.5 11 12.5 10.5"/></svg>`,
    sniper: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><circle cx="7" cy="7" r="1.6"/><line x1="7" y1="0.5" x2="7" y2="2"/><line x1="7" y1="12" x2="7" y2="13.5"/><line x1="0.5" y1="7" x2="2" y2="7"/><line x1="12" y1="7" x2="13.5" y2="7"/></svg>`,
    exit: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4 L5 4 L5 7 L8 7 L8 10 L13 10"/></svg>`,
  };

  // ── Compose the page
  const wrap = document.getElementById("content");
  wrap.innerHTML = `
    <section class="hero" data-verdict="${escapeHtml(lb)}">
      <div class="verdict-info">
        <div class="hero-eye">Token Analysis${conf !== null ? " · Conf " + conf + "%" : ""}</div>
        <div class="verdict-row">
          <h1 data-verdict="${escapeHtml(lb)}">${escapeHtml(lb)}</h1>
          ${tokenLogoHtml}
        </div>
        ${tkLineHtml}
        <div class="meta-row">
          ${ageBadgeHtml}
          ${socialsHtml}
        </div>
        <div class="metrics-row">
          <div class="m-card">
            <div class="m-label-row">
              <div class="m-label">Risk Score</div>
              ${!isDemo ? `<button class="refresh-btn" id="refresh-btn" aria-label="Refresh scan" title="Force a fresh scan, bypassing the cache">↻</button>` : ""}
            </div>
            <div class="m-big">${displayScore}<span class="denom">/ 1000</span></div>
            <div class="sbar"><div class="sbar-fill" id="sbarf"></div></div>
            <div class="m-sub risk">${escapeHtml(flagSummary)}${conf !== null ? " · Conf " + conf + "%" : ""}</div>
            <div class="m-fresh" id="m-fresh">Scanned just now</div>
          </div>
          ${priceCardHtml}
        </div>
      </div>
    </section>

    <div class="section-label" data-toggle="flags-card">
      <span>Critical Flags</span><span class="hr"></span><span class="chev">▾</span>
    </div>
    <div class="flags-card" id="flags-card">
      <div class="flags-head">
        <span class="lbl">${escapeHtml(flagsCount)}</span>
        ${critWarnText ? `<span class="count">${escapeHtml(critWarnText)}</span>` : ""}
      </div>
      ${flagsRowsHtml}
    </div>

    <div class="section-label" data-toggle="ai-section">
      <span>AI Verdict</span><span class="hr"></span><span class="chev">▾</span>
    </div>
    <div class="ai-card" id="ai-section">
      <div class="ai-head">
        <span class="icon">⬡</span>
        <h3>Synthesis</h3>
      </div>
      <div class="ai-body-wrap">${aiBodyHtml}</div>
    </div>

    <div class="section-label" data-toggle="sec-strip">
      <span>Security</span><span class="hr"></span><span class="chev">▾</span>
    </div>
    <div class="sec-strip" id="sec-strip">${secStripHtml}</div>

    ${
      criticalActorsHtml
        ? `
      <div class="section-label" data-toggle="whales-preview">
        <span>Critical Actors</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="whales-preview" id="whales-preview">${criticalActorsHtml}</div>
    `
        : ""
    }

    <div class="section-label" data-toggle="deep">
      <span>Deep Analysis</span><span class="hr"></span><span class="chev">▾</span>
    </div>
    <div class="deep" id="deep">
      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="insider"><span class="tab-icon">${ICONS.insider}</span> Insider Watch</button>
        <button class="tab" data-tab="flow"><span class="tab-icon">${ICONS.flow}</span> Buy/Sell Flow</button>
        <button class="tab" data-tab="wash"><span class="tab-icon">${ICONS.wash}</span> Wash Volume</button>
        <button class="tab" data-tab="sniper"><span class="tab-icon">${ICONS.sniper}</span> Sniper Map</button>
        <button class="tab" data-tab="exit"><span class="tab-icon">${ICONS.exit}</span> Exit Liquidity</button>
      </div>
      <div class="tab-content">
        <div class="tab-pane active" data-pane="insider">${insiderWatchTabHtml}</div>
        <div class="tab-pane" data-pane="flow">${buySellFlowTabHtml}</div>
        <div class="tab-pane" data-pane="wash">${washVolumeTabHtml}</div>
        <div class="tab-pane" data-pane="sniper">${sniperMapTabHtml}</div>
        <div class="tab-pane" data-pane="exit">${exitLiquidityTabHtml}</div>
      </div>
    </div>

    ${
      sourceListHtml
        ? `
      <div class="section-label closed" data-toggle="src-list">
        <span>Source Breakdown</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="src-list collapsed" id="src-list">${sourceListHtml}</div>
    `
        : ""
    }

    <div class="marquee-wrap">
      <div class="marquee-inner">${marqueeHtml}</div>
    </div>
  `;

  // Wire up animations + reveal observer (one-shot init guarded inside)
  setupCursorGlow();
  setupStickyNav();
  setupRevealObserver();
  setupCollapsibles();
  setupTabs();
  setupRefreshButton(ca, { onRefresh: (isDemo && DEMO_DATA[ca]) ? () => render(DEMO_DATA[ca], ca) : (data) => render(data, ca) });
  setupFreshnessTicker(d.fetchedAt);

  // Score bar animation
  setTimeout(() => {
    const b = document.getElementById("sbarf");
    if (b) b.style.width = barW + "%";
  }, 350);

  // Score Breakdown bars: animate width on render (deep analysis tab is open by default)
  setTimeout(() => {
    document.querySelectorAll(".bd-bar[data-w]").forEach((b) => {
      b.style.width = b.dataset.w + "%";
    });
  }, 400);

  // Async-load Top 10 live activity feed (Insider Watch tab). Fired
  // after the synchronous render so the placeholder skeleton is
  // already painted; the API is server-side cached 60s so most loads
  // are sub-200ms. In demo mode we render pre-baked demoActivity
  // synchronously instead — the live /api/graph call would return an
  // empty feed for the hardcoded PENGU/FARTCOIN/PIPPIN/HAWK CAs anyway
  // (real top-10 wallets on these tokens vary day-to-day) so the demo
  // page would land on the loading skeleton forever without this.
  if (isDemo && DEMO_DATA[ca] && DEMO_DATA[ca].demoActivity) {
    setTimeout(() => {
      renderDemoInsiderActivity(DEMO_DATA[ca].demoActivity);
    }, 50);
  } else if (!isDemo) {
    setTimeout(() => {
      loadInsiderActivity();
    }, 50);
  }

  // Async-load AI summary if not in initial response
  if (!d.aiSummary) {
    fetch(`${API}?ca=${ca}&ai=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const slot = document.querySelector("#ai-section .ai-loading, #ai-section .ai-body");
        if (!slot) return;
        if (data && data.aiSummary) {
          slot.outerHTML = `<div class="ai-body">${escapeHtml(data.aiSummary)}</div>`;
        } else {
          slot.outerHTML = `<div class="ai-body" style="color:#444">AI analysis unavailable for this token.</div>`;
        }
      })
      .catch(() => {
        const slot = document.querySelector("#ai-section .ai-loading, #ai-section .ai-body");
        if (slot) slot.outerHTML = `<div class="ai-body" style="color:#444">AI analysis unavailable for this token.</div>`;
      });
  }
}
