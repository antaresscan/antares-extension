const FONT_FACE_CSS = `
@font-face {
  font-family: 'Bebas Neue';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/bebasneue/v16/JTUSjIg69CK48gW7PXoo9Wlhyw.woff2) format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2) format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlBFgg.woff2) format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3pQPwlBFgg.woff2) format('woff2');
}
`

export function injectFonts() {
  if (document.getElementById("antares-fonts")) return
  const style = document.createElement("style")
  style.id = "antares-fonts"
  style.textContent = FONT_FACE_CSS
  document.head.appendChild(style)
}

export const SHADOW_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

@font-face {
  font-family: 'Bebas Neue';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/bebasneue/v16/JTUSjIg69CK48gW7PXoo9Wlhyw.woff2) format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2) format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlBFgg.woff2) format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3pQPwlBFgg.woff2) format('woff2');
}

:host {
  all: initial;
  display: block;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483647;
  font-family: 'IBM Plex Mono', monospace;
  pointer-events: none;
  will-change: transform;
}

.box {
  pointer-events: auto;
  width: 290px;
  overflow: hidden;
  position: relative;
  border: 1px solid rgba(255,255,255,.06);
  box-shadow: 0 40px 80px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.02) inset;
  display: none;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity .2s ease, transform .2s ease;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.4;
  touch-action: none;
}

.box::before {
  content: '';
  position: absolute;
  top: -60px; left: 50%;
  transform: translateX(-50%);
  width: 180px; height: 100px;
  border-radius: 50%;
  filter: blur(60px);
  opacity: .08;
  z-index: 0;
  pointer-events: none;
}

