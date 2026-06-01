// js/ui-setup.js — One-time DOM/event wiring for the /token page.
//
// Each `setupXxx` is idempotent — it short-circuits via a `window.__xxxInit`
// flag so re-renders (e.g. the manual refresh button) don't double-bind
// listeners. The flag pattern is intentional: the page calls these on
// every render() pass, but they should only run on the first one.
//
// `loadInsiderActivity` lives here too because it's effectively an
// async event handler — fired after the page renders, fetches the
// /api/graph activity feed, and injects HTML into the placeholder
// skeleton built by views.buildInsiderWatchTab().

import { API, API_BASE } from "./api-client.js";
import {
  escapeHtml,
  fmtUsd,
  fmtTok,
  formatAgeMin,
} from "./formatters.js";

// ──────────────────────────────────────────────────────────────────────
// Cursor-tracking glow (hero background visual). Pure CSS update —
// listens once at document level so it survives re-renders.
// ──────────────────────────────────────────────────────────────────────
export function setupCursorGlow() {
  if (window.__cgInit) return;
  window.__cgInit = true;
  const cg = document.getElementById("cursor-glow");
  if (!cg) return;
  document.addEventListener("mousemove", (e) => {
    cg.style.opacity = "1";
    cg.style.left = e.clientX + "px";
    cg.style.top = e.clientY + "px";
  });
  document.addEventListener("mouseleave", () => {
    cg.style.opacity = "0";
  });
}

// ──────────────────────────────────────────────────────────────────────
// Sticky nav — collapses to a compact strip after the hero scrolls past.
// ──────────────────────────────────────────────────────────────────────
export function setupStickyNav() {
  if (window.__navInit) return;
  window.__navInit = true;
  const nav = document.getElementById("nav");
  if (!nav) return;
  const onScroll = () => nav.classList.toggle("compact", window.scrollY > 360);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// ──────────────────────────────────────────────────────────────────────
// Wire up collapsibles. Two flavours share the same handler:
//   - section-label[data-toggle=ID] : also gets `.closed` for chevron rotation
//   - any other [data-toggle=ID]    : just toggles `.collapsed` on target
// Click is event-delegated once at document level so re-renders don't
// double-bind.
// ──────────────────────────────────────────────────────────────────────
export function setupCollapsibles() {
  if (window.__collapseInit) return;
  window.__collapseInit = true;
  document.addEventListener("click", (e) => {
    const head = e.target.closest("[data-toggle]");
    if (!head) return;
    const id = head.dataset.toggle;
    const card = id ? document.getElementById(id) : head.parentElement;
    if (card) card.classList.toggle("collapsed");
    if (head.classList.contains("section-label")) head.classList.toggle("closed");
  });
}

// ──────────────────────────────────────────────────────────────────────
// Tab switcher — scoped to each .deep widget so multiple tab groups on
// the same page (future-proof) stay independent.
// ──────────────────────────────────────────────────────────────────────
export function setupTabs() {
  if (window.__tabsInit) return;
  window.__tabsInit = true;
  document.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab[data-tab]");
    if (!tab) return;
    const target = tab.dataset.tab;
    const deep = tab.closest(".deep");
    if (!deep) return;
    deep.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    deep.querySelectorAll(".tab-pane").forEach((p) =>
      p.classList.toggle("active", p.dataset.pane === target),
    );
  });
}

// ──────────────────────────────────────────────────────────────────────
// Refresh button + freshness ticker. Lets the user manually re-scan the
// token without waiting for the Redis cache TTL. The button posts
// `?fresh=1` which bypasses cache reads server-side. A 15s cooldown
// between clicks keeps the upstream API budget under control while
// still feeling responsive.
//
// `onRefresh(data)` is invoked with the fresh /api/scan payload after a
// successful fetch — the page wires it to its own render() function so
// this module stays decoupled from the orchestrator.
// ──────────────────────────────────────────────────────────────────────
const REFRESH_COOLDOWN_MS = 15000;

