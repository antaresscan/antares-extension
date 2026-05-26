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
  setupFab,
  setupTabs,
  setupRefreshButton,
  setupFreshnessTicker,
  setupRevealObserver,
  loadInsiderActivity,
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

  function safeUrl(u) {
    return typeof u === "string" && /^https?:\/\//i.test(u) ? u : "#";
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
      <div class="m-label">Market Cap</div>
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
              <button class="refresh-btn" id="refresh-btn" aria-label="Refresh scan" title="Force a fresh scan, bypassing the cache">↻</button>
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
  setupFab();
  setupRefreshButton(ca, { onRefresh: (data) => render(data, ca) });
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
  // are sub-200ms.
  setTimeout(() => {
    loadInsiderActivity();
  }, 50);

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
