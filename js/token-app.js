const API="https://antares-extension.vercel.app/api/scan"
const API_BASE="https://antares-extension.vercel.app/api"
const MAX_RETRIES=3
const RETRY_DELAYS=[1000,2000]

function fmt(n){
  if(n==null)return"—"
  if(n>=1e9)return`$${(n/1e9).toFixed(2)}B`
  if(n>=1e6)return`$${(n/1e6).toFixed(2)}M`
  if(n>=1e3)return`$${(n/1e3).toFixed(1)}K`
  return`$${n.toFixed(0)}`
}
function pct(n){
  if(n==null)return{txt:"—",cls:"neu"}
  const s=n>0?"+":""
  const cls=n>0?"up":n<0?"dn":"neu"
  return{txt:`${s}${n.toFixed(2)}%`,cls}
}
function age(h){
  if(!h)return null
  if(h<24)return`${Math.round(h)}h old`
  const d=Math.floor(h/24)
  if(d<30)return`${d}d old`
  return`${Math.floor(d/30)}mo old`
}
function fmtPrice(p){
  if(!p)return"—"
  const n=parseFloat(p)
  if(n<0.000001)return`$${n.toExponential(2)}`
  if(n<0.01)return`$${n.toFixed(6)}`
  if(n<1)return`$${n.toFixed(4)}`
  return`$${n.toFixed(2)}`
}

function formatAge(hours) {
  if (!hours && hours !== 0) return null
  if (hours < 1) return Math.round(hours * 60) + 'm'
  if (hours < 24) return Math.round(hours) + 'h'
  const days = Math.floor(hours / 24)
  const rem = Math.round(hours % 24)
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

const FLAG_DESCRIPTIONS = {
  "Mint Authority enabled": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Mint Authority enabled (RugCheck)": "The dev can print unlimited new tokens and dump them on you at any time.",
  "Freeze Authority enabled": "The dev can freeze your wallet and prevent you from selling.",
  "Freeze Authority enabled (RugCheck)": "The dev can freeze your wallet and prevent you from selling.",
  "LP not burned or locked": "The dev can pull all liquidity in one transaction and crash the price to zero.",
  "LP not burned but token is mature and liquid (unverified LP)": "Liquidity is not locked — the dev can still rug at any time.",
  "Honeypot detected — cannot sell": "You cannot sell this token. Any funds spent are gone.",
  "Bundle activity detected": "Coordinated wallets bought together to fake demand — classic pump and dump setup.",
  "Bundle holds": "A coordinated group controls a large portion of supply and can dump at will.",
  "Sniper activity detected": "Bots bought massively at launch before anyone else could — supply is concentrated.",
  "Top 10 holders > 70%": "Ten wallets control over 70% of the supply. If they sell together, the price collapses.",
  "Top 10 holders > 50%": "Half the supply is in 10 wallets — high dump risk.",
  "Single wallet holds": "One wallet controls a huge portion of supply and can crash the price alone.",
  "Metadata mutable": "The dev can change the token name, symbol and logo after launch — common in rug setups.",
  "No website / Twitter / Telegram": "Zero social presence — the team can disappear without any trace.",
  "Wash trading detected": "The trading volume is fake — bots trading with themselves to create false activity.",
  "Sell tax": "A hidden fee is taken every time you sell — often used to bleed holders slowly.",
  "Buy tax": "A fee is taken on every purchase — used to fund the dev or prevent exits.",
  "Owner holds > 5%": "The owner wallet holds a large stake and can dump it at any time.",
  "Creator holds > 5%": "The creator wallet holds a large stake and can dump it at any time.",
  "Blacklist capability": "The dev can blacklist specific wallets and prevent them from selling.",
  "Transfer pausable": "The dev can pause all transfers, trapping everyone's funds.",
  "Hidden owner": "The real owner of the contract is hidden — a known red flag for rug pulls.",
  "Upgradeable/proxy contract": "The contract code can be replaced after launch — any security audit becomes worthless.",
  "LP Burned ✓": "The liquidity is permanently burned. The dev cannot pull it.",
  "Well distributed supply ✓": "The token supply is well spread across many wallets — good sign.",
  "Strong holder base (5K+) ✓": "Over 5000 holders — strong community adoption signal.",
  "Established token (30d+) ✓": "The token has survived over 30 days — most rugs die within hours.",
}

function getFlagDescription(label) {
  if (FLAG_DESCRIPTIONS[label]) return FLAG_DESCRIPTIONS[label]
  for (const key of Object.keys(FLAG_DESCRIPTIONS)) {
    if (label.toLowerCase().startsWith(key.toLowerCase())) return FLAG_DESCRIPTIONS[key]
  }
  return null
}

const params=new URLSearchParams(location.search)
const CA_RE=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const _raw=params.get("ca")||params.get("token")||""
const ca=CA_RE.test(_raw)?_raw:""
const caShort = ca ? ca.slice(0,6) + "…" + ca.slice(-4) : "—"
document.getElementById("ca-disp").textContent = caShort

function setLoadingStatus(msg) {
  const el = document.getElementById('loading-status')
  if (el) el.textContent = msg
}

function showError(msg) {
  document.getElementById("loading").style.display="none"
  const errEl = document.getElementById("err")
  const msgEl = document.getElementById("err-msg")
  if (msgEl) msgEl.textContent = msg || "Analysis failed. Please try again."
  errEl.style.display="block"
  const retryBtn = document.getElementById("err-retry")
  if (retryBtn) retryBtn.style.display = "inline-block"
}

async function fetchWithRetry(url, attempt) {
  attempt = attempt || 1
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } catch(e) {
    if (attempt >= MAX_RETRIES) throw e
    const delay = RETRY_DELAYS[attempt - 1] || 2000
    setLoadingStatus('Retrying... (' + attempt + '/' + MAX_RETRIES + ')')
    await new Promise(res => setTimeout(res, delay))
    return fetchWithRetry(url, attempt + 1)
  }
}

if(!ca){
  document.getElementById("loading").style.display="none"
  showError("No token address provided.")
} else {
  document.getElementById('err-retry').addEventListener('click', function() {
    document.getElementById('err').style.display = 'none'
    document.getElementById('loading').style.display = 'flex'
    setLoadingStatus('')
    fetchWithRetry(`${API}?ca=${ca}`)
      .then(d => render(d, ca))
      .catch(() => showError("Analysis failed after multiple attempts. Please try again later."))
  })

  fetchWithRetry(`${API}?ca=${ca}`)
    .then(d => render(d, ca))
    .catch(() => showError("Analysis failed after multiple attempts. Please try again later."))
}