export function setupRefreshButton(ca, { onRefresh } = {}) {
  if (window.__refreshInit) return;
  window.__refreshInit = true;
  const btn = document.getElementById("refresh-btn");
  if (!btn) return;
  let lastRefresh = 0;

  btn.addEventListener("click", async () => {
    const since = Date.now() - lastRefresh;
    if (since < REFRESH_COOLDOWN_MS) return;
    lastRefresh = Date.now();
    btn.disabled = true;
    btn.classList.add("spinning");
    try {
      const r = await fetch(`${API}?ca=${encodeURIComponent(ca)}&fresh=1`);
      if (r.ok) {
        const data = await r.json();
        // Notify overlay content scripts on every open DexScreener /
        // pump.fun / Axiom tab so they evict their stale cached verdict
        // and re-render immediately instead of waiting up to 5 min for
        // the CACHE_TTL to expire naturally.
        try {
          chrome.storage.local.set({ antares_rescan_done: { ca, ts: Date.now() } });
        } catch { /* chrome.storage may be unavailable in some environments */ }
        if (onRefresh) onRefresh(data);
      }
    } catch {
      /* silent — keep current data on the page */
    }
    btn.classList.remove("spinning");
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastRefresh);
    setTimeout(() => {
      btn.disabled = false;
    }, Math.max(0, remaining));
  });
}

// ──────────────────────────────────────────────────────────────────────
// "Scanned just now" / "Scanned 5m ago" label that updates every second.
// `setupFreshnessTicker(fetchedAt)` is called on every render() pass;
// the interval itself only spins up once.
// ──────────────────────────────────────────────────────────────────────
let __freshnessInterval = null;

export function setupFreshnessTicker(fetchedAt) {
  window.__lastFetchedAt = fetchedAt || Date.now();
  if (__freshnessInterval) return;
  __freshnessInterval = setInterval(() => updateFreshnessLabel(), 1000);
  updateFreshnessLabel();
}

function updateFreshnessLabel() {
  const el = document.getElementById("m-fresh");
  if (!el || !window.__lastFetchedAt) return;
  const seconds = Math.floor((Date.now() - window.__lastFetchedAt) / 1000);
  let label;
  if (seconds < 5) label = "Scanned just now";
  else if (seconds < 60) label = `Scanned ${seconds}s ago`;
  else if (seconds < 3600) label = `Scanned ${Math.floor(seconds / 60)}m ago`;
  else label = `Scanned ${Math.floor(seconds / 3600)}h ago`;
  el.textContent = label;
}

// ──────────────────────────────────────────────────────────────────────
// IntersectionObserver-driven reveal animation. Adds `.visible` to any
// `.reveal` element when it enters the viewport, and triggers any
// width-from-zero bar animations inside it.
// ──────────────────────────────────────────────────────────────────────
export function setupRevealObserver() {
  if (window.__obsInit) return;
  window.__obsInit = true;
  const obs = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("visible");
        // Score breakdown bars: animate width from 0 to data-w% on first reveal
        e.target.querySelectorAll(".bd-bar[data-w]").forEach((b) => {
          setTimeout(() => {
            b.style.width = b.dataset.w + "%";
          }, 100);
        });
        obs.unobserve(e.target);
      }),
    { threshold: 0.1 },
  );
  document.querySelectorAll(".reveal").forEach((el) => obs.observe(el));
}

// ──────────────────────────────────────────────────────────────────────
// Async loader — fetches /api/graph?activity=1 then renders the feed
// into #ant-insider-feed (and the net-flow footer into #ant-insider-foot).
// Tolerant of 200-with-empty / network errors / Helius outages: every
// failure path resolves to a clear empty/error state, never a broken UI.
// ──────────────────────────────────────────────────────────────────────