.box.safe   { background: linear-gradient(180deg,#0b100f 0%,#090b0a 100%); }
.box.caution{ background: linear-gradient(180deg,#0e0d0a 0%,#0a0a09 100%); }
.box.danger { background: linear-gradient(180deg,#0e0a0a 0%,#0a0909 100%); }
.box.rug    { background: linear-gradient(180deg,#100809 0%,#0a0808 100%); }

.box.safe::before   { background: #00e5b0; }
.box.caution::before{ background: #f5d000; }
.box.danger::before { background: #ff5f5f; }
.box.rug::before    { background: #ff2244; }

.topbar { height: 2px; }
.box.safe    .topbar { background: linear-gradient(90deg,transparent,#00e5b0,transparent); }
.box.caution .topbar { background: linear-gradient(90deg,transparent,#f5d000,transparent); }
.box.danger  .topbar { background: linear-gradient(90deg,transparent,#ff5f5f,transparent); }
.box.rug     .topbar { background: linear-gradient(90deg,transparent,#ff2244,transparent); }

.hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px 0;
  cursor: grab;
  touch-action: none;
}
.hd:active { cursor: grabbing; }
.hd-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand {
  font-size: 7px;
  color: #555;
  letter-spacing: .55em;
  text-transform: uppercase;
  font-family: 'IBM Plex Mono', monospace;
}
.drag-icon {
  display: flex;
  align-items: center;
  color: #3a3a42;
  transition: color .2s;
  pointer-events: none;
}
.hd:hover .drag-icon { color: #777; }
.stealth-btn {
  color: #3a3a42;
  cursor: pointer;
  transition: color .2s;
  background: none;
  border: none;
  font-size: 11px;
  line-height: 1;
  padding: 0 2px;
}
.stealth-btn:hover { color: #00e5b0; }
.x {
  color: #3a3a42;
  cursor: pointer;
  transition: color .2s;
  background: none;
  border: none;
  width: 13px;
  height: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
}
.x:hover { color: #777; }

.tk {
  padding: 0 14px;
  margin-top: 6px;
  font-size: 10px;
  color: #666;
  letter-spacing: .06em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'IBM Plex Mono', monospace;
}
.tk b { color: #bbb; font-weight: 600; }

.vb { padding: 0 14px 4px; position: relative; z-index: 1; }
.vb h1 { font-family: 'Bebas Neue', 'Arial Black', sans-serif; font-size: 46px; line-height: .88; font-weight: 400; letter-spacing: .04em; }
.box.safe    .vb h1 { color: #00e5b0; text-shadow: 0 0 30px rgba(0,229,176,.15); }
.box.caution .vb h1 { color: #f5d000; text-shadow: 0 0 30px rgba(245,208,0,.12); }
.box.danger  .vb h1 { color: #ff5f5f; text-shadow: 0 0 30px rgba(255,95,95,.15); }
.box.rug     .vb h1 { color: #ff2244; text-shadow: 0 0 40px rgba(255,34,68,.2); }

.sr { display: flex; align-items: center; gap: 8px; padding: 0 14px; }
.sr .n { font-size: 11px; color: #555; font-weight: 600; font-family: 'IBM Plex Mono', monospace; }
.sr .n b { color: #aaa; }
.dots { display: flex; gap: 2px; align-items: center; }
.dt { width: 4px; height: 4px; border-radius: 50%; }
.dt.on  { background: #00e5b0; }
.dt.off { background: #222226; }

.sbar { margin: 6px 14px 0; height: 2px; background: #181818; border-radius: 1px; overflow: hidden; }
.sbar-fill { height: 100%; border-radius: 1px; width: 0%; transition: width 1.1s cubic-bezier(.22,1,.36,1); }
.box.safe    .sbar-fill { background: linear-gradient(90deg,#00e5b055,#00e5b0); }
.box.caution .sbar-fill { background: linear-gradient(90deg,#f5d00044,#f5d000); }
.box.danger  .sbar-fill { background: linear-gradient(90deg,#ff5f5f44,#ff5f5f); }
.box.rug     .sbar-fill { background: linear-gradient(90deg,#ff224444,#ff2244); }

.sum { padding: 8px 14px 0; font-size: 9px; letter-spacing: .04em; font-family: 'IBM Plex Mono', monospace; }
.box.safe    .sum { color: #3a7060; }
.box.caution .sum { color: #8a7820; }
.box.danger  .sum { color: #aa5050; }
.box.rug     .sum { color: #cc3344; }
.ai-sum { padding: 6px 14px 2px; font-size: 9px; color: #8a8aad; line-height: 1.45; letter-spacing: .02em; font-family: 'IBM Plex Mono', monospace; }
.ai-label { font-weight: 700; color: #a78bfa; margin-right: 4px; font-size: 8px; text-transform: uppercase; letter-spacing: .06em; }

.sep { height: 1px; margin: 8px 14px; background: #1a1a1e; }

.fl { padding: 2px 14px 6px; }
.f { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; font-size: 10.5px; line-height: 1.5; font-family: 'IBM Plex Mono', monospace; }
.f + .f { border-top: 1px solid #131316; }
.ic {
  width: 15px; height: 15px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 7.5px; flex-shrink: 0; margin-top: 2px;
}
.ic.r { background: rgba(255,60,80,.1); color: #ff5f5f; }
.ic.y { background: rgba(245,208,0,.08); color: #f5d000; }
.ic.g { background: rgba(0,229,176,.08); color: #00e5b0; }
.f.cr .ft-txt { color: #cc7070; }
.f.wr .ft-txt { color: #c8a840; }
.f.ok .ft-txt { color: #559970; }

.ss {
  display: flex;
  margin: 0 14px;
  background: #0a0a0c;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid #1a1a1e;
}
.si { flex: 1; text-align: center; padding: 7px 2px; position: relative; }
.si + .si::before {
  content: '';
  position: absolute; left: 0; top: 25%; height: 50%; width: 1px;
  background: #1a1a1e;
}
.si span {
  display: block; font-size: 7px; color: #555;
  letter-spacing: .12em; text-transform: uppercase; margin-bottom: 3px;
  font-family: 'IBM Plex Mono', monospace;
}
.si b { font-size: 10px; letter-spacing: .02em; font-weight: 700; font-family: 'IBM Plex Mono', monospace; }
.si b.y { color: #00e5b0; }
.si b.n { color: #ff5f5f; }
.si b.w { color: #f5d000; }

.fo { display: flex; margin: 8px 14px 10px; gap: 4px; }
.fo a {
  flex: 1; display: block; padding: 8px;
  font-size: 8px; color: #888; letter-spacing: .12em;
  text-transform: uppercase; text-decoration: none; text-align: center;
  border: 1px solid #252528; border-radius: 2px; transition: .2s;
  font-family: 'IBM Plex Mono', monospace;
}
.fo a:hover { color: #ccc; border-color: #444; background: rgba(255,255,255,.02); }
.fo a.warn  { border-color: rgba(255,95,95,.2); color: #cc5555; }
.fo a.warn:hover { border-color: rgba(255,95,95,.4); color: #ff5f5f; background: rgba(255,95,95,.04); }

@keyframes ant-pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
.scanning { display:flex; align-items:center; gap:8px; color:#777; font-size:12px; padding:12px 14px; font-family:'IBM Plex Mono',monospace; }
.dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#444; animation:ant-pulse 1.2s infinite; }

.skel { padding: 10px 14px; }
.skel-verdict { width: 120px; height: 38px; background: #1a1a1e; border-radius: 6px; animation: ant-pulse 1.4s ease-in-out infinite; margin-bottom: 10px; }
.skel-bar { width: 100%; height: 2px; background: #1a1a1e; border-radius: 1px; animation: ant-pulse 1.4s ease-in-out infinite .2s; margin-bottom: 10px; }
.skel-line { height: 10px; background: #1a1a1e; border-radius: 3px; animation: ant-pulse 1.4s ease-in-out infinite; margin-bottom: 6px; }
.skel-line:nth-child(3) { width: 90%; animation-delay: .1s; }
.skel-line:nth-child(4) { width: 75%; animation-delay: .2s; }
.skel-line:nth-child(5) { width: 60%; animation-delay: .3s; }

.sparkline { padding: 4px 14px 0; }
.sparkline svg { display: block; }

.ai-btn {
  flex: 1; display: block; padding: 8px;
  font-size: 8px; color: #888; letter-spacing: .12em;
  text-transform: uppercase; text-decoration: none; text-align: center;
  border: 1px solid #252528; border-radius: 2px; transition: .2s;
  font-family: 'IBM Plex Mono', monospace; background: none; cursor: pointer;
}
.ai-btn:hover { color: #ccc; border-color: #444; background: rgba(255,255,255,.02); }

.ai-panel { display: none; padding: 0 14px 6px; }
.ai-panel.open { display: block; }
.ai-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 5px 0; font-size: 9px; font-family: 'IBM Plex Mono', monospace;
  border-bottom: 1px solid #131316; color: #777;
}
.ai-item:last-child { border-bottom: none; }
.ai-sym { color: #bbb; font-weight: 600; }
.ai-risk { font-weight: 700; }
.ai-risk.safe { color: #00e5b0; }
.ai-risk.caution { color: #f5d000; }
.ai-risk.danger { color: #ff5f5f; }
.ai-risk.rug { color: #ff2244; }
.ai-score { color: #555; }
.ai-time { color: #444; font-size: 8px; }
`