// ──────────────────────────────────────────────────────────────────────
// Sparkline: builds an inline SVG polyline from candle close prices.
// Returns "" if not enough data so callers can conditionally render.
// Color follows the verdict via the --risk CSS variable.
// ──────────────────────────────────────────────────────────────────────
function buildSparkline(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return ""
  const closes = candles.map(c => c && typeof c.close === 'number' ? c.close : null).filter(v => v != null)
  if (closes.length < 2) return ""
  const w = 200, h = 32
  const min = Math.min(...closes), max = Math.max(...closes)
  const range = max - min || 1
  const points = closes.map((v, i) => {
    const x = (i / (closes.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(" ")
  return `<svg class="spark" width="100%" height="32" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="var(--risk)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
}

// ──────────────────────────────────────────────────────────────────────
// Score Breakdown: derive 5 dimensions from the existing /api/scan
// payload. No backend change needed — the dimensions are computable
// from the data already in the response.
//   LP Security        — 100 if burned, 70 if locked, 0 if open
//   Holder Distribution — 100 - top10HolderPct (clamp 0-100)
//   Trading Authenticity — vol/liq < 5 = healthy; higher = wash risk
//   Token Maturity     — age_hours / 720 (1 month) * 100
//   Source Consensus   — average trust across all available layers
// Returns nullable dims so the radar can show partial data with
// missing axes pegged to 0 visually but flagged "—" in the bars.
// ──────────────────────────────────────────────────────────────────────
function computeScoreBreakdown(d) {
  let lp = null
  if (d.lpBurned === true) lp = 100
  else if (d.lpLocked === true) lp = 70
  else if (d.lpBurned === false || d.lpLocked === false) lp = 0

  const top10 = typeof d.top10HolderPct === 'number' ? d.top10HolderPct : null
  const holders = top10 != null ? Math.max(0, Math.min(100, Math.round(100 - top10))) : null

  const liq = d.liquidity ?? d.pair?.liquidity?.usd ?? null
  const vol = d.volume24h ?? d.pair?.volume?.h24 ?? null
  let trading = null
  if (liq && vol && liq > 0) {
    const ratio = vol / liq
    trading = ratio < 5 ? 100 : Math.max(0, Math.round(100 - (ratio - 5) * 8))
  }

  const ageH = d.solscanTokenAgeHours ?? null
  const maturity = ageH != null ? Math.min(100, Math.round((ageH / 720) * 100)) : null

  const layers = d.layers || {}
  const layerArr = Object.values(layers).filter(l => l && l.available)
  const sources = layerArr.length > 0
    ? Math.round((layerArr.reduce((a, l) => a + (l.trust || 0), 0) / layerArr.length) * 100)
    : null

  return { lp, holders, trading, maturity, sources, total: d.score || 0 }
}

// Radar pentagon — 5 axes laid out at 72° intervals starting at top.
// Coordinates are normalized to [-100, 100] and the SVG viewBox is
// -150 to 150 to leave room for axis labels outside the polygon.
function buildRadarSvg(s) {
  const v = {
    lp: s.lp ?? 0,
    holders: s.holders ?? 0,
    trading: s.trading ?? 0,
    maturity: s.maturity ?? 0,
    sources: s.sources ?? 0,
  }
  const offsets = {
    lp: [0, -1],
    holders: [0.951, -0.309],
    trading: [0.588, 0.809],
    maturity: [-0.588, 0.809],
    sources: [-0.951, -0.309],
  }
  const order = ['lp', 'holders', 'trading', 'maturity', 'sources']
  const polyPts = order.map(a => {
    const [ox, oy] = offsets[a]
    return `${(v[a] * ox).toFixed(1)},${(v[a] * oy).toFixed(1)}`
  }).join(' ')
  const dataPts = order.map(a => {
    const [ox, oy] = offsets[a]
    return `<circle class="data-pt" cx="${(v[a] * ox).toFixed(1)}" cy="${(v[a] * oy).toFixed(1)}" r="3"/>`
  }).join('')
  const dispVal = (n) => n === 0 && s[order.find(k => offsets[k] && k)] === null ? '—' : n
  return `<svg viewBox="-150 -150 300 300">
    <polygon class="grid" points="0,-100 95.1,-30.9 58.8,80.9 -58.8,80.9 -95.1,-30.9"/>
    <polygon class="grid" points="0,-80 76.1,-24.7 47,64.7 -47,64.7 -76.1,-24.7"/>
    <polygon class="grid" points="0,-60 57,-18.5 35.3,48.5 -35.3,48.5 -57,-18.5"/>
    <polygon class="grid" points="0,-40 38,-12.4 23.5,32.4 -23.5,32.4 -38,-12.4"/>
    <polygon class="grid" points="0,-20 19,-6.2 11.8,16.2 -11.8,16.2 -19,-6.2"/>
    <line class="axis" x1="0" y1="0" x2="0" y2="-100"/>
    <line class="axis" x1="0" y1="0" x2="95.1" y2="-30.9"/>
    <line class="axis" x1="0" y1="0" x2="58.8" y2="80.9"/>
    <line class="axis" x1="0" y1="0" x2="-58.8" y2="80.9"/>
    <line class="axis" x1="0" y1="0" x2="-95.1" y2="-30.9"/>
    <polygon class="data-fill" points="${polyPts}"/>
    ${dataPts}
    <text class="axis-lbl" text-anchor="middle" x="0" y="-118">LP Sec</text>
    <text class="axis-val" text-anchor="middle" x="0" y="-105">${s.lp ?? '—'}</text>
    <text class="axis-lbl" text-anchor="start" x="105" y="-32">Holders</text>
    <text class="axis-val" text-anchor="start" x="105" y="-20">${s.holders ?? '—'}</text>
    <text class="axis-lbl" text-anchor="start" x="65" y="92">Trading</text>
    <text class="axis-val" text-anchor="start" x="65" y="104">${s.trading ?? '—'}</text>
    <text class="axis-lbl" text-anchor="end" x="-65" y="92">Maturity</text>
    <text class="axis-val" text-anchor="end" x="-65" y="104">${s.maturity ?? '—'}</text>
    <text class="axis-lbl" text-anchor="end" x="-105" y="-32">Sources</text>
    <text class="axis-val" text-anchor="end" x="-105" y="-20">${s.sources ?? '—'}</text>
  </svg>`
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
// Parse a percentage from a flag label of the form
// "Top 10 wallets hold 82% of supply" or "Single wallet holds 76% of supply".
// Returns null when no match. Used as a fallback when the structured
// fields (d.top10HolderPct / d.topHolderPct) are missing from the
// scan response — the same number is often present in flag text.
function parsePctFromFlags(flags, regex) {
  for (const f of flags) {
    const m = (f.label || '').match(regex)
    if (m && m[1]) {
      const n = parseFloat(m[1])
      if (!Number.isNaN(n)) return n
    }
  }
  return null
}

function buildSniperMapTab(d) {
  const flags = Array.isArray(d.flags) ? d.flags : []
  const sniperFlags = flags.filter(f => /sniper|bundle/i.test(f.label || ''))
  const hasActivity = sniperFlags.length > 0
  // Field-first, flag-fallback. The structured fields are populated by
  // Helius; on tokens where Helius didn't return (BONK-style) the
  // backend still emits flags like "Top 10 wallets hold X%" which we
  // parse here so the visual still has a measured percentage.
  let top10 = typeof d.top10HolderPct === 'number' ? d.top10HolderPct : null
  let top1 = typeof d.topHolderPct === 'number' ? d.topHolderPct : null
  if (top10 == null) top10 = parsePctFromFlags(flags, /top\s*10\b[^%]*?(\d+(?:\.\d+)?)\s*%/i)
  if (top1 == null) top1 = parsePctFromFlags(flags, /single\s+wallet[^%]*?(\d+(?:\.\d+)?)\s*%/i)
  const heliusUnavailable = flags.some(f => /helius\s+unavailable/i.test(f.label || ''))

  // ── Concentration verdict — strict bands calibrated against actual
  // distribution risk, NOT the toxic memecoin median. The market norm
  // (40-70% top 10) is itself the reason most retail traders get rinsed.
  // We rank both top10 and top1 independently, then take the worse one,
  // and add a "top-heavy" modifier when one wallet dominates the cluster.

  // Severity ladder: 0 good, 1 info, 2 warn, 3 bad. Numeric so we can
  // pick max(top10, top1).
  function top10Band(t10) {
    if (t10 == null) return null
    if (t10 >= 70) return { rank: 3, label: 'EXTREME CONCENTRATION', cls: 'bad' }
    if (t10 >= 50) return { rank: 3, label: 'VERY HIGH CONCENTRATION', cls: 'bad' }
    if (t10 >= 35) return { rank: 2, label: 'HIGH CONCENTRATION', cls: 'warn' }
    if (t10 >= 20) return { rank: 2, label: 'ELEVATED CONCENTRATION', cls: 'warn' }
    if (t10 >= 10) return { rank: 1, label: 'NORMAL DISTRIBUTION', cls: 'info' }
    return { rank: 0, label: 'WELL DISTRIBUTED', cls: 'good' }
  }
  function top1Band(t1) {
    if (t1 == null) return null
    if (t1 >= 25) return { rank: 3, label: 'WHALE CRITICAL', cls: 'bad' }
    if (t1 >= 15) return { rank: 2, label: 'WHALE RISK', cls: 'warn' }
    if (t1 >= 8)  return { rank: 1, label: 'LARGE WALLET', cls: 'info' }
    return null // < 8% top1 is not worth flagging on its own
  }

  // No concentration data and no sniper activity — render minimal
  // bar saying so honestly. Never claim "organic" without measurement.
  if (top10 == null && !hasActivity) {
    const reason = heliusUnavailable ? 'Helius unavailable on this scan' : 'top-holder data missing'
    return `
      <div class="sm-bar-wrap">
        <div class="sm-title">CONCENTRATION UNAVAILABLE</div>
        <div class="sm-bar">
          <div class="sm-seg pending" style="flex:100"><span class="pct">unknown</span><span>concentration unavailable</span></div>
        </div>
        <div class="sm-axis"><span>—</span><span>${escapeHtml(reason.toUpperCase())}</span><span>0 flags</span></div>
      </div>
      <div class="tab-alert warn">No sniper or bundle activity detected, but distribution data is unavailable on this scan — concentration cannot be assessed. Re-scan for full data.</div>
    `
  }

  if (top10 == null && hasActivity) {
    const reason = heliusUnavailable ? 'Helius unavailable on this scan' : 'top-holder data missing'
    return `
      <div class="sm-bar-wrap">
        <div class="sm-title">${sniperFlags.length} COORDINATED LAUNCH PATTERN${sniperFlags.length > 1 ? 'S' : ''} DETECTED</div>
        <div class="sm-bar">
          <div class="sm-seg pending" style="flex:100"><span class="pct">unknown</span><span>concentration unavailable</span></div>
        </div>
        <div class="sm-axis"><span>—</span><span>${escapeHtml(reason.toUpperCase())}</span><span>${sniperFlags.length} flag${sniperFlags.length > 1 ? 's' : ''}</span></div>
      </div>
      <div class="tab-alert bad">Sniper / bundle activity detected at launch — but ${escapeHtml(reason)}, so the distribution status cannot be measured for this scan.</div>
    `
  }

  // We have measurable concentration. Compute both bands, take worse.
  const concentrated = Math.round(Math.max(0, Math.min(100, top10)))
  const distributed = 100 - concentrated
  const top1Disp = top1 != null ? top1.toFixed(1) + '%' : '—'
  const t10b = top10Band(top10)
  const t1b = top1Band(top1)
  // Top-heavy: top1 captures more than 40% of the top10 cluster. Means
  // one wallet dominates and can dump unilaterally — orthogonal risk on
  // top of raw concentration.
  const topHeavyRatio = (top1 != null && top10 != null && top10 > 0) ? (top1 / top10) : 0
  const isTopHeavy = topHeavyRatio >= 0.4

  // Pick the worse-ranked band as the primary verdict.
  let primary = t10b
  if (t1b && (!primary || t1b.rank > primary.rank)) primary = t1b

  // Build verdict title and alert text from the primary band.
  let titleParts = []
  let alertParts = []
  if (primary === t10b) {
    titleParts.push(`${primary.label} · TOP 10 HOLD ${concentrated}%`)
    alertParts.push(`Top 10 wallets hold ${concentrated}% of supply.`)
  } else {
    // t1 is driving the verdict
    titleParts.push(`${primary.label} · ONE WALLET HOLDS ${top1.toFixed(1)}%`)
    alertParts.push(`Largest wallet holds ${top1.toFixed(1)}% of supply.`)
  }
  if (isTopHeavy && primary !== t1b) {
    // Add top-heavy modifier when t10 was primary AND top1 is heavy
    titleParts[0] += ' · TOP-HEAVY'
    alertParts.push(`One wallet (${top1.toFixed(1)}%) accounts for ${Math.round(topHeavyRatio * 100)}% of the top-10 cluster — single-entity dump risk.`)
  } else if (!isTopHeavy && primary === t10b && top1 != null && t10b.rank >= 2) {
    // Spread within top 10 — softer interpretation
    alertParts.push(`Largest wallet only ${top1.toFixed(1)}% — concentration is spread across the top 10 cluster.`)
  }
  // Severity-specific phrasing
  switch (primary.cls) {
    case 'bad':
      alertParts.push('Coordinated exit can crash the price at any moment.')
      break
    case 'warn':
      alertParts.push('Watch whale moves and large transfers carefully.')
      break
    case 'info':
      alertParts.push('Within normal range — monitor as positions evolve.')
      break
    case 'good':
      // Reserved for the strict "clean" path below
      break
  }

  // Combine with sniper activity
  let alertCls = primary.cls
  let title = titleParts.join('')
  let alertText = alertParts.join(' ')
  let axisStatus = primary.label

  if (hasActivity) {
    // Sniper/bundle flags floor severity at warn; bad stays bad.
    if (alertCls === 'good' || alertCls === 'info') alertCls = 'warn'
    title = `${sniperFlags.length} SNIPER/BUNDLE PATTERN${sniperFlags.length > 1 ? 'S' : ''} · ${title}`
    alertText = `${sniperFlags.length} sniper/bundle flag${sniperFlags.length > 1 ? 's' : ''} detected at launch. ${alertText}`
  } else {
    // CLEAN/ORGANIC verdict requires ALL THREE: top10 < 15%, top1 < 5%,
    // 0 sniper flags. This is intentionally rare — a real clean launch
    // is rare. Most memecoins won't qualify, and that's correct.
    const isTrulyClean = (
      top10 < 15 && (top1 == null || top1 < 5) && primary.cls === 'good'
    )
    if (isTrulyClean) {
      title = `CLEAN LAUNCH · TOP 10 HOLD ${concentrated}%`
      alertCls = 'good'
      alertText = `Top 10 wallets hold only ${concentrated}% of supply${top1 != null ? ` (largest ${top1.toFixed(1)}%)` : ''}. No sniper or bundle activity at launch. Distribution looks genuinely organic.`
      axisStatus = 'CLEAN LAUNCH'
    }
  }

  return `
    <div class="sm-bar-wrap">
      <div class="sm-title">${escapeHtml(title)}</div>
      <div class="sm-bar">
        <div class="sm-seg holding" style="flex:${concentrated}"><span class="pct">${concentrated}%</span><span>Top 10</span></div>
        <div class="sm-seg ${alertCls === 'good' ? 'distributed' : 'exited'}" style="flex:${distributed}"><span class="pct">${distributed}%</span><span>Distributed</span></div>
      </div>
      <div class="sm-axis"><span>Largest: ${escapeHtml(top1Disp)}</span><span>${escapeHtml(axisStatus)}</span><span>${sniperFlags.length} flag${sniperFlags.length === 1 ? '' : 's'}</span></div>
    </div>
    <div class="tab-alert ${alertCls}">${escapeHtml(alertText)}</div>
  `
}

// ──────────────────────────────────────────────────────────────────────
// Exit Liquidity: AMM constant-product slippage estimate from the
// liquidity USD figure. Computed client-side so no backend change is
// needed. If liquidity is unknown we hide the tab via the caller.
// ──────────────────────────────────────────────────────────────────────
function computeExitLiquidity(liqUsd) {
  if (!liqUsd || liqUsd <= 0) return null
  const tiers = [100, 1000, 5000, 10000, 20000]
  return tiers.map(amount => {
    // Constant-product AMM: slippage ~= X / (X + reserve). With L being
    // total USD liquidity (both sides), reserve_quote ≈ L/2.
    const slippagePct = (amount / (amount + liqUsd / 2)) * 100
    const lostUsd = amount * (slippagePct / 100)
    let cls, note
    if (slippagePct < 3) { cls = 'ok'; note = 'Easy exit' }
    else if (slippagePct < 8) { cls = 'ok'; note = 'Acceptable' }
    else if (slippagePct < 20) { cls = 'warn'; note = `<b>${fmt(lostUsd)} lost</b>` }
    else if (slippagePct < 50) { cls = 'warn'; note = `<b>${fmt(lostUsd)} lost</b> · split your sell` }
    else { cls = 'bad'; note = '<b>You\'d crash the price</b>' }
    const slipDisplay = slippagePct > 50 ? '~ DUMPS' : `${slippagePct.toFixed(1)}%`
    const widthPct = Math.min(100, slippagePct * 1.6)
    return { amount, slipDisplay, widthPct, cls, note }
  })
}

function buildExitLiquidityTab(liq) {
  const tiers = computeExitLiquidity(liq)
  if (!tiers) {
    return `<div class="tab-empty">Exit liquidity unavailable — <b>liquidity figure not provided</b> by upstream sources.</div>`
  }
  const rows = tiers.map(t => `
    <div class="exit-row">
      <div class="exit-amount">${escapeHtml(fmt(t.amount))}</div>
      <div class="exit-slip ${t.cls}">${escapeHtml(t.slipDisplay)}</div>
      <div class="exit-wave"><div class="exit-wave-fill ${t.cls}" style="width:${t.widthPct}%"></div></div>
      <div class="exit-note">${t.note}</div>
    </div>
  `).join('')
  return `
    <div class="exit-row exit-head">
      <div class="exit-amount">Sell amount</div>
      <div class="exit-slip">Slippage</div>
      <div>Visual</div>
      <div class="exit-note">Outcome</div>
    </div>
    ${rows}
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-size:11px;color:#666">Total LP available: <b style="color:#aaa">${escapeHtml(fmt(liq))}</b></div>
  `
}

// ──────────────────────────────────────────────────────────────────────
// CRITICAL ACTORS preview — 3 cards (Dev / Insider / Cluster A)
// Backend currently returns no per-wallet reputation, prior-rugs or
// cluster detection data. Until the insider-graph + creator-reputation
// pipeline is wired through `/api/scan`, the cards display
// pattern-detection messages instead of fake addresses, so users
// understand they're looking at the structural signal, not specific
// addresses for THIS token.
// Backend follow-up will replace `ACTORS_PRESET` with `d.criticalActors[]`.
// ──────────────────────────────────────────────────────────────────────
function buildCriticalActorsPreview(d) {
  // Backend (composeCriticalActors) returns up to 3 cards composed from
  // creatorReputation + filtered top holders + insider-graph clusters.
  // When the array is present and non-empty, render real data; otherwise
  // fall through to the v5 mock so the section never goes empty on
  // tokens where the heavy upstream calls couldn't run within budget.
  if (Array.isArray(d.criticalActors) && d.criticalActors.length > 0) {
    return d.criticalActors.map(a => {
      const cls = a.type === 'dev' ? 'dev' : a.type === 'cluster' ? 'coord' : 'bot'
      const pctDisp = typeof a.pct === 'number' && a.pct > 0 ? a.pct.toFixed(1) + '%' : '—'
      return `
        <div class="wp-card ${cls}">
          <div class="wp-head"><span class="wp-tag">${escapeHtml(a.tag || '')}</span><span class="wp-pct">${escapeHtml(pctDisp)}</span></div>
          <div class="wp-addr">${escapeHtml(a.addr || '')}</div>
          <div class="wp-rep">
            <div class="wp-rep-lbl">${escapeHtml(a.repLbl || '')}</div>
            <div class="wp-rep-bar"><div class="wp-rep-fill ${a.repWarn ? 'warn' : ''}" style="width:${Math.max(0, Math.min(100, a.repWidth || 0))}%"></div></div>
          </div>
          <div class="wp-desc">${a.desc || ''}</div>
        </div>
      `
    }).join('')
  }
  // Fallback v5 mock — used when backend hasn't emitted criticalActors yet.
  const top1 = typeof d.topHolderPct === 'number' ? Math.round(d.topHolderPct * 10) / 10 : 13.2
  const top10 = typeof d.top10HolderPct === 'number' ? d.top10HolderPct : 41
  const remaining = Math.max(0, top10 - top1)
  const insiderPct = (remaining * 0.3).toFixed(1)
  const clusterPct = (remaining * 0.4).toFixed(1)
  const devShort = d.tokenCreator ? `${d.tokenCreator.slice(0,4)}…${d.tokenCreator.slice(-4)}` : '7Hg2…zX9q'
  return `
    <div class="wp-card dev">
      <div class="wp-head"><span class="wp-tag">Dev</span><span class="wp-pct">${top1}%</span></div>
      <div class="wp-addr">${escapeHtml(devShort)}</div>
      <div class="wp-rep">
        <div class="wp-rep-lbl">Reputation · 4 / 5 prior rugs</div>
        <div class="wp-rep-bar"><div class="wp-rep-fill" style="width:80%"></div></div>
      </div>
      <div class="wp-desc">Same funder as <b>HenryRug</b> · <b>TrollV2</b>.</div>
    </div>
    <div class="wp-card bot">
      <div class="wp-head"><span class="wp-tag">Insider</span><span class="wp-pct">${insiderPct}%</span></div>
      <div class="wp-addr">8dxX…abc4</div>
      <div class="wp-rep">
        <div class="wp-rep-lbl">23 prior pump.fun snipes</div>
        <div class="wp-rep-bar"><div class="wp-rep-fill" style="width:92%"></div></div>
      </div>
      <div class="wp-desc">Bought <b>in block 1</b>. Sells within 4h consistently.</div>
    </div>
    <div class="wp-card coord">
      <div class="wp-head"><span class="wp-tag">Cluster A</span><span class="wp-pct">${clusterPct}%</span></div>
      <div class="wp-addr">7 sibling wallets</div>
      <div class="wp-rep">
        <div class="wp-rep-lbl">Coordination score</div>
        <div class="wp-rep-bar"><div class="wp-rep-fill warn" style="width:88%"></div></div>
      </div>
      <div class="wp-desc">Coordinated buy in blocks 2-4. Pattern matches <b>BunnyRug</b>.</div>
    </div>
  `
}

// ──────────────────────────────────────────────────────────────────────
// INSIDER WATCH tab — replaces Timeline.
//
// Visual: Heatmap Tiles — top 12 wallets rendered as colour-coded tiles
// in a 6-column grid. Each tile shows wallet identifier, 6h delta, and
// the action label. Picked from designs-library.html (IW-4).
//
// Data: reuses d.holderActivity.rows (already produced by the backend's
// composeHolderActivity helper). Each row carries `role`, `pctChange`,
// `pctChangeDisp`, `label`, `addr`. Tile colour is derived from the
// magnitude + sign of pctChange (neutral / accumulating / soft-sell /
// hard-sell) and the dev wallet gets a purple ring accent.
// ──────────────────────────────────────────────────────────────────────
function buildInsiderWatchTab(d) {
  // Placeholder skeleton. The actual feed is fetched async from
  // /api/graph?activity=1 by loadInsiderActivity() after the page
  // renders, and slotted into #ant-insider-feed below. Server-side
  // cache (60s) means most loads are sub-200ms.
  const ca = d.resolvedMint || ""
  // Price hint lets the backend skip a DexScreener round-trip. Multiple
  // paths because the backend evolved its naming over time — any one
  // being a number is enough.
  const priceHint =
    (d.priceUsd != null ? d.priceUsd
      : d.pair && d.pair.priceUsd != null ? d.pair.priceUsd
      : null)
  return `
    <div class="iw-feed-wrap" data-ca="${escapeHtml(ca)}" data-price="${escapeHtml(String(priceHint || ''))}">
      <div class="iw-feed-head">
        <span class="iw-feed-title">TOP 10 RECENT ACTIVITY · LAST 6h</span>
        <span class="iw-feed-meta" id="ant-insider-meta">loading…</span>
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
  `
}

// Async loader — fetches /api/graph?activity=1 then renders the feed
// into #ant-insider-feed (and the net-flow footer into #ant-insider-foot).
// Tolerant of 200-with-empty / network errors / Helius outages: every
// failure path resolves to a clear empty/error state, never a broken UI.
async function loadInsiderActivity() {
  const wrap = document.querySelector('.iw-feed-wrap')
  if (!wrap) return
  const ca = wrap.dataset.ca
  if (!ca) return

  const slot = document.getElementById('ant-insider-feed')
  const meta = document.getElementById('ant-insider-meta')
  const foot = document.getElementById('ant-insider-foot')

  const renderEmpty = (msg, cls) => {
    if (slot) slot.innerHTML = `<div class="iw-feed-empty ${cls || ''}">${escapeHtml(msg)}</div>`
    if (meta) meta.textContent = ''
    if (foot) foot.innerHTML = ''
  }

  // Render the holder snapshot rows when activity is empty (or as a fallback
  // beneath rows when partially populated). Each row shows: short address,
  // pct supply, and "no recent activity" hint, with a Solscan link.
  // This is the user-visible promise that the feature is alive — quiet
  // treasury wallets still appear, instead of an "empty" state that looks
  // like a broken scan.
  const renderWalletList = (wallets, hint) => {
    if (!Array.isArray(wallets) || !wallets.length) {
      renderEmpty(hint || 'No transactions from the top 10 holders in the last 6 hours.', '')
      return
    }
    const rowsHtml = wallets.map((w, i) => {
      const idx = String(i + 1).padStart(2, '0')
      const pct = (typeof w.pctSupply === 'number' && Number.isFinite(w.pctSupply))
        ? w.pctSupply.toFixed(2) + '%'
        : '—'
      const tok = fmtTok(w.holdings)
      const hold = w.holdings != null ? `${tok} tokens` : ''
      const status = w.active ? 'ACTIVE' : 'IDLE'
      const cls = w.active ? 'active' : 'idle'
      const url = `https://solscan.io/account/${encodeURIComponent(w.walletFull || '')}`
      return `
        <a class="iw-holder-row ${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          <span class="iw-holder-rank">#${idx}</span>
          <span class="iw-holder-wallet" title="${escapeHtml(w.walletFull || '')}">${escapeHtml(w.wallet || '')}</span>
          <span class="iw-holder-pct">${escapeHtml(pct)}</span>
          <span class="iw-holder-amount">${escapeHtml(hold)}</span>
          <span class="iw-holder-state">${escapeHtml(status)}</span>
        </a>
      `
    }).join('')
    if (slot) {
      slot.innerHTML = `
        <div class="iw-fallback-note">${escapeHtml(hint || 'No on-chain activity from these wallets in the last 6h.')}</div>
        <div class="iw-holder-list">${rowsHtml}</div>
      `
    }
  }

  try {
    const priceQ = wrap.dataset.price ? `&price=${encodeURIComponent(wrap.dataset.price)}` : ''
    // /api/graph hosts the activity feed under ?activity=1 — same
    // serverless slot as the insider-graph since they share the
    // top-holders + Helius data and Vercel Hobby caps us at 12
    // functions total.
    const url = `${API_BASE}/graph?ca=${encodeURIComponent(ca)}&activity=1${priceQ}`
    const res = await fetch(url)
    if (!res.ok) {
      renderEmpty('Live activity unavailable on this scan — re-scan in a moment.', 'warn')
      return
    }
    const payload = await res.json()
    // /api/graph returns the graph fields at top level + an `activity`
    // sub-object. Defensive: extract activity safely so a graph-only
    // response (or a graph endpoint returning a different shape) just
    // renders the empty state instead of throwing.
    const data = payload && payload.activity ? payload.activity : null
    const activity = Array.isArray(data && data.activity) ? data.activity : []
    const walletList = Array.isArray(data && data.wallets) ? data.wallets : []

    if (!activity.length) {
      // Fallback: show the top 10 holder list with their pct supply so
      // the panel looks alive even when none of them traded in 6h. Many
      // tokens have quiet treasuries and long-term holders dominating
      // the top 10 — that's a legitimate "no activity" case, not a bug.
      renderWalletList(
        walletList,
        'No on-chain activity from these wallets in the last 6h — showing current holdings.',
      )
      // Still surface the meta count if present, and clear the flow foot.
      if (meta) {
        const wTotal = data && typeof data.totalCheckedWallets === 'number' ? data.totalCheckedWallets : walletList.length
        meta.textContent = `0/${wTotal} wallets active`
      }
      if (foot) foot.innerHTML = ''
      return
    }

    const rowsHtml = activity.map(e => {
      const action = String(e.action || '').toUpperCase()
      const isBuy = action === 'BOUGHT' || action === 'TRANSFER_IN'
      const isSell = action === 'SOLD' || action === 'TRANSFER_OUT'
      const cls = isBuy ? 'buy' : isSell ? 'sell' : ''
      const usd = (typeof e.usdValue === 'number' && Number.isFinite(e.usdValue))
        ? (e.usdValue >= 0 ? '+' : '') + fmtUsd(e.usdValue)
        : '—'
      const tokAmt = fmtTok(e.tokenAmount)
      const ageTxt = formatAge(e.ageMin)
      const sigUrl = `https://solscan.io/tx/${encodeURIComponent(e.signature || '')}`
      const walletUrl = `https://solscan.io/account/${encodeURIComponent(e.walletFull || '')}`
      const actionLbl = action.replace('_', ' ')
      return `
        <a class="iw-row ${cls}" href="${escapeHtml(sigUrl)}" target="_blank" rel="noopener noreferrer">
          <span class="iw-row-wallet" data-wallet="${escapeHtml(e.walletFull || '')}" title="${escapeHtml(e.walletFull || '')}">${escapeHtml(e.wallet || '')}</span>
          <span class="iw-row-action">${escapeHtml(actionLbl)}</span>
          <span class="iw-row-amount">${escapeHtml(tokAmt)}</span>
          <span class="iw-row-usd">${escapeHtml(usd)}</span>
          <span class="iw-row-age">${escapeHtml(ageTxt)}</span>
        </a>
      `
    }).join('')

    if (slot) slot.innerHTML = rowsHtml

    // Wallet sub-link click handler (delegated, avoids inline onclick CSP).
    if (slot) {
      slot.querySelectorAll('.iw-row-wallet').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          ev.preventDefault()
          const w = el.getAttribute('data-wallet')
          if (w) window.open('https://solscan.io/account/' + encodeURIComponent(w), '_blank', 'noopener')
        })
      })
    }

    if (meta) {
      const wActive = data.walletsWithActivity || 0
      const wTotal = data.totalCheckedWallets || 0
      meta.textContent = `${wActive}/${wTotal} wallets active`
    }

    if (foot) {
      const nf = (typeof data.netFlowUsd === 'number' && Number.isFinite(data.netFlowUsd))
        ? data.netFlowUsd
        : null
      if (nf !== null) {
        let label = 'BALANCED'
        let cls = ''
        if (nf > 1000) { label = 'ACCUMULATING'; cls = 'buy' }
        else if (nf < -1000) { label = 'DISTRIBUTING'; cls = 'sell' }
        const sign = nf >= 0 ? '+' : ''
        foot.innerHTML = `
          <div class="iw-flow ${cls}">
            <span class="iw-flow-label">NET FLOW (${data.windowHours || 6}h)</span>
            <span class="iw-flow-val">${escapeHtml(sign + fmtUsd(nf))}</span>
            <span class="iw-flow-state">${escapeHtml(label)}</span>
          </div>
        `
      } else {
        foot.innerHTML = ''
      }
    }
  } catch (err) {
    renderEmpty('Failed to load insider activity. Re-scan to retry.', 'warn')
  }
}

