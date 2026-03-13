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

// ── CSS (exact match overlay-1 reference design) ───────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600&display=swap');

:host{all:initial}

*{box-sizing:border-box;margin:0;padding:0}

:root{
  --c-safe:#00e5b0;
  --c-caution:#f5d000;
  --c-danger:#ff5f5f;
  --c-rug:#ff2244;
}

#antares-box{
  position:fixed;
  bottom:20px;right:20px;
  z-index:2147483647;
  width:280px;
  background:#141417;
  border:1px solid #1f1f22;
  padding:0;
  overflow:hidden;
  font-family:'IBM Plex Mono',monospace;
  font-size:13px;
  color:#d8d8d8;
  display:none;
  transition:border-color .25s,box-shadow .25s,opacity .25s,transform .25s;
  opacity:0;
  transform:translateY(18px);
}
#antares-box:hover{border-color:#2a2a2f;box-shadow:0 6px 30px rgba(0,0,0,.5)}

/* top colour line */
#antares-box .bline{position:absolute;top:0;left:0;right:0;height:3px;z-index:2}

/* inner */
#antares-box .inner{padding:16px}

/* head */
#antares-box .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
#antares-box .brand{font-size:9px;letter-spacing:.3em;color:#3a3a3f;text-transform:uppercase}
#antares-box .x{color:#2e2e33;cursor:pointer;font-size:16px;line-height:1;transition:color .15s,transform .15s}
#antares-box .x:hover{color:#d8d8d8;transform:rotate(90deg)}

/* glitch on brand */
#antares-box .glitch{position:relative;display:inline-block;cursor:default;user-select:none}
#antares-box .glitch::before,#antares-box .glitch::after{
  content:attr(data-text);position:absolute;top:0;left:0;
  width:100%;overflow:hidden;opacity:0;pointer-events:none
}
#antares-box .glitch::before{color:#ff006e;clip-path:polygon(0 20%,100% 20%,100% 40%,0 40%)}
#antares-box .glitch::after{color:#00e5b0;clip-path:polygon(0 55%,100% 55%,100% 75%,0 75%)}
#antares-box .glitch:hover::before{animation:gl-a .45s steps(2,end) infinite}
#antares-box .glitch:hover::after {animation:gl-b .45s steps(2,end) infinite}
@keyframes gl-a{
  0%  {transform:translate(-3px,0);opacity:.75}
  25% {transform:translate( 3px,0);opacity:.75}
  50% {transform:translate(-2px,0);opacity:.75;clip-path:polygon(0 5%,100% 5%,100% 25%,0 25%)}
  75% {transform:translate( 2px,0);opacity:.75}
  100%{transform:translate(-3px,0);opacity:0}
}
@keyframes gl-b{
  0%  {transform:translate( 3px,0);opacity:.55}
  33% {transform:translate(-3px,0);opacity:.55;clip-path:polygon(0 60%,100% 60%,100% 80%,0 80%)}
  66% {transform:translate( 2px,0);opacity:.55}
  100%{transform:translate( 3px,0);opacity:0}
}

/* verdict */
#antares-box .risk{font:400 36px/1 'Bebas Neue',sans-serif;letter-spacing:.04em;margin-bottom:5px}

/* score row */
#antares-box .score-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
#antares-box .score{font-size:11px;color:#4a4a50}
#antares-box .score strong{color:#aaa}
#antares-box .mcap{font-size:11px;color:#383840}

/* bar */
#antares-box .bar{height:3px;background:#1c1c1f;margin-bottom:14px;overflow:hidden}
#antares-box .bar-f{height:100%;width:0%;transition:width 1.1s cubic-bezier(.22,1,.36,1)}

/* meta grid */
#antares-box .meta{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:12px}
#antares-box .meta div{padding:7px 9px;background:#111114;border:1px solid #1c1c1f;border-radius:2px}
#antares-box .meta span{display:block;font-size:9px;color:#3a3a3f;letter-spacing:.1em;text-transform:uppercase;margin-bottom:2px}
#antares-box .meta strong{font-size:12px;color:#bbb}

/* flags */
#antares-box .flags-wrap{margin-bottom:12px}
#antares-box .flag{font-size:11px;color:#505058;padding:4px 0 4px 10px;border-left:2px solid;margin-top:3px;transition:color .15s,padding-left .15s}
#antares-box .flag:hover{color:#bbb;padding-left:14px}

/* actions */
#antares-box .actions{display:flex;gap:10px;padding:10px 16px;border-top:1px solid #1c1c1f;background:#111114}
#antares-box .actions a{font-size:10px;color:#3a3a3f;text-decoration:none;letter-spacing:.05em;text-transform:uppercase;transition:color .15s}
#antares-box .actions a:hover{color:#d8d8d8}
#antares-box .actions a.primary{margin-left:auto}

/* ── colour variants ── */
#antares-box.safe  .bline{background:var(--c-safe)}
#antares-box.safe  .risk {color:var(--c-safe)}
#antares-box.safe  .bar-f{background:var(--c-safe)}
#antares-box.safe  .flag {border-color:rgba(0,229,176,.2)}
#antares-box.safe:hover  {box-shadow:0 6px 30px rgba(0,229,176,.04)}

#antares-box.caution .bline{background:var(--c-caution)}
#antares-box.caution .risk {color:var(--c-caution)}
#antares-box.caution .bar-f{background:var(--c-caution)}
#antares-box.caution .flag {border-color:rgba(245,208,0,.18)}

#antares-box.danger .bline{background:var(--c-danger)}
#antares-box.danger .risk {color:var(--c-danger)}
#antares-box.danger .bar-f{background:var(--c-danger)}
#antares-box.danger .flag {border-color:rgba(255,95,95,.18)}

#antares-box.rug{border-color:#2a1519}
#antares-box.rug .bline{background:var(--c-rug);animation:rugline 2s ease infinite}
@keyframes rugline{0%,100%{opacity:1}50%{opacity:.4}}
#antares-box.rug .risk {color:var(--c-rug)}
#antares-box.rug .bar-f{background:var(--c-rug)}
#antares-box.rug .flag {border-color:rgba(255,34,68,.18)}
#antares-box.rug:hover {box-shadow:0 6px 30px rgba(255,34,68,.06),0 0 0 1px rgba(255,34,68,.08)}

/* scanning */
@keyframes ant-pulse{0%,100%{opacity:1}50%{opacity:.15}}
#antares-box .scanning{display:flex;align-items:center;gap:8px;color:#444;font-size:12px;padding:6px 0}
#antares-box .dot{width:6px;height:6px;border-radius:50%;background:#555;display:inline-block;animation:ant-pulse 1.2s infinite}

/* appear */
@keyframes appear{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
`