// 10 distinct colours — one per top-10 wallet rank.
// Evenly spaced (~36°) around the hue wheel so every colour is clearly
// different from its neighbours. Avoids buy (#00e5b0 teal-green) and
// sell (#ff5f5f red-orange). Applied to the rank pill border+text and
// the wallet address so the same wallet is instantly recognisable across
// multiple rows without reading the truncated address.
const WALLET_COLORS = [
  "#f97316", // #1  orange
  "#eab308", // #2  amber
  "#84cc16", // #3  lime
  "#22c55e", // #4  green
  "#06b6d4", // #5  cyan
  "#3b82f6", // #6  blue
  "#6366f1", // #7  indigo
  "#8b5cf6", // #8  violet
  "#d946ef", // #9  fuchsia
  "#ec4899", // #10 pink
];

export async function loadInsiderActivity() {
  const wrap = document.querySelector(".iw-feed-wrap");
  if (!wrap) return;
  const ca = wrap.dataset.ca;
  if (!ca) return;

  const slot = document.getElementById("ant-insider-feed");
  const meta = document.getElementById("ant-insider-meta");
  const foot = document.getElementById("ant-insider-foot");

  const renderEmpty = (msg, cls) => {
    if (slot) slot.innerHTML = `<div class="iw-feed-empty ${cls || ""}">${escapeHtml(msg)}</div>`;
    if (meta) meta.textContent = "";
    if (foot) foot.innerHTML = "";
  };

  // Render the holder snapshot rows when activity is empty (or as a fallback
  // beneath rows when partially populated). Each row shows: short address,
  // pct supply, and "no recent activity" hint, with a Solscan link.
  // This is the user-visible promise that the feature is alive — quiet
  // treasury wallets still appear, instead of an "empty" state that looks
  // like a broken scan.
  const renderWalletList = (wallets, hint) => {
    if (!Array.isArray(wallets) || !wallets.length) {
      renderEmpty(hint || "No transactions from the top 10 holders in the last 6 hours.", "");
      return;
    }
    const rowsHtml = wallets
      .map((w, i) => {
        const idx = String(i + 1).padStart(2, "0");
        const pct =
          typeof w.pctSupply === "number" && Number.isFinite(w.pctSupply)
            ? w.pctSupply.toFixed(2) + "%"
            : "—";
        const tok = fmtTok(w.holdings);
        const hold = w.holdings != null ? `${tok} tokens` : "";
        const status = w.active ? "ACTIVE" : "IDLE";
        const cls = w.active ? "active" : "idle";
        const wColor = WALLET_COLORS[i % WALLET_COLORS.length];
        const url = `https://solscan.io/account/${encodeURIComponent(w.walletFull || "")}`;
        return `
        <a class="iw-holder-row ${cls}" style="--wc:${wColor}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          <span class="iw-holder-rank">#${idx}</span>
          <span class="iw-holder-wallet" title="${escapeHtml(w.walletFull || "")}">${escapeHtml(w.wallet || "")}</span>
          <span class="iw-holder-pct">${escapeHtml(pct)}</span>
          <span class="iw-holder-amount">${escapeHtml(hold)}</span>
          <span class="iw-holder-state">${escapeHtml(status)}</span>
        </a>
      `;
      })
      .join("");
    if (slot) {
      slot.innerHTML = `
        <div class="iw-fallback-note">${escapeHtml(hint || "No on-chain activity from these wallets in the last 6h.")}</div>
        <div class="iw-holder-list">${rowsHtml}</div>
      `;
    }
  };

  try {
    const priceQ = wrap.dataset.price ? `&price=${encodeURIComponent(wrap.dataset.price)}` : "";
    // /api/graph hosts the activity feed under ?activity=1 — same
    // serverless slot as the insider-graph since they share the
    // top-holders + Helius data and Vercel Hobby caps us at 12
    // functions total.
    const url = `${API_BASE}/graph?ca=${encodeURIComponent(ca)}&activity=1${priceQ}`;
    const res = await fetch(url);
    if (!res.ok) {
      renderEmpty("Live activity unavailable on this scan — re-scan in a moment.", "warn");
      return;
    }
    const payload = await res.json();
    // /api/graph returns the graph fields at top level + an `activity`
    // sub-object. Defensive: extract activity safely so a graph-only
    // response (or a graph endpoint returning a different shape) just
    // renders the empty state instead of throwing.
    const data = payload && payload.activity ? payload.activity : null;
    const activity = Array.isArray(data && data.activity) ? data.activity : [];
    const walletList = Array.isArray(data && data.wallets) ? data.wallets : [];

    if (!activity.length) {
      // Fallback: show the top 10 holder list with their pct supply so
      // the panel looks alive even when none of them traded in 6h. Many
      // tokens have quiet treasuries and long-term holders dominating
      // the top 10 — that's a legitimate "no activity" case, not a bug.
      renderWalletList(
        walletList,
        "No on-chain activity from these wallets in the last 6h — showing current holdings.",
      );
      // Still surface the meta count if present, and clear the flow foot.
      if (meta) {
        const wTotal =
          data && typeof data.totalCheckedWallets === "number"
            ? data.totalCheckedWallets
            : walletList.length;
        meta.textContent = `0/${wTotal} wallets active`;
      }
      if (foot) foot.innerHTML = "";
      return;
    }

    // Build a rank lookup: walletFull → "#N" (1-based index in the top
    // 10 list). Lets each activity row show WHICH of the top 10 holders
    // is doing the buy/sell, not just the truncated address. Falls back
    // to "?" when the wallet isn't in the top 10 snapshot (rare — e.g.
    // out-of-order resolution between activity feed + holders snapshot).
    const rankByWallet = new Map();
    const colorByWallet = new Map();
    walletList.forEach((w, i) => {
      if (w && typeof w.walletFull === "string") {
        rankByWallet.set(w.walletFull, i + 1);
        colorByWallet.set(w.walletFull, WALLET_COLORS[i % WALLET_COLORS.length]);
      }
    });

    const rowsHtml = activity
      .map((e) => {
        const action = String(e.action || "").toUpperCase();
        const isBuy = action === "BOUGHT" || action === "TRANSFER_IN";
        const isSell = action === "SOLD" || action === "TRANSFER_OUT";
        const cls = isBuy ? "buy" : isSell ? "sell" : "";
        // Always render the sign on the USD column so a SOLD row reads
        // "−$71" (clearly money OUT) instead of just "$71" (ambiguous).
        // Earlier code only prefixed `+` on positives — sells came out
        // unsigned and users couldn't tell they were losses without
        // reading the row colour. fmtUsd already emits a literal `-`
        // for the M/K tiers (per its unit tests), so we pass abs value
        // and assemble the prefix ourselves to avoid `−$-71` doubling.
        const usd =
          typeof e.usdValue === "number" && Number.isFinite(e.usdValue)
            ? (e.usdValue > 0 ? "+" : e.usdValue < 0 ? "−" : "") +
              fmtUsd(Math.abs(e.usdValue))
            : "—";
        const tokAmt = fmtTok(e.tokenAmount);
        const ageTxt = formatAgeMin(e.ageMin);
        const sigUrl = `https://solscan.io/tx/${encodeURIComponent(e.signature || "")}`;
        const actionLbl = action.replace("_", " ");
        const rank = rankByWallet.get(e.walletFull) || "?";
        const rankDisp = rank === "?" ? "?" : "#" + rank;
        const wColor = colorByWallet.get(e.walletFull) || "#333";
        return `
        <a class="iw-row ${cls}" style="--wc:${wColor}" href="${escapeHtml(sigUrl)}" target="_blank" rel="noopener noreferrer">
          <span class="iw-row-rank" title="Rank in top 10 holders">${escapeHtml(rankDisp)}</span>
          <span class="iw-row-wallet" data-wallet="${escapeHtml(e.walletFull || "")}" title="${escapeHtml(e.walletFull || "")}">${escapeHtml(e.wallet || "")}</span>
          <span class="iw-row-action">${escapeHtml(actionLbl)}</span>
          <span class="iw-row-amount">${escapeHtml(tokAmt)}</span>
          <span class="iw-row-usd">${escapeHtml(usd)}</span>
          <span class="iw-row-age">${escapeHtml(ageTxt)}</span>
        </a>
      `;
      })
      .join("");

    if (slot) slot.innerHTML = rowsHtml;

    // Wallet sub-link click handler (delegated, avoids inline onclick CSP).
    if (slot) {
      slot.querySelectorAll(".iw-row-wallet").forEach((el) => {
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const w = el.getAttribute("data-wallet");
          if (w) window.open("https://solscan.io/account/" + encodeURIComponent(w), "_blank", "noopener");
        });
      });
    }

    if (meta) {
      const wActive = data.walletsWithActivity || 0;
      const wTotal = data.totalCheckedWallets || 0;
      meta.textContent = `${wActive}/${wTotal} wallets active`;
    }

    if (foot) {
      const nf =
        typeof data.netFlowUsd === "number" && Number.isFinite(data.netFlowUsd)
          ? data.netFlowUsd
          : null;
      if (nf !== null) {
        // 4-state label so a small non-zero net flow doesn't look like
        // it contradicts the verdict ("$588 BALANCED" was confusing —
        // users read it as "balanced means $0", not "balanced means
        // small enough to be noise"). The QUIET tier explicitly admits
        // that under-$100 flow is rounding noise and shouldn't be
        // treated as either accumulation or distribution.
        let label;
        let cls = "";
        const abs = Math.abs(nf);
        if (abs < 100) {
          label = "QUIET · negligible flow";
        } else if (abs < 1000) {
          label = nf > 0 ? "BALANCED · slight buying" : "BALANCED · slight selling";
        } else if (nf > 0) {
          label = "ACCUMULATING";
          cls = "buy";
        } else {
          label = "DISTRIBUTING";
          cls = "sell";
        }
        // Always show a leading sign so "+ $588" (small inflow) reads
        // as obviously different from "− $588" (small outflow). Zero
        // is shown without sign — `nf >= 0` would also render `+$0`
        // which is awkward.
        // We pass Math.abs(nf) into fmtUsd because fmtUsd itself emits
        // a `$-1.5K` shape on negatives (asserted by its unit tests),
        // and we don't want the doubled minus `−$-1.5K` here.
        const sign = nf > 0 ? "+" : nf < 0 ? "−" : "";
        const valueDisp = sign + fmtUsd(Math.abs(nf));
        foot.innerHTML = `
          <div class="iw-flow ${cls}">
            <span class="iw-flow-label">NET FLOW (${data.windowHours || 6}h)</span>
            <span class="iw-flow-val">${escapeHtml(valueDisp)}</span>
            <span class="iw-flow-state">${escapeHtml(label)}</span>
          </div>
        `;
      } else {
        foot.innerHTML = "";
      }
    }
  } catch {
    renderEmpty("Failed to load insider activity. Re-scan to retry.", "warn");
  }
}

