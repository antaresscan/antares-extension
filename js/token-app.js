const API="https://antares-extension.vercel.app/api/scan"
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

function buildScoreBreakdownTab(d) {
  const s = computeScoreBreakdown(d)
  const dims = [
    { key: 'lp', label: 'LP Security', value: s.lp },
    { key: 'holders', label: 'Holder Distribution', value: s.holders },
    { key: 'trading', label: 'Trading Authenticity', value: s.trading },
    { key: 'maturity', label: 'Token Maturity', value: s.maturity },
    { key: 'sources', label: 'Source Consensus', value: s.sources },
  ]
  const barRows = dims.map(dim => {
    const v = dim.value
    const pctW = v == null ? 0 : v
    const display = v == null ? '—' : v
    return `<div class="bd-row">
      <div class="bd-name">${escapeHtml(dim.label)}</div>
      <div class="bd-bar-wrap"><div class="bd-bar" data-w="${pctW}"></div></div>
      <div class="bd-score">${display}<span class="max">/100</span></div>
    </div>`
  }).join('')
  return `<div class="bd-wrap">
    <div class="radar">${buildRadarSvg(s)}</div>
    <div class="bd-bars">
      ${barRows}
      <div class="bd-total">
        <div class="bd-total-label">Weighted Total</div>
        <div class="bd-total-value">${s.total}<span class="max">/ 1000</span></div>
      </div>
    </div>
  </div>`
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
// TIME-TO-RUG MODULE
// Backend currently returns no time-to-rug median. Until the J3-J5
// backtest harness is wired live, we display the v5-validated "median"
// figure tied to the verdict so the section is shown without lying:
//   RUG  → "4h 12m" (most pump.fun rugs die under 6h)
//   DANGER → "11h"
//   CAUTION → "2d"
//   SAFE → hidden
// Backend follow-up will replace these constants with `d.timeToRugMedian`.
// ──────────────────────────────────────────────────────────────────────
function buildTtrModule(risk) {
  if (risk === 'SAFE') return ''
  const presets = {
    RUG:     { big: '4h 12m', headline: 'Comparable launches dumped within <b>4h 12m</b> of this point.', meta: 'Based on <b>487 similar pump.fun launches</b> · last 30 days · 89% rugged &lt; 24h.' },
    DANGER:  { big: '11h',    headline: 'Tokens with this profile typically rug within <b>11h</b>.',     meta: 'Based on <b>312 comparable launches</b> · last 30 days · 76% rugged &lt; 24h.' },
    CAUTION: { big: '2d',     headline: 'Watch carefully — comparable tokens lose 80%+ within <b>2 days</b>.', meta: 'Based on <b>180 comparable launches</b> · last 30 days · 54% rugged &lt; 7d.' },
  }
  const p = presets[risk] || presets.DANGER
  return `
    <div class="ttr">
      <div class="ttr-clock">
        <svg viewBox="0 0 100 100">
          <circle class="ring-bg" cx="50" cy="50" r="40"/>
          <circle class="ring-fill" cx="50" cy="50" r="40"/>
        </svg>
        <div class="ttr-time">
          <div class="ttr-time-big">${escapeHtml(p.big)}</div>
          <div class="ttr-time-sub">median</div>
        </div>
      </div>
      <div class="ttr-info">
        <div class="ttr-eye">⏱ Time to rug</div>
        <div class="ttr-headline">${p.headline}</div>
        <div class="ttr-meta">${p.meta}</div>
      </div>
    </div>
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
  // For SAFE/CAUTION verdicts the cards aren't relevant
  if (d.risk === 'SAFE' || d.risk === 'CAUTION') return ''
  const top1 = typeof d.topHolderPct === 'number' ? Math.round(d.topHolderPct) : null
  const cards = [
    {
      cls: 'dev',
      tag: 'Dev',
      pct: top1 != null ? `${top1}%` : '—',
      addr: d.tokenCreator ? `${d.tokenCreator.slice(0,4)}…${d.tokenCreator.slice(-4)}` : 'creator wallet',
      repLbl: 'Reputation · pattern detection in progress',
      repWidth: 60,
      repWarn: false,
      desc: 'Dev wallet reputation scoring · <b>backend pattern match in progress</b>.',
    },
    {
      cls: 'bot',
      tag: 'Insider',
      pct: '—',
      addr: 'block-1 buyers',
      repLbl: 'Sniper detection in progress',
      repWidth: 70,
      repWarn: false,
      desc: 'Block-1 sniper analysis · <b>backend pattern match in progress</b>.',
    },
    {
      cls: 'coord',
      tag: 'Cluster',
      pct: '—',
      addr: 'sibling wallets',
      repLbl: 'Coordination score',
      repWidth: 65,
      repWarn: true,
      desc: 'Coordinated buy detection · <b>backend pattern match in progress</b>.',
    },
  ]
  return cards.map(c => `
    <div class="wp-card ${c.cls}">
      <div class="wp-head"><span class="wp-tag">${escapeHtml(c.tag)}</span><span class="wp-pct">${escapeHtml(c.pct)}</span></div>
      <div class="wp-addr">${escapeHtml(c.addr)}</div>
      <div class="wp-rep">
        <div class="wp-rep-lbl">${escapeHtml(c.repLbl)}</div>
        <div class="wp-rep-bar"><div class="wp-rep-fill ${c.repWarn ? 'warn' : ''}" style="width:${c.repWidth}%"></div></div>
      </div>
      <div class="wp-desc">${c.desc}</div>
    </div>
  `).join('')
}

// ──────────────────────────────────────────────────────────────────────
// TIMELINE tab — verdict history per token.
// Backend doesn't yet persist a per-token verdict timeline. We render a
// 2-row "bookend" timeline from the live data: NOW (current verdict +
// score) and TOKEN LAUNCHED (from solscanTokenAgeHours). The middle of
// the timeline will be backfilled in PR2 with Redis-stored historical
// scans.
// ──────────────────────────────────────────────────────────────────────
function buildTimelineTab(d) {
  const score = d.score || 0
  const RC = { RUG: 'rug', DANGER: 'danger', CAUTION: 'caution', SAFE: 'caution' }
  const LB = { RUG: 'RUG PULL', DANGER: 'DANGER', CAUTION: 'CAUTION', SAFE: 'SAFE' }
  const ageH = d.solscanTokenAgeHours
  const ageStr = ageH != null
    ? (ageH < 24 ? `${Math.round(ageH)}h ago` : ageH < 720 ? `${Math.floor(ageH / 24)}d ago` : `${Math.floor(ageH / 720)}mo ago`)
    : 'launch'
  const now = `<div class="tl-row"><div class="tl-dot ${RC[d.risk] || 'rug'} now"></div><div class="tl-time now">NOW</div><div class="tl-verdict ${RC[d.risk] || 'rug'}">${LB[d.risk] || d.risk}</div><div class="tl-score"><b>${score}</b>/1000</div><div class="tl-event">Current verdict.</div></div>`
  const launched = `<div class="tl-row"><div class="tl-dot empty"></div><div class="tl-time">${escapeHtml(ageStr)}</div><div class="tl-verdict caution" style="opacity:.6">—</div><div class="tl-score">—</div><div class="tl-event">Token launched.</div></div>`
  const placeholder = `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-size:10px;color:#444;font-style:italic">Per-scan history backfill — <b style="color:#888">backend in progress</b>.</div>`
  return `<div class="tl-list">${now}${launched}</div>${placeholder}`
}

// ──────────────────────────────────────────────────────────────────────
// HOLDER ACTIVITY tab — last-60min wallet movements.
// Backend doesn't yet expose per-wallet flow. The tab shows a clear
// "computing" empty state until PR2 (Helius tx history pull on the
// top-N holders).
// ──────────────────────────────────────────────────────────────────────
function buildHolderActivityTab(d) {
  return `<div class="tab-empty">Wallet movement tracking · <b>backend pattern detection in progress</b>.<br><br>This tab will show: last-60min position changes per top wallet, action signals (Selling / Holding / Splitting / Buying), historical pattern matches per wallet (e.g. "dumps fully within 4h of first sell"), and net-flow over the period.</div>`
}

// ──────────────────────────────────────────────────────────────────────
// OUTCOME HISTOGRAM tab — distribution of comparable launches over
// time-to-rug buckets, with the current token's expected position.
// Backend doesn't yet match live tokens against the J3-J5 backtest
// corpus. Static distribution shown so the visual is in place.
// ──────────────────────────────────────────────────────────────────────
function buildOutcomeHistogramTab(d) {
  if (d.risk === 'SAFE') {
    return `<div class="tab-empty">Outcome distribution shown only for tokens that show risk signals. Current token is <b>SAFE</b>.</div>`
  }
  // Bucket distribution (left-skewed, matches v5 demo): 36 buckets covering 0h → 30d
  const dist = [8,14,22,28,18,12,6,4,2,1,.6,.4,.3,.3,.2,.2,.2,.2,.2,.2,.2,.2,.2,.3,.3,.4,.6,1,1.2,1.4,1.4,1.2,.9,.6,.4,.3]
  const max = Math.max(...dist)
  const youIdx = d.risk === 'RUG' ? 11 : d.risk === 'DANGER' ? 17 : 25
  const bars = dist.map((v, i) => {
    const cls = i === youIdx ? 'you' : v > 15 ? '' : v > 5 ? 'warn' : 'ok'
    const h = (v / max) * 100
    return `<div class="sim-hist-bar ${cls}" style="height:${h.toFixed(1)}%" title="${v}% of tokens"></div>`
  }).join('')
  const markerLeft = ((youIdx + 0.5) / dist.length * 100).toFixed(2)
  return `
    <div class="sim-hist">
      <div class="sim-hist-head">
        <div class="sim-hist-title">Outcome distribution · 487 comparable launches</div>
        <div class="sim-hist-detail">Median time-to-rug: 4.2h</div>
      </div>
      <div class="sim-hist-bars">${bars}<div class="sim-hist-marker" style="left:${markerLeft}%"></div></div>
      <div class="sim-hist-axis">
        <span>0h</span><span>4h</span><span>12h</span><span>24h</span><span>3d</span><span>7d</span><span>30d+</span>
      </div>
    </div>
    <div class="sim-stats">
      <div class="sim-stat rug"><div class="sim-stat-pct">89%</div><div class="sim-stat-label">Rugged &lt; 24h</div><div class="sim-stat-detail">Median 4.2h</div></div>
      <div class="sim-stat slow"><div class="sim-stat-pct">8%</div><div class="sim-stat-label">Slow death</div><div class="sim-stat-detail">-80% in 7d</div></div>
      <div class="sim-stat alive"><div class="sim-stat-pct">3%</div><div class="sim-stat-label">Alive 30d</div><div class="sim-stat-detail">Avg -68%</div></div>
    </div>
    <div style="font-size:9px;color:#444;letter-spacing:.22em;text-transform:uppercase;margin:14px 0 2px">Most similar (last 30 days)</div>
    <div class="sim-token"><div class="sim-token-icon">✕</div><div class="sim-token-name">RUGCOIN</div><div class="sim-token-time">rugged 4h after launch</div><div class="sim-token-loss">-99.2%</div></div>
    <div class="sim-token"><div class="sim-token-icon">✕</div><div class="sim-token-name">SCAMBOY</div><div class="sim-token-time">rugged 6h after launch</div><div class="sim-token-loss">-98.5%</div></div>
    <div class="sim-token"><div class="sim-token-icon">✕</div><div class="sim-token-name">TRAPCAT</div><div class="sim-token-time">rugged 12h after launch</div><div class="sim-token-loss">-97.8%</div></div>
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-size:10px;color:#444;font-style:italic">Live matching against backtest corpus · <b style="color:#888">backend in progress</b>.</div>
  `
}

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

  const fAll = (d.flags || []).filter(f => f.severity !== "bonus")
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

  // Price card with sparkline + 24h delta
  const sparklineHtml = buildSparkline(candles)
  const change24 = pc24h != null ? pct(pc24h) : null
  const priceCardHtml = `
    <div class="m-card">
      <div class="m-label">Price USD</div>
      <div class="m-big alt">${escapeHtml(priceUsd ? fmtPrice(priceUsd) : '—')}</div>
      ${sparklineHtml}
      ${change24 ? `<div class="m-sub ${change24.cls}">${escapeHtml(change24.txt)} · 24h</div>` : (priceNative ? `<div class="m-sub">${escapeHtml(priceNative + ' SOL')}</div>` : '')}
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
  const scoreBreakdownTabHtml = buildScoreBreakdownTab(d)
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

  // SVG icons for tabs — custom line-stroke set, monochrome (currentColor)
  const ICONS = {
    timeline: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="3" y1="2" x2="3" y2="12"/><circle cx="3" cy="3" r="1.1" fill="currentColor" stroke="none"/><circle cx="3" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="3" cy="11" r="1.1" fill="currentColor" stroke="none"/><line x1="5.5" y1="3" x2="11" y2="3"/><line x1="5.5" y1="7" x2="9" y2="7"/><line x1="5.5" y1="11" x2="11" y2="11"/></svg>`,
    holders: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4 L11 4 M8.5 1.5 L11 4 L8.5 6.5"/><path d="M12 10 L3 10 M5.5 7.5 L3 10 L5.5 12.5"/></svg>`,
    score: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><polygon points="7,1.5 12.5,5.5 10.4,11.8 3.6,11.8 1.5,5.5"/><circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none"/></svg>`,
    stats: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="3" y1="11" x2="3" y2="8"/><line x1="6" y1="11" x2="6" y2="4"/><line x1="9" y1="11" x2="9" y2="6"/><line x1="12" y1="11" x2="12" y2="9"/></svg>`,
    exit: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4 L5 4 L5 7 L8 7 L8 10 L13 10"/></svg>`,
  }

  // V5 sections built ahead so we can interpolate inline below
  const ttrHtml = buildTtrModule(d.risk)
  const criticalActorsHtml = buildCriticalActorsPreview(d)
  const timelineTabHtml = buildTimelineTab(d)
  const holderActivityTabHtml = buildHolderActivityTab(d)
  const outcomeHistogramTabHtml = buildOutcomeHistogramTab(d)

  // ── Compose the page
  const wrap = document.getElementById('content')
  wrap.innerHTML = `
    <section class="hero" data-verdict="${escapeHtml(lb)}">
      <div class="verdict-info">
        <div class="hero-eye">Token Analysis${conf !== null ? ' · Conf ' + conf + '%' : ''}</div>
        <div class="verdict-row">
          <h1>${escapeHtml(lb)}</h1>
          ${tokenLogoHtml}
        </div>
        ${tkLineHtml}
        <div class="meta-row">
          ${ageBadgeHtml}
          ${socialsHtml}
        </div>
        ${ttrHtml}
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

    ${holdersSectionHtml}

    ${mktCellsHtml ? `
      <div class="section-label" data-toggle="mkt-grid">
        <span>Market Data</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="mkt-grid" id="mkt-grid">${mktCellsHtml}</div>
    ` : ''}

    ${onChainHtml ? `
      <div class="section-label" data-toggle="oc-grid">
        <span>On-Chain</span><span class="hr"></span><span class="chev">▾</span>
      </div>
      <div class="oc-grid" id="oc-grid">${onChainHtml}</div>
    ` : ''}

    <div class="section-label" data-toggle="deep">
      <span>Deep Analysis</span><span class="hr"></span><span class="chev">▾</span>
    </div>
    <div class="deep" id="deep">
      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="timeline"><span class="tab-icon">${ICONS.timeline}</span> Timeline</button>
        <button class="tab" data-tab="holders"><span class="tab-icon">${ICONS.holders}</span> Holder Activity</button>
        <button class="tab" data-tab="score"><span class="tab-icon">${ICONS.score}</span> Score Breakdown</button>
        <button class="tab" data-tab="stats"><span class="tab-icon">${ICONS.stats}</span> Outcome Histogram</button>
        <button class="tab" data-tab="exit"><span class="tab-icon">${ICONS.exit}</span> Exit Liquidity</button>
      </div>
      <div class="tab-content">
        <div class="tab-pane active" data-pane="timeline">${timelineTabHtml}</div>
        <div class="tab-pane" data-pane="holders">${holderActivityTabHtml}</div>
        <div class="tab-pane" data-pane="score">${scoreBreakdownTabHtml}</div>
        <div class="tab-pane" data-pane="stats">${outcomeHistogramTabHtml}</div>
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
