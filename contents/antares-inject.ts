import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API           = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX     = "antares_scan_"
const CACHE_TTL     = 90_000

const RISK_COLOR: Record<string,string> = {
  SAFE:"#00e5b0", CAUTION:"#f5d000", DANGER:"#ff5f5f", RUG:"#ff2244"
}
const RISK_RGBA: Record<string,string> = {
  SAFE:"0,229,176", CAUTION:"245,208,0", DANGER:"255,95,95", RUG:"255,34,68"
}
const RISK_LABEL: Record<string,string> = {
  SAFE:"SAFE", CAUTION:"CAUTION", DANGER:"DANGER", RUG:"RUG PULL"
}

const SOL_ADDR    = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
const WALKER_MAX  = 500
const IGNORE = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "TokenzQdBNbequAOoiqaLs8AA6CRCmvsembyniztzCFm",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
])

// ── cache ──────────────────────────────────────────────────────────────────
const cache = new Map<string,{data:any;ts:number}>()
;(function hydrateLS(){
  try {
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i)!; if(!k.startsWith(LS_PREFIX)) continue
      const raw=localStorage.getItem(k); if(!raw) continue
      const p=JSON.parse(raw); if(!p?.data||!p?.ts) continue
      if(Date.now()-p.ts>CACHE_TTL){localStorage.removeItem(k);continue}
      cache.set(k.slice(LS_PREFIX.length),{data:p.data,ts:p.ts})
    }
  }catch(_){}
})()
function getCached(ca:string){const e=cache.get(ca);if(!e)return null;if(Date.now()-e.ts>CACHE_TTL){cache.delete(ca);return null}return e.data}
function saveLS(ca:string,data:any){try{localStorage.setItem(LS_PREFIX+ca,JSON.stringify({data,ts:Date.now()}))}catch(_){}}

// ── helpers ────────────────────────────────────────────────────────────────
function fmt(n:number):string{
  if(n>=1e9)return`$${(n/1e9).toFixed(2)}B`
  if(n>=1e6)return`$${(n/1e6).toFixed(2)}M`
  if(n>=1e3)return`$${(n/1e3).toFixed(1)}K`
  return`$${n.toFixed(0)}`
}
function isValid(a:string):boolean{
  if(a.length<32||a.length>44)return false
  if(IGNORE.has(a))return false
  if(/^[A-Z]+$/.test(a)||/^[0-9]+$/.test(a))return false
  return true
}

// ── CSS (exact copy from demo, self-contained inside shadow root) ───────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap');

*{margin:0;padding:0;box-sizing:border-box}

:host{
  all:initial;
  position:fixed;
  bottom:20px;
  right:20px;
  z-index:2147483647;
  display:block;
  width:280px;
  font-family:'IBM Plex Mono',ui-monospace,'Cascadia Code',Menlo,Consolas,monospace;
  font-size:13px;
  color:#d8d8d8;
  pointer-events:auto;
}