// ──────────────────────────────────────────────────────────────────────
// renderDemoInsiderActivity — synchronous twin of loadInsiderActivity
// for the ?demo=1 path. Receives a pre-baked activity object with the
// same shape as the inner `data` consumed by loadInsiderActivity:
//   { activity[], wallets[], walletsWithActivity, totalCheckedWallets,
//     netFlowUsd, windowHours }
// and renders the same DOM, so the user sees a fully-populated Insider
// Watch feed (with wallet colors, ranks, net-flow footer) without any
// network round-trip. Skipping this in demo mode used to leave the tab
// stuck on the loading skeleton.
// ──────────────────────────────────────────────────────────────────────
export function renderDemoInsiderActivity(demoActivity) {
  if (!demoActivity) return;
  const slot = document.getElementById("ant-insider-feed");
  const meta = document.getElementById("ant-insider-meta");
  const foot = document.getElementById("ant-insider-foot");
  if (!slot) return;

  const activity = Array.isArray(demoActivity.activity) ? demoActivity.activity : [];
  const walletList = Array.isArray(demoActivity.wallets) ? demoActivity.wallets : [];

  // Build rank + color lookups identical to loadInsiderActivity so each
  // activity row gets the right "#N" pill and the wallet-specific color.
  const rankByWallet = new Map();
  const colorByWallet = new Map();
  walletList.forEach((w, i) => {
    if (w && typeof w.walletFull === "string") {
      rankByWallet.set(w.walletFull, i + 1);
      colorByWallet.set(w.walletFull, WALLET_COLORS[i % WALLET_COLORS.length]);
    }
  });

  const rowsHtml = activity
    .map((e) => {
      const action = String(e.action || "").toUpperCase();
      const isBuy = action === "BOUGHT" || action === "TRANSFER_IN";
      const isSell = action === "SOLD" || action === "TRANSFER_OUT";
      const cls = isBuy ? "buy" : isSell ? "sell" : "";
      const usd =
        typeof e.usdValue === "number" && Number.isFinite(e.usdValue)
          ? (e.usdValue > 0 ? "+" : e.usdValue < 0 ? "−" : "") +
            fmtUsd(Math.abs(e.usdValue))
          : "—";
      const tokAmt = fmtTok(e.tokenAmount);
      const ageTxt = formatAgeMin(e.ageMin);
      // Demo rows are inert — wrapping in <div> instead of <a> means no
      // navigation on row click. The wallet sub-cell also gets cursor:
      // default + no click handler so the dashed-underline hover hint
      // doesn't appear. This keeps the user inside the demo experience
      // (clicking out to Solscan from a fake tx hash would land them on
      // a "Transaction not found" page).
      const actionLbl = action.replace("_", " ");
      const rank = rankByWallet.get(e.walletFull) || "?";
      const rankDisp = rank === "?" ? "?" : "#" + rank;
      const wColor = colorByWallet.get(e.walletFull) || "#333";
      return `
      <div class="iw-row iw-row-demo ${cls}" style="--wc:${wColor}">
        <span class="iw-row-rank" title="Rank in top 10 holders">${escapeHtml(rankDisp)}</span>
        <span class="iw-row-wallet" title="${escapeHtml(e.walletFull || "")}">${escapeHtml(e.wallet || "")}</span>
        <span class="iw-row-action">${escapeHtml(actionLbl)}</span>
        <span class="iw-row-amount">${escapeHtml(tokAmt)}</span>
        <span class="iw-row-usd">${escapeHtml(usd)}</span>
        <span class="iw-row-age">${escapeHtml(ageTxt)}</span>
      </div>
    `;
    })
    .join("");

  slot.innerHTML = rowsHtml || `<div class="iw-feed-empty">No on-chain activity from these wallets in the last 6h.</div>`;

  if (meta) {
    const wActive = typeof demoActivity.walletsWithActivity === "number"
      ? demoActivity.walletsWithActivity
      : 0;
    const wTotal = typeof demoActivity.totalCheckedWallets === "number"
      ? demoActivity.totalCheckedWallets
      : walletList.length;
    meta.textContent = `${wActive}/${wTotal} wallets active`;
  }

  if (foot) {
    const nf = typeof demoActivity.netFlowUsd === "number" && Number.isFinite(demoActivity.netFlowUsd)
      ? demoActivity.netFlowUsd
      : null;
    if (nf !== null) {
      let label;
      let cls = "";
      const abs = Math.abs(nf);
      if (abs < 100) {
        label = "QUIET · negligible flow";
      } else if (abs < 1000) {
        label = nf > 0 ? "BALANCED · slight buying" : "BALANCED · slight selling";
      } else if (nf > 0) {
        label = "ACCUMULATING";
        cls = "buy";
      } else {
        label = "DISTRIBUTING";
        cls = "sell";
      }
      const sign = nf > 0 ? "+" : nf < 0 ? "−" : "";
      const valueDisp = sign + fmtUsd(Math.abs(nf));
      foot.innerHTML = `
        <div class="iw-flow ${cls}">
          <span class="iw-flow-label">NET FLOW (${demoActivity.windowHours || 6}h)</span>
          <span class="iw-flow-val">${escapeHtml(valueDisp)}</span>
          <span class="iw-flow-state">${escapeHtml(label)}</span>
        </div>
      `;
    } else {
      foot.innerHTML = "";
    }
  }
}