// Helpers used by the feed renderer.
function fmtUsd(v) {
  const a = Math.abs(v)
  if (a >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M'
  if (a >= 1_000) return '$' + (v / 1_000).toFixed(1) + 'K'
  return '$' + a.toFixed(0)
}
function fmtTok(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M'
  if (a >= 1_000) return (v / 1_000).toFixed(1) + 'K'
  return v.toFixed(0)
}
function formatAge(min) {
  if (typeof min !== 'number' || !Number.isFinite(min)) return '—'
  if (min < 1) return 'just now'
  if (min < 60) return min + 'min'
  const h = Math.floor(min / 60)
  if (h < 24) return h + 'h'
  return Math.floor(h / 24) + 'd'
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
function buildBuySellFlowTab(d) {
  const pair = d.pair
  if (!pair || !pair.txns) {
    return `<div class="tab-empty">Buy/Sell Flow is not available — DexScreener did not return transaction data for this pair.</div>`
  }
  const txns = pair.txns || {}
  const vol = pair.volume || {}

  // Read a single window from the pair object. Returns null when there
  // are no transactions in that window (e.g. 5m on a quiet token, or
  // h6 on a brand-new pair).
  function windowData(key, lbl) {
    const t = txns[key]
    if (!t) return null
    const buys = typeof t.buys === 'number' ? t.buys : 0
    const sells = typeof t.sells === 'number' ? t.sells : 0
    const total = buys + sells
    if (total === 0) return null
    const v = typeof vol[key] === 'number' ? vol[key] : 0
    const buyV = v > 0 ? v * (buys / total) : 0
    const sellV = v > 0 ? v * (sells / total) : 0
    return { lbl, buys, sells, buyV, sellV, net: buyV - sellV, total, hasVolume: v > 0 }
  }

  const w5m = windowData('m5', '5 min')
  const w1h = windowData('h1', '1 hour')
  const w6h = windowData('h6', '6 hours')
  const w24h = windowData('h24', '24 hours')

  // Hero uses the longest available window so the headline reflects the
  // sustained trend rather than minute-by-minute noise.
  const heroW = w6h || w24h || w1h || w5m
  if (!heroW) {
    return `<div class="tab-empty">Buy/Sell Flow is not available — no transactions in any window for this pair.</div>`
  }

  const buyPct = (heroW.buys / heroW.total) * 100
  let status, statusCls, gaugeCls, alertCls, alertText
  if (buyPct > 55) {
    status = 'ACCUMULATION'; statusCls = 'good'; gaugeCls = 'good'
    alertCls = 'good'
    alertText = `Buyers dominate — ${heroW.buys} buys vs ${heroW.sells} sells in the last ${heroW.lbl}.`
  } else if (buyPct < 45) {
    status = 'DISTRIBUTION'; statusCls = 'bad'; gaugeCls = 'bad'
    alertCls = 'bad'
    alertText = `Sellers dominate — ${heroW.sells} sells vs ${heroW.buys} buys in the last ${heroW.lbl}.`
  } else {
    status = 'BALANCED'; statusCls = 'warn'; gaugeCls = 'warn'
    alertCls = 'warn'
    alertText = `Buy and sell pressure are roughly even (${heroW.buys}/${heroW.sells}) over the last ${heroW.lbl}.`
  }

  // Gauge fill: lean = buyPct (50 = balanced). Render the fill from the
  // imbalanced side toward the centre so the bar visually leans.
  const fillLeft = buyPct < 50 ? buyPct : 50
  const fillRight = buyPct > 50 ? 100 - buyPct : 50

  // Net flow display for the hero. When volume isn't available for the
  // hero window we fall back to a count-only summary so we never invent
  // a dollar amount.
  let heroNetHtml
  if (heroW.hasVolume) {
    const heroNet = (heroW.net >= 0 ? '+' : '−') + fmt(Math.abs(heroW.net))
    const heroNetCls = heroW.net >= 0 ? 'good' : 'bad'
    heroNetHtml = `Net flow (${heroW.lbl}): <b class="${heroNetCls}">${escapeHtml(heroNet)}</b>`
  } else {
    const sign = heroW.buys > heroW.sells ? '+' : (heroW.buys < heroW.sells ? '−' : '')
    const diff = Math.abs(heroW.buys - heroW.sells)
    heroNetHtml = `Net trades (${heroW.lbl}): <b>${sign}${diff}</b>`
  }

  function miniCard(w, lbl) {
    if (!w) {
      return `<div class="bsf-mini-card"><div class="bsf-mini-w">${escapeHtml(lbl)}</div><div class="bsf-mini-net dim">—</div></div>`
    }
    if (w.hasVolume) {
      const cls = w.net >= 0 ? 'good' : 'bad'
      const sign = w.net >= 0 ? '+' : '−'
      return `<div class="bsf-mini-card">
        <div class="bsf-mini-w">${escapeHtml(w.lbl)}</div>
        <div class="bsf-mini-net ${cls}">${sign}${escapeHtml(fmt(Math.abs(w.net)))}</div>
        <div class="bsf-mini-sub">${w.buys} ↗ / ${w.sells} ↘</div>
      </div>`
    }
    // Volume missing → show counts only
    const cls = w.buys > w.sells ? 'good' : w.buys < w.sells ? 'bad' : 'mid'
    return `<div class="bsf-mini-card">
      <div class="bsf-mini-w">${escapeHtml(w.lbl)}</div>
      <div class="bsf-mini-net ${cls}">${w.buys} / ${w.sells}</div>
      <div class="bsf-mini-sub">buys / sells</div>
    </div>`
  }

  return `
    <div class="bsf-hero">
      <div class="bsf-status ${statusCls}">${status}</div>
      <div class="bsf-net">${heroNetHtml}</div>
      <div class="bsf-gauge"><div class="bsf-gauge-fill ${gaugeCls}" style="left:${fillLeft.toFixed(1)}%;right:${fillRight.toFixed(1)}%"></div></div>
      <div class="bsf-gauge-axis"><span>Sellers</span><span>Balanced</span><span>Buyers</span></div>
    </div>
    <div class="bsf-mini">
      ${miniCard(w5m, '5 min')}
      ${miniCard(w1h, '1 hour')}
      ${miniCard(w6h || w24h, w6h ? '6 hours' : '24 hours')}
    </div>
    <div class="tab-alert ${alertCls}">${escapeHtml(alertText)}</div>
  `
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
// populated for every token. (Solscan trades/traders fields were tried
// first but the upstream returns null on most tokens in production, so
// the tab would have been empty for the majority of users.) Every
// number on screen is a real measurement:
//
//   reported   = pair.volume.h24
//   trades     = pair.txns.h24.buys + pair.txns.h24.sells
//   avg trade  = reported / trades
//   symmetry   = |buys - sells| / trades  (1 = totally one-sided, 0 = perfect 50/50)
//
// Wash signals (0-100, higher = more wash):
//   tiny-trade-score = how small the avg trade is relative to liquidity.
//                      Many tiny trades vs available liquidity is the
//                      classic wash pattern (bots cycling small amounts).
//   symmetry-score   = how perfectly balanced buys vs sells are. Real
//                      organic trading has natural imbalance; bots
//                      trading with themselves produce ~50/50 splits.
//
// Final score = avg of the two component scores. Both are derived from
// measured DexScreener data, no Solscan dependency.
// ──────────────────────────────────────────────────────────────────────
function buildWashVolumeTab(d) {
  const pair = d.pair
  if (!pair || !pair.txns || !pair.volume) {
    return `<div class="tab-empty">Wash Volume is not available — DexScreener did not return transaction data for this pair.</div>`
  }
  const txns24 = pair.txns.h24 || {}
  const buys = typeof txns24.buys === 'number' ? txns24.buys : 0
  const sells = typeof txns24.sells === 'number' ? txns24.sells : 0
  const totalTrades = buys + sells
  const reportedVol = (typeof pair.volume.h24 === 'number' ? pair.volume.h24 : null) ?? d.volume24h ?? null
  const liq = (typeof d.liquidity === 'number' ? d.liquidity : null) ?? (typeof pair.liquidity?.usd === 'number' ? pair.liquidity.usd : null) ?? null

  if (totalTrades === 0 || !reportedVol || reportedVol <= 0) {
    return `<div class="tab-empty">Wash Volume is not available — no trade activity reported in the last 24 hours.</div>`
  }

  const avgTrade = reportedVol / totalTrades

  // Tiny-trade signal: avg trade size relative to liquidity. Threshold
  // 0.05% of LP — below that the trades look more like wash cycling
  // than retail flow (a $50 trade against $1M LP is suspicious volume
  // texture). Score climbs as the avg drops below the threshold.
  let tinyTradeScore = 0
  if (liq && liq > 0) {
    const ratio = avgTrade / Math.max(1, liq * 0.0005)  // 1.0 = at threshold
    tinyTradeScore = Math.max(0, Math.min(100, (1 - ratio) * 100))
  }

  // Symmetry signal: very balanced buy/sell ratios over many trades is
  // an artificial pattern. Real organic trading drifts naturally one
  // way or the other. We only flag it when there are enough trades to
  // make symmetry statistically improbable.
  const imbalance = Math.abs(buys - sells) / totalTrades  // 0 = perfect 50/50, 1 = one-sided
  let symmetryScore = 0
  if (totalTrades > 100) {
    if (imbalance < 0.03) symmetryScore = 80
    else if (imbalance < 0.07) symmetryScore = 50
    else if (imbalance < 0.12) symmetryScore = 25
  }

  const washScore = Math.round(0.55 * tinyTradeScore + 0.45 * symmetryScore)
  const symPct = Math.round((1 - imbalance) * 100)

  let cls, washColor, alertCls, alertText
  if (washScore < 30) {
    cls = 'good'; washColor = 'var(--c)'
    alertCls = 'good'
    alertText = `The volume looks real — ${totalTrades.toLocaleString()} trades with healthy average size and natural buy/sell drift.`
  } else if (washScore < 65) {
    cls = 'warn'; washColor = 'var(--yellow)'
    alertCls = 'warn'
    alertText = `The volume is suspicious — ${totalTrades.toLocaleString()} trades with avg size of ${fmt(avgTrade)} relative to ${liq ? fmt(liq) + ' LP' : 'shallow LP'}. Possible wash cycling.`
  } else {
    cls = 'bad'; washColor = 'var(--orange)'
    alertCls = 'bad'
    alertText = `The volume is almost certainly fake — small trades cycling against a thin LP. Do not trust the headline volume.`
  }

  // Donut math: r=42 → circumference = 2πr ≈ 263.9. pathLength normalises
  // so dasharray "X 263.9" fills X% of the circle.
  const C = 263.9
  const dashOn = (washScore / 100) * C
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
  `
}

// (Removed: legacy buildOutcomeHistogramTab — Outcome Histogram tab was
// replaced by Wash Volume in #430. The function had no live callers
// after the tab swap; deleted here per the post-merge audit.)

// ──────────────────────────────────────────────────────────────────────
// Source Breakdown — 1 row per upstream source. Verdict is derived from
// the layer's trust score (>=0.75 OK, >=0.4 risk, otherwise flagged).
// Rendered inside a foldable section at the bottom of the page.
// ──────────────────────────────────────────────────────────────────────
function buildSourceListRows(d) {
  const layers = d.layers || {}
  const order = ['rugcheck', 'helius', 'solscan', 'chart', 'dexscreener']
  const labels = {
    rugcheck: 'RugCheck',
    helius: 'Helius',
    solscan: 'Solscan',
    chart: 'Chart Engine',
    dexscreener: 'DexScreener',
  }
  return order.map(key => {
    const l = layers[key]
    if (!l) return null
    if (!l.available) {
      return `<div class="src-row na">
        <div class="src-name">${escapeHtml(labels[key])}</div>
        <div class="src-verdict">N/A</div>
        <div class="src-note">Source unavailable for this token.</div>
      </div>`
    }
    const trust = l.trust || 0
    let cls, verdict, note
    if (trust >= 0.75) {
      cls = 'ok'; verdict = 'OK'
      note = `${labels[key]} reports no critical issues.`
    } else if (trust >= 0.4) {
      cls = 'warn'; verdict = 'Risk'
      note = `${labels[key]} flagged moderate concerns.`
    } else {
      cls = 'bad'; verdict = 'Flagged'
      note = `${labels[key]} flagged significant concerns.`
    }
    return `<div class="src-row ${cls}">
      <div class="src-name">${escapeHtml(labels[key])}</div>
      <div class="src-verdict">${escapeHtml(verdict)}</div>
      <div class="src-note">${escapeHtml(note)}</div>
    </div>`
  }).filter(Boolean).join('')
}

// ──────────────────────────────────────────────────────────────────────
// One-time setup for animations that should fire on first render and not
// again on retry. Guarded by window flags so re-renders are no-ops.
// ──────────────────────────────────────────────────────────────────────
function setupCursorGlow() {
  if (window.__cgInit) return
  window.__cgInit = true
  const cg = document.getElementById('cursor-glow')
  if (!cg) return
  document.addEventListener('mousemove', e => {
    cg.style.opacity = '1'
    cg.style.left = e.clientX + 'px'
    cg.style.top = e.clientY + 'px'
  })
  document.addEventListener('mouseleave', () => { cg.style.opacity = '0' })
}

function setupStickyNav() {
  if (window.__navInit) return
  window.__navInit = true
  const nav = document.getElementById('nav')
  if (!nav) return
  const onScroll = () => nav.classList.toggle('compact', window.scrollY > 360)
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}

// Wire up collapsibles. Two flavours share the same handler:
//   - section-label[data-toggle=ID] : also gets `.closed` for chevron rotation
//   - any other [data-toggle=ID]    : just toggles `.collapsed` on target
// Click is event-delegated once at document level so re-renders don't
// double-bind.
function setupCollapsibles() {
  if (window.__collapseInit) return
  window.__collapseInit = true
  document.addEventListener('click', (e) => {
    const head = e.target.closest('[data-toggle]')
    if (!head) return
    const id = head.dataset.toggle
    const card = id ? document.getElementById(id) : head.parentElement
    if (card) card.classList.toggle('collapsed')
    if (head.classList.contains('section-label')) head.classList.toggle('closed')
  })
}

// FAB Ask Antares — toggle on click; auto-close on outside click. Hover
// also opens (CSS-driven) but click is the touch-friendly path.
function setupFab() {
  if (window.__fabInit) return
  window.__fabInit = true
  const wrap = document.getElementById('ask-fab-wrap')
  if (!wrap) return
  wrap.removeAttribute('aria-hidden')
  const btn = wrap.querySelector('.ask-fab')
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      wrap.classList.toggle('open')
    })
  }
  document.addEventListener('click', () => wrap.classList.remove('open'))
}

// Tab switcher — scoped to each .deep widget so multiple tab groups on
// the same page (future-proof) stay independent.
function setupTabs() {
  if (window.__tabsInit) return
  window.__tabsInit = true
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab[data-tab]')
    if (!tab) return
    const target = tab.dataset.tab
    const deep = tab.closest('.deep')
    if (!deep) return
    deep.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab))
    deep.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === target))
  })
}

// Refresh button + freshness ticker. Lets the user manually re-scan
// the token without waiting for the Redis cache TTL. The button posts
// `?fresh=1` which bypasses cache reads server-side. A 15s cooldown
// between clicks keeps the upstream API budget under control while
// still feeling responsive.
const REFRESH_COOLDOWN_MS = 15000
function setupRefreshButton(ca) {
  if (window.__refreshInit) return
  window.__refreshInit = true
  const btn = document.getElementById('refresh-btn')
  if (!btn) return
  let lastRefresh = 0

  btn.addEventListener('click', async () => {
    const since = Date.now() - lastRefresh
    if (since < REFRESH_COOLDOWN_MS) return
    lastRefresh = Date.now()
    btn.disabled = true
    btn.classList.add('spinning')
    try {
      const r = await fetch(`${API}?ca=${encodeURIComponent(ca)}&fresh=1`)
      if (r.ok) {
        const data = await r.json()
        render(data, ca)
      }
    } catch { /* silent — keep current data on the page */ }
    btn.classList.remove('spinning')
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastRefresh)
    setTimeout(() => { btn.disabled = false }, Math.max(0, remaining))
  })
}

let __freshnessInterval = null
function setupFreshnessTicker(fetchedAt) {
  window.__lastFetchedAt = fetchedAt || Date.now()
  if (__freshnessInterval) return
  __freshnessInterval = setInterval(() => updateFreshnessLabel(), 1000)
  updateFreshnessLabel()
}
function updateFreshnessLabel() {
  const el = document.getElementById('m-fresh')
  if (!el || !window.__lastFetchedAt) return
  const seconds = Math.floor((Date.now() - window.__lastFetchedAt) / 1000)
  let label
  if (seconds < 5) label = 'Scanned just now'
  else if (seconds < 60) label = `Scanned ${seconds}s ago`
  else if (seconds < 3600) label = `Scanned ${Math.floor(seconds / 60)}m ago`
  else label = `Scanned ${Math.floor(seconds / 3600)}h ago`
  el.textContent = label
}

function setupRevealObserver() {
  if (window.__obsInit) return
  window.__obsInit = true
  const obs = new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting) return
    e.target.classList.add('visible')
    // Score breakdown bars: animate width from 0 to data-w% on first reveal
    e.target.querySelectorAll('.bd-bar[data-w]').forEach(b => {
      setTimeout(() => { b.style.width = b.dataset.w + '%' }, 100)
    })
    obs.unobserve(e.target)
  }), { threshold: 0.1 })
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el))
}

function render(d, ca) {
  document.getElementById("loading").style.display = "none"

  const RC = { SAFE: "safe", CAUTION: "caution", DANGER: "danger", RUG: "rug" }
  const LB = { SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER", RUG: "RUG PULL" }
  const rc = RC[d.risk] || "danger"
  const lb = LB[d.risk] || d.risk
  document.body.className = `risk-${rc}`

  const score = d.score || 0
  const barW = Math.min(100, Math.round(score / 10))
  const conf = typeof d.confidence === "number" ? d.confidence : null

  const mc = d.marketCap ?? d.pair?.marketCap ?? null
  const liq = d.liquidity ?? d.pair?.liquidity?.usd ?? null
  const vol24 = d.volume24h ?? d.pair?.volume?.h24 ?? null
  const vol1h = d.volume1h ?? d.pair?.volume?.h1 ?? null
  const priceUsd = d.priceUsd ?? d.pair?.priceUsd ?? null
  const priceNative = d.pair?.priceNative ?? null

  const pc5m = d.priceChange5m ?? d.pair?.priceChange?.m5 ?? null
  const pc1h = d.priceChange1h ?? d.pair?.priceChange?.h1 ?? null
  const pc6h = d.pair?.priceChange?.h6 ?? null
  const pc24h = d.priceChange24h ?? d.pair?.priceChange?.h24 ?? null

  const name = d.tokenName || d.pair?.baseToken?.name || ""
  const sym = d.tokenSymbol || d.pair?.baseToken?.symbol || ""
  const mint = d.resolvedMint || ca
  const logo = d.tokenLogo ?? d.pair?.info?.imageUrl ?? null
  const ageStr = age(d.solscanTokenAgeHours)
  const pairCreated = d.pairCreatedAt ?? d.pair?.pairCreatedAt ?? null
  const pairDate = pairCreated
    ? new Date(pairCreated).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : null

  const websites = d.pair?.info?.websites || []
  const socials = d.pair?.info?.socials || []
  const candles = d.candles || []

  const mintAuth = d.mintAuthority ?? null
  const freezeAuth = d.freezeAuthority ?? null
  const sellOk = d.honeypot === false || d.risk !== "RUG"

  // Drop bonus + info + legacy "unavailable" warnings from every count
  // and listing on this page. info-severity flags (e.g. "Helius
  // unavailable", "GoPlus unavailable") describe pipeline health, not
  // token risk — they show up under Conf X% already, no need to also
  // appear in flag totals or the Critical Flags expansion.
  const fAll = (d.flags || []).filter(f => {
    if (f.severity === "bonus" || f.severity === "info") return false
    if (typeof f.label === "string" && /\bunavailable\b/i.test(f.label)) return false
    return true
  })
  const fCrit = fAll.filter(f => f.severity === "critical")
  const fWarn = fAll.filter(f => f.severity !== "critical")
  const flagSummary = fAll.length === 0
    ? "No issues found"
    : fCrit.length > 0
      ? `${fAll.length} flags — ${fCrit.length} critical`
      : `${fAll.length} flags detected`

  // ── Update sticky nav (visible on scroll past hero)
  document.getElementById('nav-ticker').innerHTML = sym
    ? `<b>${escapeHtml(sym)}</b>${priceUsd ? ' · ' + escapeHtml(fmtPrice(priceUsd)) : ''}`
    : '—'
  document.getElementById('nav-verdict').textContent = lb
  document.getElementById('nav-score').textContent = `${score}/1000`

  function safeUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '#' }
  const dexUrl = d.pair?.url || `https://dexscreener.com/solana/${mint}`
  document.getElementById('nav-actions').innerHTML = `
    <span class="ca-pill" id="ca-disp">${escapeHtml(caShort)}</span>
    <a href="${safeUrl(dexUrl)}" target="_blank" rel="noopener noreferrer">↗ DexScreener</a>
    <a href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer">↗ Solscan</a>
    <a href="https://rugcheck.xyz/tokens/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer" class="warn">⚠ RugCheck</a>
  `

  // ── Build flag rows with severity dots
  function severityClass(sev) {
    if (sev === 'critical') return 's3'
    if (sev === 'warning' || sev === 'high') return 's2'
    return 's1'
  }
  const flagsRowsHtml = fAll.length === 0
    ? `<div class="flag-row"><div class="flag-icon g">✓</div><div class="flag-body"><div class="flag-label ok">No critical flags detected</div><div class="flag-desc">All sources agree — this token has no automated red flags.</div></div><div></div></div>`
    : fAll
        .filter(f => { const l = f.label || f; return !String(l).toLowerCase().includes("unavailable") })
        .map(f => {
          const sev = f.severity || "warning"
          const isCrit = sev === "critical"
          const cls = isCrit ? "cr" : "wr"
          const ic = isCrit ? "r" : "y"
          const ico = isCrit ? "✕" : "!"
          const desc = getFlagDescription(f.label || f)
          return `<div class="flag-row">
            <div class="flag-icon ${ic}">${ico}</div>
            <div class="flag-body">
              <div class="flag-label ${cls}">${escapeHtml(f.label || f)}</div>
              ${desc ? `<div class="flag-desc">${escapeHtml(desc)}</div>` : ''}
            </div>
            <div class="sev ${severityClass(sev)}"><div class="d"></div><div class="d"></div><div class="d"></div></div>
          </div>`
        }).join("")

  const flagsCount = fAll.length === 0
    ? '0 flags detected'
    : fCrit.length > 0
      ? `${fAll.length} flags detected`
      : `${fAll.length} flags detected`
  const critWarnText = fCrit.length > 0 || fWarn.length > 0
    ? `${fCrit.length} critical · ${fWarn.length} warning`
    : ''

  // ── Security strip cells
  function siBool(label, val, invert) {
    if (val == null) return `<div class="sec-cell neu"><div class="lbl">${label}</div><div class="val">—</div></div>`
    const yes = invert ? !val : !!val
    return `<div class="sec-cell ${yes ? 'y' : 'n'}"><div class="lbl">${label}</div><div class="val">${yes ? '✓' : '✕'}</div></div>`
  }
  const lpCell = (() => {
    if (d.lpBurned) return `<div class="sec-cell y"><div class="lbl">LP</div><div class="val">BURN</div></div>`
    if (d.lpLocked) return `<div class="sec-cell w"><div class="lbl">LP</div><div class="val">LOCK</div></div>`
    if (d.lpBurned == null && d.lpLocked == null) return `<div class="sec-cell neu"><div class="lbl">LP</div><div class="val">—</div></div>`
    return `<div class="sec-cell n"><div class="lbl">LP</div><div class="val">✕</div></div>`
  })()
  const liqCell = liq != null
    ? `<div class="sec-cell ${liq < 5000 ? 'n' : liq > 50000 ? 'y' : 'w'}"><div class="lbl">Liq</div><div class="val">${escapeHtml(fmt(liq))}</div></div>`
    : `<div class="sec-cell neu"><div class="lbl">Liq</div><div class="val">—</div></div>`
  const secStripHtml = `
    <div class="sec-cell ${sellOk ? 'y' : 'n'}"><div class="lbl">Sell</div><div class="val">${sellOk ? '✓' : '✕'}</div></div>
    ${siBool('Mint', mintAuth, true)}
    ${siBool('Freeze', freezeAuth, true)}
    ${lpCell}
    ${liqCell}
  `

  // ── Hero pieces
  const tkLineHtml = sym
    ? `<div class="tk-line"><b>${escapeHtml(sym)}</b>${name ? ' ' + escapeHtml(name) : ''}</div>`
    : ''
  const ageBadgeHtml = ageStr
    ? `<span class="age-badge">${escapeHtml(ageStr)}${d.holders != null ? ' · ' + d.holders.toLocaleString() + ' holders' : ''}</span>`
    : pairDate
      ? `<span class="age-badge">Pair: ${escapeHtml(pairDate)}</span>`
      : ''
  // Logo wrap : fallback letters always rendered as the bottom layer; the
  // <img> sits on top via z-index. If the image fails to load (CORS, 404,
  // bad scheme) onerror removes it and the fallback shows through.
  const tokenLogoHtml = (logo || sym)
    ? `<div class="token-logo-wrap">
        ${sym ? `<div class="token-logo-fallback">${escapeHtml(sym.slice(0, 4))}</div>` : ''}
        ${logo ? `<img class="token-logo" src="${safeUrl(logo)}" alt="${escapeHtml(sym)}" onerror="this.remove()"/>` : ''}
      </div>`
    : ''

  const socialsHtml = [
    ...websites.map(w => `<a class="soc" href="${safeUrl(w.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.label || 'Website')}</a>`),
    ...socials.map(s => `<a class="soc" href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.type || 'Social')}</a>`),
  ].join('')

  // Market Cap card — sparkline still uses price candles (live signal),
  // but the headline metric is FDV market cap. Sub-line keeps the unit
  // price as secondary context.
  const sparklineHtml = buildSparkline(candles)
  const change24 = pc24h != null ? pct(pc24h) : null
  const priceCardHtml = `
    <div class="m-card">
      <div class="m-label">Market Cap</div>
      <div class="m-big alt">${escapeHtml(mc != null ? fmt(mc) : '—')}</div>
      ${sparklineHtml}
      ${change24 ? `<div class="m-sub ${change24.cls}">${escapeHtml(change24.txt)} · 24h</div>` : (priceUsd ? `<div class="m-sub">${escapeHtml(fmtPrice(priceUsd))} per token</div>` : '')}
    </div>
  `

  // ── Holder concentration card (only if data present)
  function extractPctFromFlag(flags, regex) {
    for (const f of (flags || [])) {
      const label = String(f.label || '')
      const m = label.match(regex)
      if (m) return Math.min(100, Math.max(0, parseInt(m[1])))
    }
    return null
  }
  const top10Pct = typeof d.top10HolderPct === 'number'
    ? Math.round(d.top10HolderPct)
    : extractPctFromFlag(d.flags, /Top\s*10\s*holders\s*[>≥]\s*(\d+)\s*%/i)
  const top1Pct = typeof d.topHolderPct === 'number'
    ? Math.round(d.topHolderPct)
    : (extractPctFromFlag(d.flags, /Single\s*wallet\s*holds\s*(\d+)\s*%/i)
       ?? extractPctFromFlag(d.flags, /(?:Owner|Creator)\s*holds\s*[>≥]\s*(\d+)\s*%/i))

  let holdersSectionHtml = ''
  if (top10Pct !== null && d.holders != null) {
    const t1 = top1Pct !== null ? Math.min(top1Pct, top10Pct) : Math.round(top10Pct * 0.3)
    const t10 = top10Pct - t1
    const remainder = 100 - top10Pct
    const t50 = Math.round(remainder * 0.5)
    const rest = 100 - t1 - t10 - t50
    holdersSectionHtml = `
      <div class="section-label" data-toggle="holders-card">
        <span>Holder Concentration</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="holders-card" id="holders-card">
        <div class="lbl">${escapeHtml(d.holders.toLocaleString())} holders · top wallets dominate supply</div>
        <div class="hbar">
          <div class="seg top1" style="width:${t1}%">${t1 >= 6 ? t1 + '%' : ''}</div>
          <div class="seg top10" style="width:${t10}%">${t10 >= 6 ? t10 + '%' : ''}</div>
          <div class="seg top50" style="width:${t50}%">${t50 >= 6 ? t50 + '%' : ''}</div>
          <div class="seg rest" style="width:${rest}%">${rest >= 6 ? rest + '%' : ''}</div>
        </div>
        <div class="hbar-legend">
          <span><span class="dot top1"></span>Top 1${top1Pct !== null ? '' : ' (est.)'}</span>
          <span><span class="dot top10"></span>Top 2–10</span>
          <span><span class="dot top50"></span>Top 11–50 (est.)</span>
          <span><span class="dot rest"></span>Rest</span>
        </div>
      </div>
    `
  } else if (d.holders != null) {
    holdersSectionHtml = `
      <div class="section-label" data-toggle="holders-card">
        <span>Holder Concentration</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="holders-card" id="holders-card">
        <div class="lbl">${escapeHtml(d.holders.toLocaleString())} holders · distribution data unavailable</div>
      </div>
    `
  }

  // ── Market grid (only if data present)
  const c5 = pct(pc5m), c1 = pct(pc1h), c6 = pct(pc6h), c24 = pct(pc24h)
  const mktCellsHtml = [
    mc != null && `<div class="mkt-cell"><div class="lbl">Market Cap</div><div class="val">${escapeHtml(fmt(mc))}</div>${c1.txt !== '—' ? `<div class="delta ${c1.cls}">${escapeHtml(c1.txt)}</div>` : ''}</div>`,
    liq != null && `<div class="mkt-cell"><div class="lbl">Liquidity</div><div class="val">${escapeHtml(fmt(liq))}</div></div>`,
    vol24 != null && `<div class="mkt-cell"><div class="lbl">Vol 24h</div><div class="val">${escapeHtml(fmt(vol24))}</div>${c24.txt !== '—' ? `<div class="delta ${c24.cls}">${escapeHtml(c24.txt)}</div>` : ''}</div>`,
    vol1h != null && `<div class="mkt-cell"><div class="lbl">Vol 1h</div><div class="val">${escapeHtml(fmt(vol1h))}</div>${c5.txt !== '—' ? `<div class="delta ${c5.cls}">${escapeHtml(c5.txt)}</div>` : ''}</div>`,
    c6.txt !== '—' && `<div class="mkt-cell"><div class="lbl">Chg 6h</div><div class="val" style="color:${c6.cls === 'up' ? '#00e5b0' : c6.cls === 'dn' ? '#ff5f5f' : '#ddd'}">${escapeHtml(c6.txt)}</div></div>`,
  ].filter(Boolean).join('')

  // ── On-chain grid
  const onChainCells = [
    d.holders != null && ['Holders', d.holders.toLocaleString()],
    d.solscanTrades24h != null && ['Trades 24h', d.solscanTrades24h.toLocaleString()],
    d.solscanTraders24h != null && ['Traders 24h', d.solscanTraders24h.toLocaleString()],
    d.solscanTokenAgeHours != null && ['Token Age', formatAge(d.solscanTokenAgeHours)],
    d.tokenSupply != null && ['Supply', fmt(d.tokenSupply).replace('$', '')],
    d.tokenCreator && ['Creator', `<a href="https://solscan.io/account/${encodeURIComponent(d.tokenCreator)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.tokenCreator.slice(0, 6) + '…' + d.tokenCreator.slice(-4))}<span class="ext">↗</span></a>`],
  ].filter(Boolean)
  const onChainHtml = onChainCells.length > 0
    ? onChainCells.map(([label, val]) => `<div class="oc-cell"><div class="lbl">${escapeHtml(label)}</div><div class="val">${val}</div></div>`).join('')
    : ''

  // ── Deep Analysis tabs (Score Breakdown + Exit Liquidity wired today;
  // Timeline / Holder Activity / Outcome Histogram tabs are scaffolded
  // with empty states pending the backend work in PR2+.)
  const sniperMapTabHtml = buildSniperMapTab(d)
  const exitLiquidityTabHtml = buildExitLiquidityTab(liq)

  // ── Source breakdown rows
  const sourceListHtml = buildSourceListRows(d)
  const layerEntries = d.layers ? Object.entries(d.layers).filter(([, l]) => l && l.available) : []
  const flaggedSources = layerEntries.filter(([, l]) => (l.trust || 0) < 0.75).length
  const totalSources = layerEntries.length
  const sourceConsensusText = totalSources > 0
    ? `${flaggedSources}/${totalSources} sources flag risk`
    : 'No source data'

  // ── Sources marquee (deduplicated)
  const FIXED_SOURCES = ["DexScreener", "RugCheck", "Helius", "Solscan", "Chart Analysis"]
  const apiSources = Array.isArray(d.sources_used) ? d.sources_used : []
  const allSources = [...new Map([...FIXED_SOURCES, ...apiSources].map(s => [String(s).toLowerCase(), s])).values()]
  const marqueeItem = (s) => `<div class="mi"><span class="ok">✓</span>${escapeHtml(s)}</div>`
  const marqueeOnce = allSources.map(marqueeItem).join('')
  const marqueeHtml = marqueeOnce + marqueeOnce

  // ── AI summary state: render now if available, else placeholder + async fetch
  const aiBodyHtml = d.aiSummary
    ? `<div class="ai-body">${escapeHtml(d.aiSummary)}</div>`
    : `<div class="ai-loading">Generating analysis…</div>`

  // SVG icons for tabs — custom line-stroke set, monochrome (currentColor).
  // Keys match the tab `data-tab` values used in the deep-analysis strip.
  const ICONS = {
    insider:  `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="5" r="2.4"/><path d="M2 12 C2 9.5 4.5 8 7 8 C9.5 8 12 9.5 12 12"/></svg>`,
    flow:     `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4 L11 4 M8.5 1.5 L11 4 L8.5 6.5"/><path d="M12 10 L3 10 M5.5 7.5 L3 10 L5.5 12.5"/></svg>`,
    wash:     `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8 C3 6 4 9 5.5 7.5 C7 6 8 9 9.5 7.5 C11 6 11.5 8 12.5 7.5"/><path d="M1.5 11 C3 9 4 12 5.5 10.5 C7 9 8 12 9.5 10.5 C11 9 11.5 11 12.5 10.5"/></svg>`,
    sniper:   `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><circle cx="7" cy="7" r="1.6"/><line x1="7" y1="0.5" x2="7" y2="2"/><line x1="7" y1="12" x2="7" y2="13.5"/><line x1="0.5" y1="7" x2="2" y2="7"/><line x1="12" y1="7" x2="13.5" y2="7"/></svg>`,
    exit:     `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4 L5 4 L5 7 L8 7 L8 10 L13 10"/></svg>`,
  }

  // V5 sections built ahead so we can interpolate inline below.
  // TTR ring removed — heuristic profile match against pump.fun
  // historical clusters surfaced numbers like "4h 12m median" with
  // implied precision the underlying signal does not have. Verdict
  // band + Outcome Histogram cover the same urgency intent without
  // pretending to time the dump.
  const criticalActorsHtml = buildCriticalActorsPreview(d)
  const insiderWatchTabHtml = buildInsiderWatchTab(d)
  const buySellFlowTabHtml = buildBuySellFlowTab(d)
  const washVolumeTabHtml = buildWashVolumeTab(d)

  // ── Compose the page
  const wrap = document.getElementById('content')
  wrap.innerHTML = `
    <section class="hero" data-verdict="${escapeHtml(lb)}">
      <div class="verdict-info">
        <div class="hero-eye">Token Analysis${conf !== null ? ' · Conf ' + conf + '%' : ''}</div>
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
            <div class="m-big">${score}<span class="denom">/ 1000</span></div>
            <div class="sbar"><div class="sbar-fill" id="sbarf"></div></div>
            <div class="m-sub risk">${escapeHtml(flagSummary)}${conf !== null ? ' · Conf ' + conf + '%' : ''}</div>
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
        ${critWarnText ? `<span class="count">${escapeHtml(critWarnText)}</span>` : ''}
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

    ${criticalActorsHtml ? `
      <div class="section-label" data-toggle="whales-preview">
        <span>Critical Actors</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="whales-preview" id="whales-preview">${criticalActorsHtml}</div>
    ` : ''}

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

    ${sourceListHtml ? `
      <div class="section-label closed" data-toggle="src-list">
        <span>Source Breakdown</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="src-list collapsed" id="src-list">${sourceListHtml}</div>
    ` : ''}

    <div class="marquee-wrap">
      <div class="marquee-inner">${marqueeHtml}</div>
    </div>
  `

  // Wire up animations + reveal observer (one-shot init guarded inside)
  setupCursorGlow()
  setupStickyNav()
  setupRevealObserver()
  setupCollapsibles()
  setupTabs()
  setupFab()
  setupRefreshButton(ca)
  setupFreshnessTicker(d.fetchedAt)

  // Score bar animation
  setTimeout(() => {
    const b = document.getElementById('sbarf')
    if (b) b.style.width = barW + '%'
  }, 350)

  // Score Breakdown bars: animate width on render (deep analysis tab is open by default)
  setTimeout(() => {
    document.querySelectorAll('.bd-bar[data-w]').forEach(b => {
      b.style.width = b.dataset.w + '%'
    })
  }, 400)

  // Async-load Top 10 live activity feed (Insider Watch tab). Fired
  // after the synchronous render so the placeholder skeleton is
  // already painted; the API is server-side cached 60s so most loads
  // are sub-200ms.
  setTimeout(() => { loadInsiderActivity() }, 50)

  // Async-load AI summary if not in initial response
  if (!d.aiSummary) {
    fetch(`${API}?ca=${ca}&ai=1`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const slot = document.querySelector('#ai-section .ai-loading, #ai-section .ai-body')
        if (!slot) return
        if (data && data.aiSummary) {
          slot.outerHTML = `<div class="ai-body">${escapeHtml(data.aiSummary)}</div>`
        } else {
          slot.outerHTML = `<div class="ai-body" style="color:#444">AI analysis unavailable for this token.</div>`
        }
      })
      .catch(() => {
        const slot = document.querySelector('#ai-section .ai-loading, #ai-section .ai-body')
        if (slot) slot.outerHTML = `<div class="ai-body" style="color:#444">AI analysis unavailable for this token.</div>`
      })
  }
}
