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

function setupRevealObserver() {
  if (window.__obsInit) return
  window.__obsInit = true
  const obs = new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting) return
    e.target.classList.add('visible')
    // Layer bars: animate width from 0 to data-w% on first reveal
    if (e.target.id === 'layers') {
      e.target.querySelectorAll('.layer-bar[data-w]').forEach(b => {
        setTimeout(() => { b.style.width = b.dataset.w + '%' }, 100)
      })
    }
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
  const lpStatus = d.lpBurned === true ? "BURN" : d.lpLocked ? "LOCK" : "NO"
  const sellOk = d.honeypot === false || d.risk !== "RUG"

  const fAll = (d.flags || []).filter(f => f.severity !== "bonus")
  const fCrit = fAll.filter(f => f.severity === "critical")
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
    <span class="ca-pill" id="ca-disp" style="font-size:9px;color:#777;background:#0e0e10;border:1px solid #1e1e22;border-radius:2px;padding:6px 12px;letter-spacing:.06em">${escapeHtml(caShort)}</span>
    <a href="${safeUrl(dexUrl)}" target="_blank" rel="noopener noreferrer">↗ DexScreener</a>
    <a href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer">↗ Solscan</a>
    <a href="https://rugcheck.xyz/tokens/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer" class="warn">⚠ RugCheck</a>
  `

  // ── Build flag rows (or empty state)
  const flagsRowsHtml = fAll.length === 0
    ? `<div class="flag-row"><div class="flag-icon g">✓</div><div class="flag-body"><div class="flag-label ok">No critical flags detected</div><div class="flag-desc">All sources agree — this token has no automated red flags.</div></div></div>`
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
          </div>`
        }).join("")

  const flagsCount = fAll.length === 0
    ? "0 detected"
    : `${fAll.length} detected`

  // ── Security strip cells
  function siBool(label, val, invert) {
    if (val == null) return `<div class="sec-cell"><div class="lbl">${label}</div><div class="val neu">—</div></div>`
    const yes = invert ? !val : !!val
    return `<div class="sec-cell"><div class="lbl">${label}</div><div class="val ${yes ? 'y' : 'n'}">${yes ? '✓' : '✕'}</div></div>`
  }
  const lpCell = (() => {
    if (d.lpBurned) return `<div class="sec-cell"><div class="lbl">LP</div><div class="val y">BURN</div></div>`
    if (d.lpLocked) return `<div class="sec-cell"><div class="lbl">LP</div><div class="val w">LOCK</div></div>`
    if (d.lpBurned == null && d.lpLocked == null) return `<div class="sec-cell"><div class="lbl">LP</div><div class="val neu">—</div></div>`
    return `<div class="sec-cell"><div class="lbl">LP</div><div class="val n">✕</div></div>`
  })()
  const liqCell = liq != null
    ? `<div class="sec-cell"><div class="lbl">Liq</div><div class="val ${liq < 5000 ? 'n' : liq > 50000 ? 'y' : 'w'}">${escapeHtml(fmt(liq))}</div></div>`
    : `<div class="sec-cell"><div class="lbl">Liq</div><div class="val neu">—</div></div>`
  const secStripHtml = `
    <div class="sec-cell"><div class="lbl">Sell</div><div class="val ${sellOk ? 'y' : 'n'}">${sellOk ? '✓' : '✕'}</div></div>
    ${siBool('Mint', mintAuth, true)}
    ${siBool('Freeze', freezeAuth, true)}
    ${lpCell}
    ${liqCell}
  `

  // ── Hero + above-fold
  const tkLineHtml = sym
    ? `<div class="tk-line"><b>${escapeHtml(sym)}</b>${name ? ' ' + escapeHtml(name) : ''}</div>`
    : ''
  const ageBadgeHtml = ageStr
    ? `<span class="age-badge">${escapeHtml(ageStr)}${d.holders != null ? ' · ' + d.holders.toLocaleString() + ' holders' : ''}</span>`
    : pairDate
      ? `<span class="age-badge">Pair: ${escapeHtml(pairDate)}</span>`
      : ''
  const tokenLogoHtml = logo
    ? `<img class="token-logo" src="${safeUrl(logo)}" alt="${escapeHtml(sym)}" onerror="this.style.display='none'"/>`
    : sym
      ? `<div class="token-logo-fallback">${escapeHtml(sym.slice(0, 4))}</div>`
      : ''

  const socialsHtml = [
    ...websites.map(w => `<a class="soc" href="${safeUrl(w.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.label || 'Website')}</a>`),
    ...socials.map(s => `<a class="soc" href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.type || 'Social')}</a>`),
  ].join('')

  // Price card: sparkline if candles, change% sub-label
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

  // ── Market grid (compact, 4 cells max)
  const c5 = pct(pc5m), c1 = pct(pc1h), c6 = pct(pc6h), c24 = pct(pc24h)
  const mktCellsHtml = [
    mc != null && `<div class="mkt-cell"><div class="lbl">Market Cap</div><div class="val">${escapeHtml(fmt(mc))}</div>${c1.txt !== '—' ? `<div class="delta ${c1.cls}">${escapeHtml(c1.txt)}</div>` : ''}</div>`,
    liq != null && `<div class="mkt-cell"><div class="lbl">Liquidity</div><div class="val">${escapeHtml(fmt(liq))}</div></div>`,
    vol24 != null && `<div class="mkt-cell"><div class="lbl">Vol 24h</div><div class="val">${escapeHtml(fmt(vol24))}</div>${c24.txt !== '—' ? `<div class="delta ${c24.cls}">${escapeHtml(c24.txt)}</div>` : ''}</div>`,
    vol1h != null && `<div class="mkt-cell"><div class="lbl">Vol 1h</div><div class="val">${escapeHtml(fmt(vol1h))}</div>${c5.txt !== '—' ? `<div class="delta ${c5.cls}">${escapeHtml(c5.txt)}</div>` : ''}</div>`,
    c6.txt !== '—' && `<div class="mkt-cell"><div class="lbl">Chg 6h</div><div class="val ${c6.cls === 'up' ? 'val' : ''}" style="color:${c6.cls === 'up' ? '#00e5b0' : c6.cls === 'dn' ? '#ff5f5f' : '#ddd'}">${escapeHtml(c6.txt)}</div></div>`,
  ].filter(Boolean).join('')

  // ── On-Chain grid
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

  // ── Layer breakdown
  const SOURCE_LABELS = {
    dexscreener: 'DexScreener', rugcheck: 'RugCheck', goplus: 'GoPlus',
    helius: 'Helius', solscan: 'Solscan', chart: 'Chart',
    crossvalidation: 'Cross-validation',
  }
  const layerEntries = d.layers ? Object.entries(d.layers) : []
  const layerRowsHtml = layerEntries.length > 0
    ? layerEntries.map(([src, l]) => {
        const label = SOURCE_LABELS[src] || src
        if (!l || !l.available) {
          return `<div class="layer-row"><div class="layer-name">${escapeHtml(label)}</div><div class="layer-unavail">Unavailable</div></div>`
        }
        const p = Math.round((l.trust || 0) * 100)
        const cls = p >= 75 ? 'ok' : p >= 40 ? 'warn' : 'bad'
        return `<div class="layer-row">
          <div class="layer-name">${escapeHtml(label)}</div>
          <div class="layer-bar-wrap"><div class="layer-bar ${cls}" data-w="${p}"></div></div>
          <div class="layer-pct ${cls}">${p}</div>
        </div>`
      }).join('')
    : ''

  // ── Sources marquee (deduplicated)
  const FIXED_SOURCES = ["DexScreener", "RugCheck", "GoPlus", "Helius", "Solscan", "Chart Analysis"]
  const apiSources = Array.isArray(d.sources_used) ? d.sources_used : []
  const allSources = [...new Map([...FIXED_SOURCES, ...apiSources].map(s => [String(s).toLowerCase(), s])).values()]
  const marqueeItem = (s) => `<div class="mi"><span class="ok">✓</span>${escapeHtml(s)}</div>`
  const marqueeOnce = allSources.map(marqueeItem).join('')
  const marqueeHtml = marqueeOnce + marqueeOnce  // double for seamless scroll

  // ── AI summary state: render now if available, else placeholder + async fetch
  const aiBodyHtml = d.aiSummary
    ? `<div class="ai-body">${escapeHtml(d.aiSummary)}</div>`
    : `<div class="ai-loading">Generating analysis…</div>`

  // ── Compose the page
  const wrap = document.getElementById('content')
  wrap.innerHTML = `
    <section class="hero" data-verdict="${escapeHtml(lb)}">
      <div class="hero-eye">Token Analysis${conf !== null ? ' · Conf ' + conf + '%' : ''}</div>
      <div class="above">

        <div class="verdict-block">
          <div class="verdict-row">
            <div style="min-width:0;flex:1">
              <h1>${escapeHtml(lb)}</h1>
              ${tkLineHtml}
              ${ageBadgeHtml}
              ${socialsHtml ? `<div class="socials">${socialsHtml}</div>` : ''}
            </div>
            ${tokenLogoHtml}
          </div>

          <div class="metrics-row">
            <div class="m-card">
              <div class="m-label">Risk Score</div>
              <div class="m-big">${score}<span class="denom">/ 1000</span></div>
              <div class="sbar"><div class="sbar-fill" id="sbarf"></div></div>
              <div class="m-sub risk">${escapeHtml(flagSummary)}${conf !== null ? ' · Conf ' + conf + '%' : ''}</div>
            </div>
            ${priceCardHtml}
          </div>

          <div class="ai-card" id="ai-section">
            <div class="ai-head"><span class="icon">⬡</span><h3>AI Verdict</h3></div>
            ${aiBodyHtml}
          </div>
        </div>

        <div class="right-block">
          <div class="flags-card">
            <div class="flags-head">
              <span class="lbl">Critical Flags</span>
              <span class="count">${escapeHtml(flagsCount)}</span>
            </div>
            ${flagsRowsHtml}
          </div>
          <div class="sec-strip">${secStripHtml}</div>
        </div>

      </div>
    </section>

    ${mktCellsHtml ? `
      <div class="section-label reveal"><span>Market Data</span></div>
      <div class="mkt-grid reveal">${mktCellsHtml}</div>
    ` : ''}

    ${onChainHtml ? `
      <div class="section-label reveal"><span>On-Chain</span></div>
      <div class="oc-grid reveal">${onChainHtml}</div>
    ` : ''}

    ${layerRowsHtml ? `
      <div class="section-label reveal"><span>Layer Breakdown</span></div>
      <div class="layers reveal" id="layers">${layerRowsHtml}</div>
    ` : ''}

    <div class="marquee-wrap reveal">
      <div class="marquee-inner">${marqueeHtml}</div>
    </div>
  `

  // Wire up animations + reveal observer (one-shot init guarded inside)
  setupCursorGlow()
  setupStickyNav()
  setupRevealObserver()

  // Score bar animation
  setTimeout(() => {
    const b = document.getElementById('sbarf')
    if (b) b.style.width = barW + '%'
  }, 350)

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
