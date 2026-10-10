// js/views.js — HTML-string builders for the /token page.
//
// Every function here is pure: takes a /api/scan response (or a slice
// of it) and returns an HTML string. No DOM mutation, no event wiring,
// no fetches. The page orchestrator (token-app.js) interpolates these
// strings into innerHTML and wires up events afterwards.
//
// Keeping the builders separated from `setupXxx` event handlers and the
// network layer means each tab body can be reasoned about, tested, and
// edited without touching the surrounding page state.

import {
  fmt,
  escapeHtml,
  escapeHtmlAllowBold,
} from "./formatters.js";
import {
  computeExitLiquidity,
  parsePctFromFlags,
} from "./compute.js";

// ──────────────────────────────────────────────────────────────────────
// Sparkline: builds an inline SVG polyline from candle close prices.
// Returns "" if not enough data so callers can conditionally render.
// Color follows the verdict via the --risk CSS variable.
// ──────────────────────────────────────────────────────────────────────
export function buildSparkline(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return "";
  const closes = candles
    .map((c) => (c && typeof c.close === "number" ? c.close : null))
    .filter((v) => v != null);
  if (closes.length < 2) return "";
  const w = 200;
  const h = 32;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const points = closes
    .map((v, i) => {
      const x = (i / (closes.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" width="100%" height="32" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="var(--risk)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ──────────────────────────────────────────────────────────────────────
// SNIPER MAP tab — replaces Score Breakdown.
//
// Visual: Retention Bar — a horizontal segmented bar showing how the
// supply is split between concentrated top-10 holders and the rest of
// the float. Picked from designs-library (SM-3).
//
// Data — every number is a real measurement, no heuristics or brackets:
//   d.top10HolderPct      → the "concentrated" segment width (literal %)
//   100 - top10HolderPct  → the "distributed" segment width (literal %)
//   d.topHolderPct        → single-largest-wallet % (axis caption)
//   d.flags               → count of sniper/bundle flag matches (axis)
//
// Interpretation: when sniper/bundle activity is detected at launch +
// the top-10 still hold a large share, the launch buyers haven't
// distributed yet. When the top-10 share has dropped, the bots got
// out — distribution underway / completed. The verdict line at the
// bottom interprets the same two numbers in plain language so a
// non-technical user gets the action-relevant takeaway.
// ──────────────────────────────────────────────────────────────────────
export function buildSniperMapTab(d) {
  const flags = Array.isArray(d.flags) ? d.flags : [];
  const sniperFlags = flags.filter((f) => /sniper|bundle/i.test(f.label || ""));
  const hasActivity = sniperFlags.length > 0;
  // Field-first, flag-fallback. The structured fields are populated by
  // Helius; on tokens where Helius didn't return the backend still emits
  // flags like "Top 10 hold X%" which we parse here as a fallback.
  let top10 = typeof d.top10HolderPct === "number" ? d.top10HolderPct : null;
  let top1 = typeof d.topHolderPct === "number" ? d.topHolderPct : null;
  if (top10 == null) top10 = parsePctFromFlags(flags, /top\s*10(?:\s+holders?)?\s+(?:hold|[>≥])\s*(\d+(?:\.\d+)?)\s*%/i);
  if (top1 == null) top1 = parsePctFromFlags(flags, /(?:Owner|Creator)\s*holds\s*[>≥]\s*(\d+(?:\.\d+)?)\s*%/i);
  const heliusUnavailable = flags.some((f) => /helius\s+unavailable/i.test(f.label || ""));

  // ── Is this an established token? ──────────────────────────────────────
  // Same definition as layerHelius: ≥ 30 days old AND ≥ 5k holders.
  // Used to show context-aware labels in the Sniper Map ("exchange wallets"
  // vs "cluster risk") so a user seeing 36% top-10 on FARTCOIN understands
  // why the verdict is SAFE while a 36% top-10 on a 3-hour token is CAUTION.
  const ageDays = typeof d.solscanTokenAgeHours === "number" ? d.solscanTokenAgeHours / 24 : null;
  // 7.7.6 fix: mirror layerHelius — age ≥ 30d always, then EITHER
  // verified holders ≥ 5k OR age ≥ 180d (6 months). The 180d threshold
  // protects true blue-chips from data-gap misclassification while keeping
  // shorter-lived tokens in the strict fresh tier.
  const isEstablished = (ageDays ?? 0) >= 30 &&
    ((d.holders ?? 0) >= 5_000 || (ageDays ?? 0) >= 180);

  // ── Concentration bands — 2 tiers (mirrors layerHelius 7.7.5) ──────────
  // Severity: 0 good, 1 info, 2 warn, 3 bad. Numeric so we can take max.
  function top10BandFresh(t10) {
    if (t10 == null) return null;
    if (t10 >= 75) return { rank: 3, label: "EXTREME CONCENTRATION", cls: "bad" };
    if (t10 >= 55) return { rank: 3, label: "HIGH CONCENTRATION · CONTROL RISK", cls: "bad" };
    if (t10 >= 35) return { rank: 2, label: "ELEVATED CONCENTRATION · CLUSTER RISK", cls: "warn" };
    if (t10 >= 20) return { rank: 1, label: "MODERATE CONCENTRATION", cls: "info" };
    return { rank: 0, label: "WELL DISTRIBUTED", cls: "good" };
  }
  function top10BandEstablished(t10) {
    if (t10 == null) return null;
    if (t10 >= 80) return { rank: 3, label: "EXTREME CONCENTRATION", cls: "bad" };
    if (t10 >= 65) return { rank: 3, label: "HIGH CONCENTRATION", cls: "bad" };
    if (t10 >= 45) return { rank: 2, label: "ELEVATED · EXCHANGES MAY BE INCLUDED", cls: "warn" };
    if (t10 >= 25) return { rank: 1, label: "NORMAL DISTRIBUTION · EXCHANGES INCLUDED", cls: "info" };
    return { rank: 0, label: "WELL DISTRIBUTED", cls: "good" };
  }
  const top10BandFn = isEstablished ? top10BandEstablished : top10BandFresh;
  function top1Band(t1) {
    if (t1 == null) return null;
    if (t1 >= 25) return { rank: 3, label: "WHALE CRITICAL", cls: "bad" };
    if (t1 >= 15) return { rank: 2, label: "WHALE RISK", cls: "warn" };
    if (t1 >= 8) return { rank: 1, label: "LARGE WALLET", cls: "info" };
    return null; // < 8% top1 is not worth flagging on its own
  }

  // No concentration data and no sniper activity — render minimal
  // bar saying so honestly. Never claim "organic" without measurement.
  if (top10 == null && !hasActivity) {
    const reason = heliusUnavailable ? "Helius unavailable on this scan" : "top-holder data missing";
    return `
      <div class="sm-bar-wrap">
        <div class="sm-title">CONCENTRATION UNAVAILABLE</div>
        <div class="sm-bar">
          <div class="sm-seg pending" style="flex:100"><span class="pct">unknown</span><span>concentration unavailable</span></div>
        </div>
        <div class="sm-axis"><span>—</span><span>${escapeHtml(reason.toUpperCase())}</span><span>0 flags</span></div>
      </div>
      <div class="tab-alert warn">No sniper or bundle activity detected, but distribution data is unavailable on this scan — concentration cannot be assessed. Re-scan for full data.</div>
    `;
  }

  if (top10 == null && hasActivity) {
    const reason = heliusUnavailable ? "Helius unavailable on this scan" : "top-holder data missing";
    return `
      <div class="sm-bar-wrap">
        <div class="sm-title">${sniperFlags.length} COORDINATED LAUNCH PATTERN${sniperFlags.length > 1 ? "S" : ""} DETECTED</div>
        <div class="sm-bar">
          <div class="sm-seg pending" style="flex:100"><span class="pct">unknown</span><span>concentration unavailable</span></div>
        </div>
        <div class="sm-axis"><span>—</span><span>${escapeHtml(reason.toUpperCase())}</span><span>${sniperFlags.length} flag${sniperFlags.length > 1 ? "s" : ""}</span></div>
      </div>
      <div class="tab-alert bad">Sniper / bundle activity detected at launch — but ${escapeHtml(reason)}, so the distribution status cannot be measured for this scan.</div>
    `;
  }

  // We have measurable concentration. Compute both bands, take worse.
  const concentrated = Math.round(Math.max(0, Math.min(100, top10)));
  const distributed = 100 - concentrated;
  const top1Disp = top1 != null ? top1.toFixed(1) + "%" : "—";
  const t10b = top10BandFn(top10);
  const t1b = top1Band(top1);
  // Top-heavy: top1 captures more than 40% of the top10 cluster. Means
  // one wallet dominates and can dump unilaterally — orthogonal risk on
  // top of raw concentration.
  const topHeavyRatio = top1 != null && top10 != null && top10 > 0 ? top1 / top10 : 0;
  const isTopHeavy = topHeavyRatio >= 0.4;

  // Pick the worse-ranked band as the primary verdict.
  let primary = t10b;
  if (t1b && (!primary || t1b.rank > primary.rank)) primary = t1b;

  // Build verdict title and alert text from the primary band.
  const titleParts = [];
  const alertParts = [];
  if (primary === t10b) {
    titleParts.push(`${primary.label} · TOP 10 HOLD ${concentrated}%`);
    alertParts.push(`Top 10 wallets hold ${concentrated}% of supply.`);
  } else {
    // t1 is driving the verdict
    titleParts.push(`${primary.label} · ONE WALLET HOLDS ${top1.toFixed(1)}%`);
    alertParts.push(`Largest wallet holds ${top1.toFixed(1)}% of supply.`);
  }
  if (isTopHeavy && primary !== t1b) {
    // Add top-heavy modifier when t10 was primary AND top1 is heavy
    titleParts[0] += " · TOP-HEAVY";
    alertParts.push(
      `One wallet (${top1.toFixed(1)}%) accounts for ${Math.round(topHeavyRatio * 100)}% of the top-10 cluster — single-entity dump risk.`,
    );
  } else if (!isTopHeavy && primary === t10b && top1 != null && t10b.rank >= 2) {
    // Spread within top 10 — softer interpretation
    alertParts.push(`Largest wallet only ${top1.toFixed(1)}% — concentration is spread across the top 10 cluster.`);
  }
  // Severity-specific phrasing — with exchange context for established tokens
  switch (primary.cls) {
    case "bad":
      alertParts.push("Coordinated exit can crash the price at any moment.");
      break;
    case "warn":
      if (isEstablished && /exchanges/i.test(primary.label)) {
        alertParts.push("Even with exchange wallets present, this concentration level is elevated — watch for coordinated sells.");
      } else {
        alertParts.push("Watch whale moves and large transfers carefully.");
      }
      break;
    case "info":
      if (isEstablished && /exchanges/i.test(primary.label)) {
        // Key UX note: explain why 36% on an established token ≠ 36% on a fresh one
        alertParts.push(`For an established token (${ageDays != null ? Math.round(ageDays) + "d old, " : ""}${d.holders != null ? d.holders.toLocaleString() + " holders" : "large holder base"}), this distribution is within normal range. Top wallets at this maturity level are typically exchanges, custodians, and long-term diamond-hand holders — not coordinated dump groups.`);
      } else {
        alertParts.push("Within normal range — monitor as positions evolve.");
      }
      break;
    case "good":
      // Reserved for the strict "clean" path below
      break;
  }

  // Combine with sniper activity
  let alertCls = primary.cls;
  let title = titleParts.join("");
  let alertText = alertParts.join(" ");
  let axisStatus = primary.label;

  if (hasActivity) {
    // Sniper/bundle flags floor severity at warn; bad stays bad.
    if (alertCls === "good" || alertCls === "info") alertCls = "warn";
    title = `${sniperFlags.length} SNIPER/BUNDLE PATTERN${sniperFlags.length > 1 ? "S" : ""} · ${title}`;
    alertText = `${sniperFlags.length} sniper/bundle flag${sniperFlags.length > 1 ? "s" : ""} detected at launch. ${alertText}`;
  } else {
    // No sniper / bundle flags fired. Surface this EXPLICITLY in every
    // path below so the tab — labelled "SNIPER MAP" — actually mentions
    // snipers. Previously the user saw only "ELEVATED CONCENTRATION ·
    // TOP 10 HOLD 23%" with zero mention of snipers, which read as if
    // the detector hadn't run. Lead the alert with the green checkmark
    // so the absence is a positive signal, not a missing one.
    alertText = `✓ 0 sniper / bundle flags detected at launch. ${alertText}`;

    // CLEAN/ORGANIC verdict requires ALL THREE: top10 < 15%, top1 < 5%,
    // 0 sniper flags. This is intentionally rare — a real clean launch
    // is rare. Most memecoins won't qualify, and that's correct.
    const isTrulyClean = top10 < 15 && (top1 == null || top1 < 5) && primary.cls === "good";
    if (isTrulyClean) {
      title = `CLEAN LAUNCH · TOP 10 HOLD ${concentrated}%`;
      alertCls = "good";
      alertText = `✓ 0 sniper / bundle flags detected at launch. Top 10 wallets hold only ${concentrated}% of supply${top1 != null ? ` (largest ${top1.toFixed(1)}%)` : ""}. Distribution looks genuinely organic.`;
      axisStatus = "CLEAN LAUNCH";
    }
  }

  // ── Bar colour follows the severity, NOT a fixed "holding = green".
  // Earlier version always painted the concentration segment green even
  // when the verdict was EXTREME CONCENTRATION, which made the visual
  // contradict the title. Map alertCls → CSS class so the colour and
  // the text always agree.
  //   bad  → red (.exited)  · concentration is dangerous
  //   warn → yellow (.partial) · elevated, watch
  //   info → yellow (.partial) · normal-distribution band, neutralish
  //   good → green (.holding) · well-distributed
  const concentratedCls =
    alertCls === "bad" ? "exited" : alertCls === "good" ? "holding" : "partial";

  // Hide the right "Distributed" segment entirely when there's
  // effectively no float left — flex:0 on a child still renders its
  // textContent and overflows visually. Threshold of 5% keeps the
  // label readable when there's enough space to fit it.
  const showDistributed = distributed >= 5;
  const distributedSegHtml = showDistributed
    ? `<div class="sm-seg distributed" style="flex:${distributed}"><span class="pct">${distributed}%</span><span>Distributed</span></div>`
    : "";

  return `
    <div class="sm-bar-wrap">
      <div class="sm-title">${escapeHtml(title)}</div>
      <div class="sm-bar">
        <div class="sm-seg ${concentratedCls}" style="flex:${concentrated}"><span class="pct">${concentrated}%</span><span>Top 10</span></div>
        ${distributedSegHtml}
      </div>
      <div class="sm-axis"><span>Largest: ${escapeHtml(top1Disp)}</span><span>${escapeHtml(axisStatus)}</span><span>${sniperFlags.length} flag${sniperFlags.length === 1 ? "" : "s"}</span></div>
    </div>
    <div class="tab-alert ${alertCls}">${escapeHtml(alertText)}</div>
  `;
}

export function buildExitLiquidityTab(liq) {
  const tiers = computeExitLiquidity(liq);
  if (!tiers) {
    return `<div class="tab-empty">Exit liquidity unavailable — <b>liquidity figure not provided</b> by upstream sources.</div>`;
  }
  const rows = tiers
    .map(
      (t) => `
    <div class="exit-row">
      <div class="exit-amount">${escapeHtml(fmt(t.amount))}</div>
      <div class="exit-slip ${t.cls}">${escapeHtml(t.slipDisplay)}</div>
      <div class="exit-wave"><div class="exit-wave-fill ${t.cls}" style="width:${t.widthPct}%"></div></div>
      <div class="exit-note">${escapeHtmlAllowBold(t.note)}</div>
    </div>
  `,
    )
    .join("");
  return `
    <div class="exit-row exit-head">
      <div class="exit-amount">Sell amount</div>
      <div class="exit-slip">Slippage</div>
      <div>Visual</div>
      <div class="exit-note">Outcome</div>
    </div>
    ${rows}
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-size:18px;color:#888">Total LP available: <b style="color:#eee;letter-spacing:.08em">${escapeHtml(fmt(liq))}</b></div>
  `;
}

// ──────────────────────────────────────────────────────────────────────
// CRITICAL ACTORS preview — up to 3 cards (Dev / Insider / Cluster)
// Rendered ONLY from the backend's `criticalActors` (composeCriticalActors:
// creatorReputation + filtered top holders + insider-graph clusters).
// When that array is missing or empty we say so — we never invent
// wallets. The old "v5 mock" fallback printed fabricated addresses,
// "4 / 5 prior rugs", "HenryRug" / "BunnyRug" references and made-up
// cluster percentages on REAL token pages whenever Helius data was
// missing (seen live on HAWK next to a SAFE verdict, 2026-10-05).
// ──────────────────────────────────────────────────────────────────────
export function buildCriticalActorsPreview(d) {
  if (Array.isArray(d.criticalActors) && d.criticalActors.length > 0) {
    return d.criticalActors
      .map((a) => {
        const cls = a.type === "dev" ? "dev" : a.type === "cluster" ? "coord" : "bot";
        const pctDisp = typeof a.pct === "number" && a.pct > 0 ? a.pct.toFixed(1) + "%" : "—";
        return `
        <div class="wp-card ${cls}">
          <div class="wp-head"><span class="wp-tag">${escapeHtml(a.tag || "")}</span><span class="wp-pct">${escapeHtml(pctDisp)}</span></div>
          <div class="wp-addr">${escapeHtml(a.addr || "")}</div>
          <div class="wp-rep">
            <div class="wp-rep-lbl">${escapeHtml(a.repLbl || "")}</div>
            <div class="wp-rep-bar"><div class="wp-rep-fill ${a.repWarn ? "warn" : ""}" style="width:${Math.max(0, Math.min(100, a.repWidth || 0))}%"></div></div>
          </div>
          <div class="wp-desc">${escapeHtmlAllowBold(a.desc)}</div>
        </div>
      `;
      })
      .join("");
  }
  // No backend actors. composeCriticalActors builds its cards from the
  // Helius top-holder list, so an empty array almost always means that
  // wallet-level data didn't come back for this scan.
  const heliusDown = d.layers?.helius?.available === false;
  const msg = heliusDown
    ? "Wallet-level data (top holders, creator history, insider clusters) was unavailable for this scan. <b>No wallets were checked</b> — re-scan in a moment."
    : "No critical actors identified among this token's top holders.";
  return `<div class="tab-empty" style="grid-column:1/-1">${escapeHtmlAllowBold(msg)}</div>`;
}

// ──────────────────────────────────────────────────────────────────────
// INSIDER WATCH tab — placeholder skeleton.
//
// The actual feed is fetched async from /api/graph?activity=1 by
// loadInsiderActivity() (in ui-setup.js) after the page renders, and
// slotted into #ant-insider-feed below. Server-side cache (60s) means
// most loads are sub-200ms.
// ──────────────────────────────────────────────────────────────────────
export function buildInsiderWatchTab(d) {
  const ca = d.resolvedMint || "";
  // Price hint lets the backend skip a DexScreener round-trip. Multiple
  // paths because the backend evolved its naming over time — any one
  // being a number is enough.
  const priceHint =
    d.priceUsd != null
      ? d.priceUsd
      : d.pair && d.pair.priceUsd != null
        ? d.pair.priceUsd
        : null;
  return `
    <div class="iw-feed-wrap" data-ca="${escapeHtml(ca)}" data-price="${escapeHtml(String(priceHint || ""))}">
      <div class="iw-feed-head">
        <span class="iw-feed-title">TOP 10 RECENT ACTIVITY · LAST 6h</span>
        <span class="iw-feed-meta" id="ant-insider-meta">loading…</span>
      </div>
      <!-- Column header — sits OUTSIDE #ant-insider-feed so it survives
           the dynamic innerHTML rewrites done by loadInsiderActivity().
           Mirrors the iw-row grid (36px 1fr 90px 1fr 1fr 60px) so the
           labels line up exactly above each column. Earlier the rows
           rendered without headers and users couldn't tell whether
           "60.0K" was tokens, USD or something else. -->
      <div class="iw-row iw-row-header" aria-hidden="true">
        <span class="iw-row-rank" title="Rank in top 10 holders">#</span>
        <span class="iw-row-wallet">Wallet</span>
        <span class="iw-row-action">Action</span>
        <span class="iw-row-amount">Tokens</span>
        <span class="iw-row-usd">USD value</span>
        <span class="iw-row-age">Age</span>
      </div>
      <div class="iw-feed" id="ant-insider-feed">
        <div class="iw-feed-loading">
          <div class="iw-skel-row"></div>
          <div class="iw-skel-row"></div>
          <div class="iw-skel-row"></div>
          <div class="iw-skel-row"></div>
        </div>
      </div>
      <div class="iw-feed-foot" id="ant-insider-foot"></div>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────────────
// BUY/SELL FLOW tab — replaces Holder Activity.
//
// Visual: Pressure Gauge Hero — a status banner ("ACCUMULATION /
// DISTRIBUTION / BALANCED") above a horizontal pressure gauge showing
// the lean (sellers ← balanced → buyers), with three mini cards below
// for the per-window net flow. Picked from designs-library (BSF-4).
//
// Data: DexScreener pair.txns + pair.volume contain per-window buy/sell
// transaction counts and volume USD. Public API returns m5 / h1 / h6 /
// h24 windows even though our TS type only declares m5 — the runtime
// object has them all. We use h6 as the hero window when available
// (5m and 1h are also rendered as mini cards). Buy / sell USD per
// window is estimated as `volume × buys/(buys+sells)` and
// `volume × sells/(buys+sells)` — count-weighted rather than dollar-
// weighted, but it's the cleanest split we get without per-trade data.
// ──────────────────────────────────────────────────────────────────────
export function buildBuySellFlowTab(d) {
  const pair = d.pair;
  if (!pair || !pair.txns) {
    return `<div class="tab-empty">Buy/Sell Flow is not available — DexScreener did not return transaction data for this pair.</div>`;
  }
  const txns = pair.txns || {};
  const vol = pair.volume || {};

  // Read a single window from the pair object. Returns null when there
  // are no transactions in that window (e.g. 5m on a quiet token, or
  // h6 on a brand-new pair).
  function windowData(key, lbl) {
    const t = txns[key];
    if (!t) return null;
    const buys = typeof t.buys === "number" ? t.buys : 0;
    const sells = typeof t.sells === "number" ? t.sells : 0;
    const total = buys + sells;
    if (total === 0) return null;
    const v = typeof vol[key] === "number" ? vol[key] : 0;
    const buyV = v > 0 ? v * (buys / total) : 0;
    const sellV = v > 0 ? v * (sells / total) : 0;
    return { lbl, buys, sells, buyV, sellV, net: buyV - sellV, total, hasVolume: v > 0 };
  }

  const w5m = windowData("m5", "5 min");
  const w1h = windowData("h1", "1 hour");
  const w6h = windowData("h6", "6 hours");
  const w24h = windowData("h24", "24 hours");

  // Hero uses the longest available window so the headline reflects the
  // sustained trend rather than minute-by-minute noise.
  const heroW = w6h || w24h || w1h || w5m;
  if (!heroW) {
    return `<div class="tab-empty">Buy/Sell Flow is not available — no transactions in any window for this pair.</div>`;
  }

  const buyPct = (heroW.buys / heroW.total) * 100;
  let status;
  let statusCls;
  let gaugeCls;
  let alertCls;
  let alertText;
  if (buyPct > 55) {
    status = "ACCUMULATION";
    statusCls = "good";
    gaugeCls = "good";
    alertCls = "good";
    alertText = `Buyers dominate — ${heroW.buys} buys vs ${heroW.sells} sells in the last ${heroW.lbl}.`;
  } else if (buyPct < 45) {
    status = "DISTRIBUTION";
    statusCls = "bad";
    gaugeCls = "bad";
    alertCls = "bad";
    alertText = `Sellers dominate — ${heroW.sells} sells vs ${heroW.buys} buys in the last ${heroW.lbl}.`;
  } else {
    status = "BALANCED";
    statusCls = "warn";
    gaugeCls = "warn";
    alertCls = "warn";
    alertText = `Buy and sell pressure are roughly even (${heroW.buys}/${heroW.sells}) over the last ${heroW.lbl}.`;
  }

  // Gauge fill: lean = buyPct (50 = balanced). Render the fill from the
  // imbalanced side toward the centre so the bar visually leans.
  const fillLeft = buyPct < 50 ? buyPct : 50;
  const fillRight = buyPct > 50 ? 100 - buyPct : 50;

  // Net flow display for the hero. When volume isn't available for the
  // hero window we fall back to a count-only summary so we never invent
  // a dollar amount.
  let heroNetHtml;
  if (heroW.hasVolume) {
    const heroNet = (heroW.net >= 0 ? "+" : "−") + fmt(Math.abs(heroW.net));
    const heroNetCls = heroW.net >= 0 ? "good" : "bad";
    heroNetHtml = `Net flow (${heroW.lbl}): <b class="${heroNetCls}">${escapeHtml(heroNet)}</b>`;
  } else {
    const sign = heroW.buys > heroW.sells ? "+" : heroW.buys < heroW.sells ? "−" : "";
    const diff = Math.abs(heroW.buys - heroW.sells);
    heroNetHtml = `Net trades (${heroW.lbl}): <b>${sign}${diff}</b>`;
  }

  function miniCard(w, lbl) {
    if (!w) {
      return `<div class="bsf-mini-card"><div class="bsf-mini-w">${escapeHtml(lbl)}</div><div class="bsf-mini-net dim">—</div></div>`;
    }
    if (w.hasVolume) {
      const cls = w.net >= 0 ? "good" : "bad";
      const sign = w.net >= 0 ? "+" : "−";
      return `<div class="bsf-mini-card">
        <div class="bsf-mini-w">${escapeHtml(w.lbl)}</div>
        <div class="bsf-mini-net ${cls}">${sign}${escapeHtml(fmt(Math.abs(w.net)))}</div>
        <div class="bsf-mini-sub">${w.buys} ↗ / ${w.sells} ↘</div>
      </div>`;
    }
    // Volume missing → show counts only
    const cls = w.buys > w.sells ? "good" : w.buys < w.sells ? "bad" : "mid";
    return `<div class="bsf-mini-card">
      <div class="bsf-mini-w">${escapeHtml(w.lbl)}</div>
      <div class="bsf-mini-net ${cls}">${w.buys} / ${w.sells}</div>
      <div class="bsf-mini-sub">buys / sells</div>
    </div>`;
  }

  return `
    <div class="bsf-hero">
      <div class="bsf-status ${statusCls}">${status}</div>
      <div class="bsf-net">${heroNetHtml}</div>
      <div class="bsf-gauge"><div class="bsf-gauge-fill ${gaugeCls}" style="left:${fillLeft.toFixed(1)}%;right:${fillRight.toFixed(1)}%"></div></div>
      <div class="bsf-gauge-axis"><span>Sellers</span><span>Balanced</span><span>Buyers</span></div>
    </div>
    <div class="bsf-mini">
      ${miniCard(w5m, "5 min")}
      ${miniCard(w1h, "1 hour")}
      ${miniCard(w6h || w24h, w6h ? "6 hours" : "24 hours")}
    </div>
    <div class="tab-alert ${alertCls}">${escapeHtml(alertText)}</div>
  `;
}

// ──────────────────────────────────────────────────────────────────────
// WASH VOLUME tab — replaces Outcome Histogram.
//
// Visual: Circular Score Donut — a 0-100 wash score in a donut on the
// left, four key metrics stacked on the right. Picked from designs-
// library (WV-2). Donut stroke colour shifts good → warn → bad as the
// score rises so the visual matches the verdict at a glance.
//
// Data — wired exclusively to DexScreener pair data which is reliably
// populated for every token. Every number on screen is a real
// measurement. See in-file comments for the wash-signal formulas.
// ──────────────────────────────────────────────────────────────────────
export function buildWashVolumeTab(d) {
  const pair = d.pair;
  if (!pair || !pair.txns || !pair.volume) {
    return `<div class="tab-empty">Wash Volume is not available — DexScreener did not return transaction data for this pair.</div>`;
  }
  const txns24 = pair.txns.h24 || {};
  const buys = typeof txns24.buys === "number" ? txns24.buys : 0;
  const sells = typeof txns24.sells === "number" ? txns24.sells : 0;
  const totalTrades = buys + sells;
  const reportedVol =
    (typeof pair.volume.h24 === "number" ? pair.volume.h24 : null) ?? d.volume24h ?? null;
  const liq =
    (typeof d.liquidity === "number" ? d.liquidity : null) ??
    (typeof pair.liquidity?.usd === "number" ? pair.liquidity.usd : null) ??
    null;

  if (totalTrades === 0 || !reportedVol || reportedVol <= 0) {
    return `<div class="tab-empty">Wash Volume is not available — no trade activity reported in the last 24 hours.</div>`;
  }

  const avgTrade = reportedVol / totalTrades;

  // Tiny-trade signal: avg trade size relative to liquidity. Threshold
  // 0.05% of LP — below that the trades look more like wash cycling
  // than retail flow. Score climbs as the avg drops below the threshold.
  let tinyTradeScore = 0;
  if (liq && liq > 0) {
    const ratio = avgTrade / Math.max(1, liq * 0.0005); // 1.0 = at threshold
    tinyTradeScore = Math.max(0, Math.min(100, (1 - ratio) * 100));
  }

  // Symmetry signal: very balanced buy/sell ratios over many trades is
  // an artificial pattern. Real organic trading drifts naturally one
  // way or the other. We only flag it when there are enough trades to
  // make symmetry statistically improbable.
  const imbalance = Math.abs(buys - sells) / totalTrades; // 0 = perfect 50/50, 1 = one-sided
  let symmetryScore = 0;
  if (totalTrades > 100) {
    if (imbalance < 0.03) symmetryScore = 80;
    else if (imbalance < 0.07) symmetryScore = 50;
    else if (imbalance < 0.12) symmetryScore = 25;
  }

  // Volume / liquidity ratio signal — aligned with the backend flag
  // "Liquidity mirage: volume >> liquidity (wash)" in api/_lib/layers.ts
  // which trips when v24h / LP > 12. Without this branch in the donut,
  // a token like TOLYBOT (vol $2.13M on $120K LP → ratio ≈ 17.6) would
  // trip the backend wash flag (visible in the Critical Flags list and
  // surfaced by the AI summary as "wash trading detected") while the
  // donut said "the volume looks real" — user-visible incoherence.
  //
  // Threshold ladder mirrors the backend trigger (>= 12) so a flagged
  // token never gets a "healthy" donut, and pushes higher beyond it
  // because more extreme ratios are increasingly damning.
  let volRatioScore = 0;
  if (liq && liq > 0) {
    const v24Ratio = reportedVol / liq;
    if (v24Ratio >= 20) volRatioScore = 95;
    else if (v24Ratio >= 12) volRatioScore = 75; // backend Liquidity mirage trigger
    else if (v24Ratio >= 8)  volRatioScore = 50;
    else if (v24Ratio >= 4)  volRatioScore = 25;
  }

  // Final wash score: max of the trade-stream signals (tiny + symmetry)
  // and the structural vol/liq ratio. Vol/liq is a hard diagnostic
  // floor — when it fires, the donut MUST reflect it regardless of how
  // clean the trade size / symmetry look on their own (those can be
  // gamed; a backed-into ratio cannot). Tiny + symmetry stay as
  // corroborating signals that dominate when vol/liq is healthy.
  const baseScore = Math.round(0.55 * tinyTradeScore + 0.45 * symmetryScore);
  const washScore = Math.max(volRatioScore, baseScore);
  const symPct = Math.round((1 - imbalance) * 100);

  // Pick alert text that matches whichever signal drove the score.
  // Saying "small trades cycling" when the score came from vol/liq ratio
  // (and avg trade was actually normal) would have been the same kind of
  // incoherence we just fixed on the AI side — the message must align
  // with the measurement.
  const ratioDriven = volRatioScore > baseScore && volRatioScore >= 50;
  const v24Ratio = liq && liq > 0 ? reportedVol / liq : 0;

  let cls;
  let washColor;
  let alertCls;
  let alertText;
  if (washScore < 30) {
    cls = "good";
    washColor = "var(--c)";
    alertCls = "good";
    alertText = `The volume looks real — ${totalTrades.toLocaleString()} trades with healthy average size and natural buy/sell drift.`;
  } else if (washScore < 65) {
    cls = "warn";
    washColor = "var(--yellow)";
    alertCls = "warn";
    if (ratioDriven) {
      alertText = `Volume looks inflated — reported ${fmt(reportedVol)} 24h on ${liq ? fmt(liq) + " LP" : "thin LP"} (×${v24Ratio.toFixed(1)} ratio, well above the ×4 healthy band).`;
    } else {
      alertText = `The volume is suspicious — ${totalTrades.toLocaleString()} trades with avg size of ${fmt(avgTrade)} relative to ${liq ? fmt(liq) + " LP" : "shallow LP"}. Possible wash cycling.`;
    }
  } else {
    cls = "bad";
    washColor = "var(--orange)";
    alertCls = "bad";
    if (ratioDriven) {
      alertText = `Wash volume detected — reported ${fmt(reportedVol)} 24h on ${liq ? fmt(liq) + " LP" : "very thin LP"} (×${v24Ratio.toFixed(1)} ratio). The headline volume is almost certainly inflated; do not trust it as a liquidity signal.`;
    } else {
      alertText = `The volume is almost certainly fake — small trades cycling against a thin LP. Do not trust the headline volume.`;
    }
  }

  // Donut math: r=42 → circumference = 2πr ≈ 263.9. pathLength normalises
  // so dasharray "X 263.9" fills X% of the circle.
  const C = 263.9;
  const dashOn = (washScore / 100) * C;
  return `
    <div class="wv-wrap">
      <div class="wv-donut">
        <svg viewBox="0 0 100 100">
          <circle class="wv-track" cx="50" cy="50" r="42"></circle>
          <circle class="wv-fill" cx="50" cy="50" r="42" stroke="${washColor}" stroke-dasharray="${dashOn.toFixed(1)} ${C}" pathLength="${C}"></circle>
        </svg>
        <div class="wv-donut-center">
          <div class="wv-donut-num ${cls}">${washScore}</div>
          <div class="wv-donut-lbl">Wash score</div>
        </div>
      </div>
      <div class="wv-info">
        <div class="wv-info-row"><div class="wv-info-l">Reported volume</div><div class="wv-info-r">${escapeHtml(fmt(reportedVol))}</div></div>
        <div class="wv-info-row"><div class="wv-info-l">Total trades</div><div class="wv-info-r">${totalTrades.toLocaleString()}</div></div>
        <div class="wv-info-row"><div class="wv-info-l">Avg trade size</div><div class="wv-info-r ${cls}">${escapeHtml(fmt(avgTrade))}</div></div>
        <div class="wv-info-row"><div class="wv-info-l">Buy/sell symmetry</div><div class="wv-info-r ${cls}">${symPct}%</div></div>
      </div>
    </div>
    <div class="tab-alert ${alertCls}">${escapeHtml(alertText)}</div>
  `;
}

// ──────────────────────────────────────────────────────────────────────
// Source Breakdown — 1 row per upstream source. Verdict is derived from
// the layer's trust score (>=0.75 OK, >=0.4 risk, otherwise flagged).
// Rendered inside a foldable section at the bottom of the page.
// ──────────────────────────────────────────────────────────────────────
export function buildSourceListRows(d) {
  const layers = d.layers || {};
  const order = ["rugcheck", "goplus", "helius", "solscan", "chart", "dexscreener"];
  const labels = {
    rugcheck: "RugCheck",
    goplus: "GoPlus",
    helius: "Helius",
    solscan: "Solscan",
    chart: "Chart Engine",
    dexscreener: "DexScreener",
  };
  return order
    .map((key) => {
      const l = layers[key];
      if (!l) return null;
      if (!l.available) {
        return `<div class="src-row na">
        <div class="src-name">${escapeHtml(labels[key])}</div>
        <div class="src-verdict">N/A</div>
        <div class="src-note">Source unavailable for this token.</div>
      </div>`;
      }
      const trust = l.trust || 0;
      let cls;
      let verdict;
      let note;
      if (trust >= 0.75) {
        cls = "ok";
        verdict = "OK";
        note = `${labels[key]} reports no critical issues.`;
      } else if (trust >= 0.4) {
        cls = "warn";
        verdict = "Risk";
        note = `${labels[key]} flagged moderate concerns.`;
      } else {
        cls = "bad";
        verdict = "Flagged";
        note = `${labels[key]} flagged significant concerns.`;
      }
      return `<div class="src-row ${cls}">
      <div class="src-name">${escapeHtml(labels[key])}</div>
      <div class="src-verdict">${escapeHtml(verdict)}</div>
      <div class="src-note">${escapeHtml(note)}</div>
    </div>`;
    })
    .filter(Boolean)
    .join("");
}