.box{
  width:280px;
  background:#141417;
  border:1px solid #1f1f22;
  padding:0;
  position:relative;
  overflow:hidden;
  transition:border-color .25s,box-shadow .25s;
  opacity:0;
  transform:translateY(18px);
  transition:opacity .25s,transform .25s,border-color .25s,box-shadow .25s;
}
.box.show{
  animation:appear .45s cubic-bezier(.22,1,.36,1) both;
}
@keyframes appear{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
.box:hover{border-color:#2a2a2f;box-shadow:0 6px 30px rgba(0,0,0,.5)}

.bline{position:absolute;top:0;left:0;right:0;height:3px;z-index:2}
.inner{padding:16px}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.brand{font-size:9px;letter-spacing:.3em;color:#3a3a3f;text-transform:uppercase;font-family:'IBM Plex Mono',ui-monospace,monospace}
.x{color:#2e2e33;cursor:pointer;font-size:16px;line-height:1;transition:color .15s,transform .15s;background:none;border:none;padding:0}
.x:hover{color:#d8d8d8;transform:rotate(90deg)}

.risk{
  font-family:'Bebas Neue','Arial Black',Impact,sans-serif;
  font-weight:400;font-size:36px;line-height:1;
  letter-spacing:.04em;margin-bottom:5px;
}

.score-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.score{font-size:11px;color:#4a4a50}
.score strong{color:#aaa}
.mcap{font-size:11px;color:#383840}

.bar{height:3px;background:#1c1c1f;margin-bottom:14px;overflow:hidden}
.bar-f{height:100%;width:0%;transition:width 1.1s cubic-bezier(.22,1,.36,1)}

.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:12px}
.meta div{padding:7px 9px;background:#111114;border:1px solid #1c1c1f;border-radius:2px}
.meta span{display:block;font-size:9px;color:#3a3a3f;letter-spacing:.1em;text-transform:uppercase;margin-bottom:2px}
.meta strong{font-size:12px;color:#bbb}

.flags-wrap{margin-bottom:12px}
.flag{font-size:11px;color:#505058;padding:4px 0 4px 10px;border-left:2px solid;margin-top:3px;transition:color .15s,padding-left .15s}
.flag:hover{color:#bbb;padding-left:14px}

.toggle{
  display:block;width:100%;padding:8px 16px;background:transparent;
  border:none;border-top:1px solid #1c1c1f;
  font:600 9px/1 'IBM Plex Mono',ui-monospace,monospace;
  letter-spacing:.2em;color:#383840;text-transform:uppercase;
  cursor:pointer;transition:color .15s,background .15s;text-align:left;
}
.toggle:hover{color:#bbb;background:#111114}

.extra{display:none;padding:2px 16px 12px}
.extra.open{display:block;animation:fadein .2s ease}
@keyframes fadein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.extra-row{display:flex;justify-content:space-between;font-size:10px;color:#3a3a3f;padding:4px 0;border-bottom:1px solid #171719}
.extra-row span:last-child{color:#777}

.actions{display:flex;gap:10px;padding:10px 16px;border-top:1px solid #1c1c1f;background:#111114}
.actions a{font-size:10px;color:#3a3a3f;text-decoration:none;letter-spacing:.05em;text-transform:uppercase;transition:color .15s}
.actions a:hover{color:#d8d8d8}

.scanning{display:flex;align-items:center;gap:8px;color:#4a4a50;font-size:12px;padding:4px 0}
.dot{width:7px;height:7px;border-radius:50%;background:#3a3a3f;display:inline-block;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.15}}
@keyframes rugline{0%,100%{opacity:1}50%{opacity:.4}}
`

// ── shadow host ────────────────────────────────────────────────────────────
let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let boxEl: HTMLDivElement | null = null
let hideTO: ReturnType<typeof setTimeout> | null = null
let lastCA = "", dismissed = false, inFlight = false

function ensureShadow(){
  if(host && document.body.contains(host)) return
  host = document.createElement("span")
  host.id = "_ant_host"
  Object.assign(host.style,{
    position:"fixed",bottom:"20px",right:"20px",
    zIndex:"2147483647",display:"block",
    width:"280px",pointerEvents:"auto",
    all:"initial"
  })
  shadow = host.attachShadow({mode:"open"})
  const style = document.createElement("style")
  style.textContent = CSS
  shadow.appendChild(style)
  boxEl = document.createElement("div")
  boxEl.className = "box"
  shadow.appendChild(boxEl)
  document.body.appendChild(host)
}

function showBox(){
  ensureShadow()
  if(hideTO){clearTimeout(hideTO);hideTO=null}
  boxEl!.style.opacity="0"
  boxEl!.style.transform="translateY(18px)"
  boxEl!.style.display="block"
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    boxEl!.classList.add("show")
    boxEl!.style.opacity="1"
    boxEl!.style.transform="translateY(0)"
  }))
}

function hideBox(){
  if(!boxEl)return
  boxEl.style.opacity="0"
  boxEl.style.transform="translateY(18px)"
  if(hideTO)clearTimeout(hideTO)
  hideTO=setTimeout(()=>{
    if(boxEl){boxEl.style.display="none";boxEl.classList.remove("show")}
  },250)
}

function resetState(){lastCA="";dismissed=false;inFlight=false;hideBox()}

function wire(){
  if(!shadow)return
  const cl=shadow.getElementById("_ac")
  const tg=shadow.getElementById("_at")
  const ex=shadow.getElementById("_ae")
  if(cl) (cl as HTMLElement).onclick=()=>{dismissed=true;hideBox()}
  if(tg&&ex){
    (tg as HTMLElement).onclick=()=>{
      const open=ex.classList.toggle("open")
      tg.textContent=open?"\u25be Source details":"\u25b8 Source details"
    }
  }
}

function applyRisk(risk:string){
  if(!boxEl)return
  const rgba=RISK_RGBA[risk]||"107,114,128"
  boxEl.style.borderColor=risk==="RUG"?"#2a1519":"#1f1f22"
  boxEl.style.boxShadow=`0 6px 30px rgba(${rgba},.04)`
}

// ── build HTML ─────────────────────────────────────────────────────────────
function buildResult(data:any,ca:string):string{
  const color = RISK_COLOR[data.risk]||"#6b7280"
  const rgba  = RISK_RGBA[data.risk]||"107,114,128"
  const label = RISK_LABEL[data.risk]||data.risk
  const mint  = data.resolvedMint||ca

  const mc      = data.pair?.marketCap||data.pair?.fdv
  const liq     = data.pair?.liquidity?.usd
  const holders = data.pair?.holders
  const conf    = typeof data.confidence==="number"?data.confidence:null
  const barW    = Math.min((data.score||0)/10,100)

  const metaCells=[
    mc      ?`<div><span>Market Cap</span><strong>${fmt(mc)}</strong></div>`:"",
    liq     ?`<div><span>Liquidity</span><strong>${fmt(liq)}</strong></div>`:"",
    holders ?`<div><span>Holders</span><strong>${(holders as number).toLocaleString()}</strong></div>`:"",
    conf!==null?`<div><span>Confidence</span><strong>${conf}%</strong></div>`:"",
  ].filter(Boolean).join("")

  const flags=(data.flags as any[]||[])
    .filter(f=>{const l=(f.label||f) as string;return !l.toLowerCase().includes("unavailable")&&f.severity!=="bonus"})
    .slice(0,4)
    .map(f=>`<div class="flag" style="border-color:rgba(${rgba},.22)">${f.label||f}</div>`)
    .join("")

  const srcRows=(data.sources_used as string[]||["DexScreener","RugCheck","GoPlus","Helius RPC"])
    .map(s=>`<div class="extra-row"><span>${s}</span><span>\u2713 Used</span></div>`).join("")

  const dexLink=data.pair?.url
    ?`<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">\u2197 DexScreener</a>`:""
  const fullLink=`<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer">\u2197 Full Analysis</a>`

  const isRug=data.risk==="RUG"
  const bline=isRug?`background:${color};animation:rugline 2s ease infinite`:`background:${color}`

  return `
<div class="bline" style="${bline}"></div>
<div class="inner">
  <div class="head">
    <span class="brand">ANTARES</span>
    <button class="x" id="_ac">\u00d7</button>
  </div>
  <div class="risk" style="color:${color}">${label}</div>
  <div class="score-row">
    <span class="score">Score <strong>${data.score}</strong> / 1000</span>
    <span class="mcap">${mc?fmt(mc):""}</span>
  </div>
  <div class="bar"><div class="bar-f" style="background:${color};width:${barW}%"></div></div>
  ${metaCells?`<div class="meta">${metaCells}</div>`:""}
  ${flags?`<div class="flags-wrap">${flags}</div>`:""}
</div>
<button class="toggle" id="_at">\u25b8 Source details</button>
<div class="extra" id="_ae">${srcRows}</div>
<div class="actions">${dexLink}${fullLink}</div>
`}

function buildScanning():string{
  return `
<div class="bline" style="background:#3a3a3f"></div>
<div class="inner">
  <div class="head">
    <span class="brand">ANTARES</span>
    <button class="x" id="_ac">\u00d7</button>
  </div>
  <div class="scanning"><span class="dot"></span>Scanning\u2026</div>
</div>`
}

function buildError():string{
  return `
<div class="bline" style="background:#ff5f5f"></div>
<div class="inner">
  <div class="head">
    <span class="brand">ANTARES</span>
    <button class="x" id="_ac">\u00d7</button>
  </div>
  <div style="color:#ff5f5f;font-size:12px;padding:4px 0">API Error \u2014 retry later</div>
</div>`
}

// ── scan ───────────────────────────────────────────────────────────────────
async function scan(ca:string){
  if(!ca)return
  if(ca===lastCA&&boxEl&&boxEl.style.display!=="none")return
  if(dismissed&&ca===lastCA)return
  if(inFlight)return
  if(ca!==lastCA){dismissed=false;lastCA=ca}

  const cached=getCached(ca)
  if(cached){
    ensureShadow();applyRisk(cached.risk)
    boxEl!.innerHTML=buildResult(cached,ca)
    showBox();wire();return
  }

  inFlight=true
  ensureShadow()
  boxEl!.innerHTML=buildScanning()
  showBox()
  ;(shadow!.getElementById("_ac") as HTMLElement).onclick=()=>{dismissed=true;hideBox()}

  try{
    const res=await fetch(`${API}?ca=${ca}`)
    if(!res.ok)throw new Error(String(res.status))
    const data=await res.json()
    if(lastCA!==ca){inFlight=false;return}
    cache.set(ca,{data,ts:Date.now()});saveLS(ca,data)
    applyRisk(data.risk)
    boxEl!.innerHTML=buildResult(data,ca)
    wire()
  }catch{
    if(lastCA!==ca){inFlight=false;return}
    boxEl!.innerHTML=buildError()
    ;(shadow!.getElementById("_ac") as HTMLElement).onclick=()=>{dismissed=true;hideBox()}
  }
  inFlight=false
}

// ── address detection ──────────────────────────────────────────────────────
function findBestAddress():string{
  if(window.location.hostname.includes("photon")&&!window.location.pathname.includes("/lp/"))return ""
  const scores=new Map<string,number>()
  const url=window.location.href
  const add=(a:string,pts:number)=>{if(!isValid(a))return;scores.set(a,(scores.get(a)||0)+pts)}
  for(const el of document.querySelectorAll("[data-address],[data-token],[data-mint],[data-ca],[data-contract],[data-token-address],[data-mint-address]")){
    for(const attr of ["data-address","data-token","data-mint","data-ca","data-contract","data-token-address","data-mint-address"]){
      for(const m of ((el.getAttribute(attr)||"" ).match(SOL_ADDR)||[]))add(m,200)
    }
  }
  for(const a of document.querySelectorAll("a[href]")){
    const h=a.getAttribute("href")||""
    if(/solscan\.io\/token|solscan\.io\/address|explorer\.solana\.com\/address|solana\.fm\/address/.test(h)){
      for(const m of (h.match(SOL_ADDR)||[]))add(m,180)
    }
  }
  for(const m of (url.match(SOL_ADDR)||[]))add(m,60)
  if(scores.size===0){
    const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null)
    let node:Node|null,c=0
    while((node=w.nextNode())&&c<WALKER_MAX){
      c++;const t=(node.textContent||"").trim()
      if(t.length>=32&&t.length<=50)for(const m of (t.match(SOL_ADDR)||[]))add(m,120)
    }
  }
  if(scores.size===0)return ""
  for(const [a,s] of scores){
    if(a.endsWith("pump"))scores.set(a,s+100)
    if(/[A-Z]/.test(a)&&/[a-z]/.test(a))scores.set(a,(scores.get(a)||0)+30)
  }
  return [...scores.entries()].sort((a,b)=>b[1]-a[1])[0][0]
}

// ── poll & nav ─────────────────────────────────────────────────────────────
function poll(){const ca=findBestAddress();if(ca)scan(ca)}
poll();setTimeout(poll,2000)

const onNav=()=>{resetState();setTimeout(poll,400);setTimeout(poll,2000)}
let lastUrl=location.href
new MutationObserver(()=>{if(location.href!==lastUrl){lastUrl=location.href;onNav()}})
  .observe(document.documentElement,{childList:true,subtree:true})
const _p=history.pushState.bind(history)
const _r=history.replaceState.bind(history)
history.pushState=(...a)=>{_p(...a);onNav()}
history.replaceState=(...a)=>{_r(...a);onNav()}
window.addEventListener("popstate",onNav)
