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

import { API, API_BASE, submitFeedback } from "./api-client.js";
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
// FAB Ask Antares — toggle on click; auto-close on outside click. Hover
// also opens (CSS-driven) but click is the touch-friendly path.
// ──────────────────────────────────────────────────────────────────────
export function setupFab() {
  if (window.__fabInit) return;
  window.__fabInit = true;
  const wrap = document.getElementById("ask-fab-wrap");
  if (!wrap) return;
  wrap.removeAttribute("aria-hidden");
  const btn = wrap.querySelector(".ask-fab");
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.classList.toggle("open");
    });
  }
  document.addEventListener("click", () => wrap.classList.remove("open"));
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
        const url = `https://solscan.io/account/${encodeURIComponent(w.walletFull || "")}`;
        return `
        <a class="iw-holder-row ${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
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
    walletList.forEach((w, i) => {
      if (w && typeof w.walletFull === "string") {
        rankByWallet.set(w.walletFull, i + 1);
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
            ? (e.usdValue >= 0 ? "+" : "") + fmtUsd(e.usdValue)
            : "—";
        const tokAmt = fmtTok(e.tokenAmount);
        const ageTxt = formatAgeMin(e.ageMin);
        const sigUrl = `https://solscan.io/tx/${encodeURIComponent(e.signature || "")}`;
        const actionLbl = action.replace("_", " ");
        const rank = rankByWallet.get(e.walletFull) || "?";
        const rankDisp = rank === "?" ? "?" : "#" + rank;
        return `
        <a class="iw-row ${cls}" href="${escapeHtml(sigUrl)}" target="_blank" rel="noopener noreferrer">
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
        let label = "BALANCED";
        let cls = "";
        if (nf > 1000) {
          label = "ACCUMULATING";
          cls = "buy";
        } else if (nf < -1000) {
          label = "DISTRIBUTING";
          cls = "sell";
        }
        const sign = nf >= 0 ? "+" : "";
        foot.innerHTML = `
          <div class="iw-flow ${cls}">
            <span class="iw-flow-label">NET FLOW (${data.windowHours || 6}h)</span>
            <span class="iw-flow-val">${escapeHtml(sign + fmtUsd(nf))}</span>
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
// Feedback modal — wires the "Disagree?" trigger and modal built by
// views.buildFeedbackTrigger / buildFeedbackModal.
//
// Flow:
//   1. User clicks #feedback-trigger → modal opens, original verdict
//      button is disabled, others are selectable.
//   2. User picks a verdict → submit button enables.
//   3. User clicks Submit → POST /api/rugs?action=feedback. Result
//      shown inline in #fb-status; on success, modal auto-closes after
//      a short delay.
//
// Idempotent like the other setupXxx — the wiring uses event-delegated
// handlers on document so re-renders don't compound listeners.
// ──────────────────────────────────────────────────────────────────────
const FEEDBACK_REASON_MESSAGES = {
  duplicate: "You already reported this token in the last 24h. Thanks!",
  same_verdict: "Pick a verdict that differs from the current one.",
  no_storage: "Feedback temporarily unavailable. Please try later.",
  write_failed: "Couldn't save your report. Please try again.",
  network: "Network error — check your connection and retry.",
  bad_response: "Couldn't read the server response. Please retry.",
  request_failed: "Server error. Please retry in a moment.",
};

export function setupFeedbackModal(ca, originalVerdict) {
  if (window.__feedbackInit) return;
  window.__feedbackInit = true;

  const overlay = document.getElementById("fb-overlay");
  if (!overlay) return;

  const closeBtn = document.getElementById("fb-close");
  const trigger = document.getElementById("feedback-trigger");
  const verdictsWrap = document.getElementById("fb-verdicts");
  const note = document.getElementById("fb-note");
  const counter = document.getElementById("fb-counter");
  const submit = document.getElementById("fb-submit");
  const status = document.getElementById("fb-status");

  // Per-modal session state. Resets each time we open the modal.
  let pickedVerdict = null;
  let isSubmitting = false;
  let lastResultIsSuccess = false;

  const open = () => {
    pickedVerdict = null;
    lastResultIsSuccess = false;
    if (note) note.value = "";
    if (counter) counter.textContent = "0 / 500";
    if (status) {
      status.textContent = "";
      status.className = "fb-status";
    }
    if (submit) submit.disabled = true;
    // Disable the verdict that was the original — the backend rejects
    // same-as-original anyway, so we hide the option client-side too.
    if (verdictsWrap) {
      verdictsWrap
        .querySelectorAll(".fb-verdict")
        .forEach((b) => {
          const v = b.dataset.verdict;
          const isOriginal = v === originalVerdict;
          b.disabled = isOriginal;
          b.classList.toggle("disabled", isOriginal);
          b.classList.remove("active");
          // Tooltip the disabled one so users understand why it's greyed.
          if (isOriginal) {
            b.title = "This is the verdict shown to you — pick a different one to report.";
          } else {
            b.removeAttribute("title");
          }
        });
    }
    overlay.removeAttribute("hidden");
    overlay.classList.add("open");
  };

  const close = () => {
    overlay.classList.remove("open");
    overlay.setAttribute("hidden", "");
  };

  if (trigger) trigger.addEventListener("click", open);
  if (closeBtn) closeBtn.addEventListener("click", close);

  // Click outside the modal box closes it (only when the result wasn't
  // a successful submission — we want users to see the success state
  // briefly before the auto-close kicks in).
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && !lastResultIsSuccess && !isSubmitting) close();
  });

  // Esc closes (only when overlay is open + not mid-submit)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (overlay.hasAttribute("hidden")) return;
    if (isSubmitting) return;
    close();
  });

  // Verdict picker — toggle .active on click, enable submit when one is picked.
  if (verdictsWrap) {
    verdictsWrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".fb-verdict");
      if (!btn || btn.disabled) return;
      pickedVerdict = btn.dataset.verdict;
      verdictsWrap.querySelectorAll(".fb-verdict").forEach((b) =>
        b.classList.toggle("active", b === btn),
      );
      if (submit) submit.disabled = false;
    });
  }

  // Note counter — visual signal at 500.
  if (note && counter) {
    note.addEventListener("input", () => {
      const len = note.value.length;
      counter.textContent = `${len} / 500`;
      counter.classList.toggle("near-cap", len > 450);
    });
  }

  // Submit — POST + inline status.
  if (submit) {
    submit.addEventListener("click", async () => {
      if (!pickedVerdict || isSubmitting) return;
      isSubmitting = true;
      submit.disabled = true;
      submit.textContent = "Submitting…";
      if (status) {
        status.textContent = "";
        status.className = "fb-status";
      }

      const result = await submitFeedback({
        ca,
        originalVerdict,
        reportedVerdict: pickedVerdict,
        note: note ? note.value.trim() : "",
      });

      isSubmitting = false;
      submit.textContent = "Submit report";

      if (result.ok) {
        lastResultIsSuccess = true;
        if (status) {
          status.textContent = `Thanks — your report is in. (${result.totalReports} total)`;
          status.className = "fb-status ok";
        }
        // Auto-close after a beat so users see the confirmation.
        setTimeout(close, 1800);
      } else {
        const msg = FEEDBACK_REASON_MESSAGES[result.reason] || "Couldn't submit. Please retry.";
        if (status) {
          status.textContent = msg;
          status.className = "fb-status err";
        }
        submit.disabled = false;
      }
    });
  }
}
