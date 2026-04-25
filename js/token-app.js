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
document.getElementById("ca-disp").textContent=ca?ca.slice(0,8)+"..."+ca.slice(-6):"—"

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

function render(d,ca){
  document.getElementById("loading").style.display="none"
  const wrap=document.getElementById("content")
  wrap.style.display="block"

  const RC={SAFE:"safe",CAUTION:"caution",DANGER:"danger",RUG:"rug"}
  const LB={SAFE:"SAFE",CAUTION:"CAUTION",DANGER:"DANGER",RUG:"RUG PULL"}
  const rc=RC[d.risk]||"danger"
  const lb=LB[d.risk]||d.risk
  const score=d.score||0
  const barW=Math.min(100,Math.round(score/10))
  const conf=typeof d.confidence==="number"?d.confidence:null

  const mc=d.marketCap??d.pair?.marketCap??null
  const liq=d.liquidity??d.pair?.liquidity?.usd??null
  const vol24=d.volume24h??d.pair?.volume?.h24??null
  const vol1h=d.volume1h??d.pair?.volume?.h1??null
  const priceUsd=d.priceUsd??d.pair?.priceUsd??null
  const priceNative=d.pair?.priceNative??null

  const pc5m=d.priceChange5m??d.pair?.priceChange?.m5??null
  const pc1h=d.priceChange1h??d.pair?.priceChange?.h1??null
  const pc6h=d.pair?.priceChange?.h6??null
  const pc24h=d.priceChange24h??d.pair?.priceChange?.h24??null

  const txH1=d.pair?.txns?.h1??null
  const txH6=d.pair?.txns?.h6??null
  const txH24=d.pair?.txns?.h24??null

  const name=d.tokenName||d.pair?.baseToken?.name||""
  const sym=d.tokenSymbol||d.pair?.baseToken?.symbol||""
  const mint=d.resolvedMint||ca
  const logo=d.tokenLogo??d.pair?.info?.imageUrl??null
  const ageStr=age(d.solscanTokenAgeHours)
  const pairCreated=d.pairCreatedAt??d.pair?.pairCreatedAt??null

  const websites=d.pair?.info?.websites||[]
  const socials=d.pair?.info?.socials||[]

  const mintAuth=d.mintAuthority??null
  const freezeAuth=d.freezeAuthority??null
  const lpStatus=d.lpBurned===true?"BURN":d.lpLocked?"LOCK":"NO"
  const sellOk=d.honeypot===false||d.risk!=="RUG"

  const fAll=(d.flags||[]).filter(f=>f.severity!=="bonus")
  const fCrit=fAll.filter(f=>f.severity==="critical")
  let summary=fAll.length===0
    ?"All sources agree — no issues found"
    :fCrit.length>0
      ?`${fAll.length} flags — ${fCrit.length} critical — Conf. ${conf??""}%`
      :`${fAll.length} flags detected — Conf. ${conf??""}%`

  const flagsHtml=(d.flags||[])
    .filter(f=>{const l=f.label||f;return!l.toLowerCase().includes("unavailable")&&f.severity!=="bonus"})
    .map(f=>{
      const sev=f.severity||"warning"
      const isCrit=sev==="critical"
      const isBonus=sev==="bonus"
      const cls=isCrit?"cr":isBonus?"ok":"wr"
      const ic=isCrit?"r":isBonus?"g":"y"
      const ico=isCrit?"✕":isBonus?"✓":"!"
      const desc=getFlagDescription(f.label||f)
      return`<div class="fl ${cls}"><div class="fic ${ic}">${ico}</div><div class="f-body"><span class="fl-txt">${escapeHtml(f.label||f)}</span>${desc?`<div class="flag-desc">${escapeHtml(desc)}</div>`:''}</div></div>`
    }).join("")
  const noFlags=flagsHtml===""
    ?`<div class="fl ok"><div class="fic g">✓</div><div class="f-body"><span class="fl-txt">No critical flags detected</span></div></div>`
    :flagsHtml

  const c5=pct(pc5m),c1=pct(pc1h),c6=pct(pc6h),c24=pct(pc24h)
  const changesHtml=`
    <div class="changes">
      <div class="ch"><span>5 min</span><b class="${c5.cls}">${c5.txt}</b></div>
      <div class="ch"><span>1 hour</span><b class="${c1.cls}">${c1.txt}</b></div>
      <div class="ch"><span>6 hours</span><b class="${c6.cls}">${c6.txt}</b></div>
      <div class="ch"><span>24 hours</span><b class="${c24.cls}">${c24.txt}</b></div>
    </div>`

  function txnCard(label,txObj){
    if(!txObj)return""
    const total=txObj.buys+txObj.sells||1
    const buyPct=Math.round(txObj.buys/total*100)
    const sellPct=100-buyPct
    return`<div class="txn">
      <span>${label}</span>
      <div class="txn-line"><span class="txn-buy">${txObj.buys}B</span><span class="txn-sep">/</span><span class="txn-sell">${txObj.sells}S</span></div>
      <div class="txn-bar-wrap"><div class="txn-bar-buy" style="width:${buyPct}%"></div><div class="txn-bar-sell" style="width:${sellPct}%"></div></div>
    </div>`
  }

  const dotsCount=Math.round((score/1000)*5)
  const dotsHtml=Array.from({length:5},(_,i)=>`<div class="dt ${i<dotsCount?'on':'off'}"></div>`).join("")

  const siSell=`<div class="si"><span>Sell</span><b class="${sellOk?'y':'n'}">${sellOk?'✓':'✕'}</b></div>`
  const siMint=`<div class="si"><span>Mint</span><b class="${mintAuth?'n':'y'}">${mintAuth?'ON':'OFF'}</b></div>`
  const siFreeze=`<div class="si"><span>Freeze</span><b class="${freezeAuth?'n':'y'}">${freezeAuth?'ON':'OFF'}</b></div>`
  const siLP=`<div class="si"><span>LP</span><b class="${lpStatus==='NO'?'n':lpStatus==='BURN'?'y':'w'}">${lpStatus}</b></div>`
  const siLiq=liq?`<div class="si"><span>Liq</span><b class="${liq<5000?'n':liq<30000?'w':'y'}">${fmt(liq)}</b></div>`:""
  const siConf=conf!==null?`<div class="si"><span>Conf.</span><b class="${conf<50?'n':conf<80?'w':'y'}">${conf}%</b></div>`:""

  const FIXED_SOURCES=["DexScreener","RugCheck","GoPlus","Helius"]
  const apiSources=Array.isArray(d.sources_used)?d.sources_used:[]
  const allSources=[...new Map([...FIXED_SOURCES,...apiSources].map(s=>[s.toLowerCase(),s])).values()]
  const sourcesHtml=allSources
    .map(s=>`<div class="src-row"><span>${s}</span><span>✓ used</span></div>`).join("")

  function safeUrl(u){return typeof u==='string'&&/^https?:\/\//i.test(u)?u:'#'}
  const socialsHtml=[
    ...websites.map(w=>`<a class="soc" href="${safeUrl(w.url)}" target="_blank" rel="noopener">${w.label||'Website'}</a>`),
    ...socials.map(s=>`<a class="soc" href="${safeUrl(s.url)}" target="_blank" rel="noopener">${s.type}</a>`)
  ].join("")

  const pairDate=pairCreated?new Date(pairCreated).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):null
  const dexUrl=d.pair?.url||`https://dexscreener.com/solana/${ca}`

  window.__riskClass=rc

  // ── Logo token (top-right) — shown if available
  const logoHtml=logo
    ?`<img class="token-logo" src="${logo}" alt="${escapeHtml(sym)}" onerror="this.style.display='none'"/>`
    :""

  // ── tk-name: symbol + full name, properly closed
  const tkNameHtml=sym
    ?`<div class="tk-name"><b>${escapeHtml(sym)}</b>${name?' '+escapeHtml(name):''}</div>`
    :""

  // ── age badge
  const ageBadgeHtml=ageStr
    ?`<div class="age-badge">${ageStr}</div>`
    :pairDate?`<div class="age-badge">Pair: ${pairDate}</div>`:""

  wrap.innerHTML=`
    <div class="${rc}">
      <div class="risk-wrap ${rc}">
        <div class="topbar"></div>

        <!-- verdict + name + age on the left, token logo on the right -->
        <div class="token-header">
          <div class="token-header-text">
            <div class="vt" data-label="${escapeHtml(lb)}">${lb}</div>
            ${tkNameHtml}
            ${ageBadgeHtml}
          </div>
          ${logoHtml}
        </div>

        <!-- price, score bar and confidence BELOW the header row, full width -->
        ${priceUsd?`<div class="price-big">${fmtPrice(priceUsd)} <span>${priceNative?priceNative+' SOL':''}</span></div>`:""}
        <div class="score-row">
          <span class="sc-num"><b>${score}</b> / 1000</span>
          <div class="dots">${dotsHtml}</div>
          <div class="sbar"><div class="sbar-f" id="sbarf"></div></div>
        </div>
        <div class="conf-line">${summary}</div>
        ${socialsHtml?`<div class="socials">${socialsHtml}</div>`:""}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Market Data</div>
      <div class="grid g4">
        ${mc?`<div class="stat"><span>Market Cap</span><strong>${fmt(mc)}</strong></div>`:""}
        ${liq?`<div class="stat"><span>Liquidity</span><strong>${fmt(liq)}</strong></div>`:""}
        ${vol24?`<div class="stat"><span>Volume 24h</span><strong>${fmt(vol24)}</strong></div>`:""}
        ${vol1h?`<div class="stat"><span>Volume 1h</span><strong>${fmt(vol1h)}</strong></div>`:""}
      </div>
      ${changesHtml}
    </div>

    <div class="card">
      <div class="card-title">Security</div>
      <div class="strip">${siSell}${siMint}${siFreeze}${siLP}${siLiq}${siConf}</div>
    </div>

    <div class="card">
      <div class="card-title">Sources</div>
      <div>${sourcesHtml}</div>
    </div>

    <div class="footer">
      <a class="btn" href="${dexUrl}" target="_blank" rel="noopener">↗ DexScreener</a>
      <a class="btn" href="https://solscan.io/token/${mint}" target="_blank" rel="noopener">↗ Solscan</a>
      <a class="btn warn" href="https://rugcheck.xyz/tokens/${mint}" target="_blank" rel="noopener">⚠ RugCheck</a>
    </div>
  `

  // ── AI Analysis card
  const aiSection = document.createElement('div')
  aiSection.className = 'card ai-card'
  aiSection.id = 'ai-section'
  if (d.aiSummary) {
    aiSection.innerHTML = `<div class="card-title"><span class="ai-icon">⬡</span> AI Analysis</div><p class="ai-body">${escapeHtml(d.aiSummary)}</p>`
  } else {
    aiSection.innerHTML = `<div class="card-title"><span class="ai-icon">⬡</span> AI Analysis</div><p class="ai-loading">Generating analysis…</p>`
    fetch(`${API}?ca=${ca}&ai=1`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.aiSummary) {
          const p = aiSection.querySelector('.ai-loading, .ai-body')
          if (p) { p.className = 'ai-body'; p.textContent = data.aiSummary }
        } else {
          const p = aiSection.querySelector('.ai-loading')
          if (p) { p.className = 'ai-body'; p.style.animation = 'none'; p.style.color = '#444'; p.textContent = 'AI analysis unavailable for this token.' }
        }
      })
      .catch(() => {
        const p = aiSection.querySelector('.ai-loading')
        if (p) { p.className = 'ai-body'; p.style.animation = 'none'; p.style.color = '#444'; p.textContent = 'AI analysis unavailable for this token.' }
      })
  }
  const firstCard = wrap.querySelector('.card')
  if (firstCard) { wrap.insertBefore(aiSection, firstCard) } else { wrap.appendChild(aiSection) }

  // ── Flags card
  const flagsSection = document.createElement('div')
  flagsSection.className = 'card'
  flagsSection.innerHTML = `<div class="card-title">Flags</div><div class="flag-list">${noFlags}</div>`
  const secCard = wrap.querySelector('.card:nth-child(3)')
  if (secCard) { secCard.after(flagsSection) } else { wrap.insertBefore(flagsSection, wrap.querySelector('.footer')) }

  // ── On-Chain Data
  const onchainRows = [
    d.holders         != null && ['Holders',      d.holders.toLocaleString()],
    d.marketCap       != null && ['Market Cap',    fmt(d.marketCap)],
    d.liquidity       != null && ['Liquidity',     fmt(d.liquidity)],
    d.volume24h       != null && ['Volume 24h',    fmt(d.volume24h)],
    d.solscanTrades24h  != null && ['Trades 24h',  d.solscanTrades24h.toLocaleString()],
    d.solscanTraders24h != null && ['Traders 24h', d.solscanTraders24h.toLocaleString()],
    d.solscanTokenAgeHours != null && ['Token Age', formatAge(d.solscanTokenAgeHours)],
    d.priceChange1h   != null && ['Chg 1h',  (d.priceChange1h  >= 0 ? '+' : '') + d.priceChange1h.toFixed(1)  + '%'],
    d.priceChange24h  != null && ['Chg 24h', (d.priceChange24h >= 0 ? '+' : '') + d.priceChange24h.toFixed(1) + '%'],
  ].filter(Boolean)

  if (onchainRows.length > 0) {
    const ocCard = document.createElement('div')
    ocCard.className = 'card'
    ocCard.innerHTML = `
      <div class="card-title">On-Chain Data</div>
      <div class="oc-grid">
        ${onchainRows.map(([label, val]) => `
          <div class="oc-item">
            <span class="oc-label">${label}</span>
            <strong class="oc-val">${val}</strong>
          </div>`).join('')}
      </div>`
    wrap.insertBefore(ocCard, wrap.querySelector('.footer'))
  }

  // ── Creator
  if (d.tokenCreator) {
    const creatorCard = document.createElement('div')
    creatorCard.className = 'card'
    const solscanUrl = `https://solscan.io/account/${d.tokenCreator}`
    creatorCard.innerHTML = `
      <div class="card-title">Token Creator</div>
      <a href="${solscanUrl}" target="_blank" rel="noopener noreferrer" class="creator-link">
        <span class="creator-addr">${d.tokenCreator.slice(0,8)}…${d.tokenCreator.slice(-8)}</span>
        <span class="creator-ext">↗ Solscan</span>
      </a>`
    wrap.insertBefore(creatorCard, wrap.querySelector('.footer'))
  }

  // ── Layers / Trust par Source
  const SOURCE_LABELS = {
    dexscreener: 'DexScreener', rugcheck: 'RugCheck', goplus: 'GoPlus',
    helius: 'Helius', solscan: 'Solscan', chart: 'Chart'
  }

  if (d.layers) {
    const layerEntries = Object.entries(d.layers).filter(([src]) => src !== 'crossvalidation')
    if (layerEntries.length > 0) {
      const layersCard = document.createElement('div')
      layersCard.className = 'card'
      const rows = layerEntries.map(([src, l]) => {
        const pct = Math.round(l.trust * 100)
        const colorCls = !l.available ? 'layer-na' : pct >= 75 ? 'layer-ok' : pct >= 40 ? 'layer-warn' : 'layer-bad'
        const label = SOURCE_LABELS[src] || src
        if (!l.available) {
          return `<div class="layer-row">
            <span class="layer-name">${label}</span>
            <span class="layer-unavail">Unavailable</span>
          </div>`
        }
        return `<div class="layer-row">
          <span class="layer-name">${label}</span>
          <div class="layer-bar-wrap">
            <div class="layer-bar ${colorCls}" style="width:0%" data-w="${pct}"></div>
          </div>
          <span class="layer-pct ${colorCls}">${pct}%</span>
        </div>`
      }).join('')
      layersCard.innerHTML = `<div class="card-title">Trust par Source</div>${rows}`
      wrap.insertBefore(layersCard, wrap.querySelector('.footer'))

      requestAnimationFrame(() => {
        layersCard.querySelectorAll('.layer-bar[data-w]').forEach(bar => {
          setTimeout(() => { bar.style.width = bar.dataset.w + '%' }, 300)
        })
      })
    }
  }

  const logoColors={safe:'#00c890',caution:'#c8a800',danger:'#cc5555',rug:'#cc3344'}
  const logoGlow={safe:'rgba(0,229,176,.4)',caution:'rgba(245,208,0,.35)',danger:'rgba(255,95,95,.4)',rug:'rgba(255,34,68,.5)'}
  const logoEl=document.querySelector('.logo')
  if(logoEl){logoEl.style.color=logoColors[rc]||'#444';logoEl.style.textShadow=`0 0 10px ${logoGlow[rc]||'transparent'}`}

  setTimeout(()=>{
    const b=document.getElementById("sbarf")
    if(b)b.style.width=barW+"%"
  },300)
}
