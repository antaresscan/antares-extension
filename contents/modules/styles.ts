// Bundle the icon as a base64 data URI at build time so it's available
// inside the shadow DOM without a chrome.runtime.getURL() round-trip.
// Uses the root icon.png (same file the deployed demo loads) — kept
// in sync with the user-approved tier-badge-final.html visual.
import iconDataUrl from "data-base64:~icon.png"

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

/* Watermark — logo behind the overlay content. Same on every overlay
   regardless of tier. Anchored at FIXED pixel position from the top
   (NOT a percentage) so opening a panel (Critical Flags / AI Summary
   / Full Analysis) which grows the box height doesn't visually shift
   the watermark. The 77px lands the centre right around the verdict
   line, matching the demo's visual at collapsed overlay height.
   Width still uses a percent (.box width is fixed at 290px) so the
   horizontal centring on the LP LOCK | LIQ divider stays accurate. */
.box::after {
  content: '';
  position: absolute;
  width: 160px; height: 160px;
  left: 77%; top: 77px;
  margin: -80px 0 0 -80px;
  background: url(${iconDataUrl}) no-repeat center / contain;
  opacity: .065;
  pointer-events: none;
  z-index: 0;
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

/* Refresh shimmer: animated gradient slides left-to-right across the
   2px topbar during a silent rescan (login/logout sync, tab focus).
   Each verdict keeps its own colour so the loading state still reads
   as "this token is X". The .refreshing class is added by scanner.ts
   when a silent fetch starts and removed when it lands. */
@keyframes refresh-slide {
  from { background-position: -40% 50%; }
  to   { background-position: 140% 50%; }
}
.box.refreshing .topbar {
  background-size: 40% 100%;
  background-repeat: no-repeat;
  animation: refresh-slide 1.2s linear infinite;
}

/* Completion flash: when fresh data lands after a silent rescan, the
   topbar glows green for ~600ms — punctuates the swap with a clear
   "done, you've got the new tier" beat. Without it the shimmer just
   stops and the new content appears, which doesn't quite "land" — the
   flash gives the swap a satisfying micro-celebration the user can
   actually feel. Scanner.ts adds .flash via classList right after
   buildResultNode renders (silent path only); the animation strips
   itself via animation-fill-mode: backwards default + setTimeout
   removes the class so subsequent flashes can replay. */
@keyframes refresh-flash {
  0%   { box-shadow: 0 0 0 0 rgba(0,229,176,0); }
  40%  { box-shadow: 0 0 14px 2px rgba(0,229,176,.55); }
  100% { box-shadow: 0 0 0 0 rgba(0,229,176,0); }
}
.topbar.flash {
  animation: refresh-flash .6s ease;
}

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
/* ANTARES wordmark — single visual signal for tier in the topbar.
   Gray for Free (default), gold for Pro/Yearly/Lifetime (.pro
   modifier). No transition on the colour — instant swap on tier
   change so it never reads as "the wordmark is animating" during
   a button click. */
.brand {
  font-size: 7px;
  color: #888;
  letter-spacing: .55em;
  text-transform: uppercase;
  font-family: 'IBM Plex Mono', monospace;
}
.brand.pro { color: #f5d000; }
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
  transition: color .15s ease, transform .15s ease, background .15s ease;
  background: none;
  border: none;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1px;
  flex-shrink: 0;
  border-radius: 50%;
}
.x:hover {
  color: #ccc;
  transform: scale(1.15);
  background: rgba(255,255,255,.06);
}
.x:active {
  transform: scale(0.95);
}
.x:focus-visible {
  outline: 1px solid rgba(0,229,176,.5);
  outline-offset: 2px;
}
.quota-badge {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 7px;
  letter-spacing: 0.18em;
  font-weight: 600;
  color: #888;
  padding: 3px 7px;
  border: 1px solid #2a2a2e;
  border-radius: 2px;
  text-transform: uppercase;
  white-space: nowrap;
  text-decoration: none;
  flex-shrink: 0;
  margin: 0 8px;
  transition: color .2s, border-color .2s, background .2s;
}
.quota-badge.warn {
  color: #f5d000;
  border-color: rgba(245, 208, 0, 0.3);
  background: rgba(245, 208, 0, 0.04);
}
.quota-badge.danger {
  color: #ff5f5f;
  border-color: rgba(255, 95, 95, 0.4);
  background: rgba(255, 95, 95, 0.06);
  cursor: pointer;
  letter-spacing: 0.16em;
}
.quota-badge.danger:hover {
  background: rgba(255, 95, 95, 0.12);
  border-color: rgba(255, 95, 95, 0.6);
  color: #ff7777;
}
.quota-badge.pro {
  color: #00e5b0;
  border-color: rgba(0, 229, 176, 0.3);
  background: rgba(0, 229, 176, 0.05);
  letter-spacing: 0.22em;
}
.aff-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px 12px;
  border-top: 1px solid #0e0e10;
  margin-top: 4px;
}
.aff-link {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.16em;
  color: #777;
  text-decoration: none;
  text-transform: uppercase;
  flex: 1;
  text-align: center;
  padding: 6px 8px;
  border: 1px solid #1a1a1e;
  border-radius: 2px;
  transition: color .2s, border-color .2s, background .2s;
}
.aff-link:hover {
  color: #00e5b0;
  border-color: rgba(0, 229, 176, 0.3);
  background: rgba(0, 229, 176, 0.04);
}
.aff-disclosure {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 8px;
  font-weight: 700;
  color: #555;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 2px 5px;
  border: 1px solid #1a1a1e;
  border-radius: 2px;
  cursor: help;
  flex-shrink: 0;
  transition: color .2s, border-color .2s;
}
.aff-disclosure:hover {
  color: #888;
  border-color: #2a2a30;
}
.tk {
  padding: 0 14px;
  margin-top: 6px;
  font-size: 10px;
  color: #999;
  letter-spacing: .06em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'IBM Plex Mono', monospace;
}
.tk b { color: #e6e6e6; font-weight: 600; }

/* FIX: .vb padding-bottom augmenté pour séparer le verdict h1 du score */
.vb { padding: 2px 14px 6px; position: relative; z-index: 1; }
.vb h1 { font-family: 'Bebas Neue', 'Arial Black', sans-serif; font-size: 46px; line-height: .88; font-weight: 400; letter-spacing: .04em; }
.box.safe    .vb h1 { color: #00e5b0; text-shadow: 0 0 30px rgba(0,229,176,.15); }
.box.caution .vb h1 { color: #f5d000; text-shadow: 0 0 30px rgba(245,208,0,.12); }
.box.danger  .vb h1 { color: #ff5f5f; text-shadow: 0 0 30px rgba(255,95,95,.15); }
.box.rug     .vb h1 { color: #ff2244; text-shadow: 0 0 40px rgba(255,34,68,.2); }

/* FIX: .sr margin-top augmenté pour éviter que le score colle au verdict */
.sr { display: flex; align-items: center; gap: 8px; padding: 0 14px; margin-top: 10px; }
.sr .n { font-size: 11px; color: #888; font-weight: 600; font-family: 'IBM Plex Mono', monospace; }
.sr .n b { color: #f0f0f0; }
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
.box.safe    .sum { color: #5fa888; }
.box.caution .sum { color: #c4a838; }
.box.danger  .sum { color: #d47878; }
.box.rug     .sum { color: #ff5566; }
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
  display: block; font-size: 7px; color: #888;
  letter-spacing: .12em; text-transform: uppercase; margin-bottom: 3px;
  font-family: 'IBM Plex Mono', monospace;
}
.si b { font-size: 10px; letter-spacing: .02em; font-weight: 700; font-family: 'IBM Plex Mono', monospace; color: #f0f0f0; }
.si b.y { color: #00e5b0; }
.si b.n { color: #ff5f5f; }
.si b.w { color: #f5d000; }

.fo { display: flex; margin: 8px 14px 10px; gap: 4px; }
.fo a {
  flex: 1; display: block; padding: 8px;
  font-size: 8px; color: #b0b0b0; letter-spacing: .12em;
  text-transform: uppercase; text-decoration: none; text-align: center;
  border: 1px solid #2a2a2e; border-radius: 2px; transition: .2s;
  font-family: 'IBM Plex Mono', monospace;
}
.fo a:hover { color: #f0f0f0; border-color: #555; background: rgba(255,255,255,.04); }
.fo a.warn  { border-color: rgba(255,95,95,.2); color: #cc5555; }
.fo a.warn:hover { border-color: rgba(255,95,95,.4); color: #ff5f5f; background: rgba(255,95,95,.04); }

/* Keyboard focus rings — surfaces interactive elements for users who
   navigate with Tab. focus-visible scopes these to keyboard focus only,
   so mouse clicks don't get a stray outline. */
.fo a:focus-visible,
.fo .ai-btn:focus-visible,
.fo .cf-btn:focus-visible {
  outline: 1px solid rgba(0,229,176,.5);
  outline-offset: 2px;
}
.err-retry:focus-visible,
.qx-cta:focus-visible {
  outline: 1px solid rgba(0,229,176,.6);
  outline-offset: 2px;
}
.aff-link:focus-visible {
  outline: 1px solid rgba(0,229,176,.5);
  outline-offset: 2px;
}
.quota-badge.danger:focus-visible {
  outline: 1px solid rgba(255,95,95,.6);
  outline-offset: 2px;
}

/* Quota-exhausted state — picked from /quota-overlay-demos.html
   "Demo 3 — Premium / calm". Total ~210px tall.
   - Neutral white headline (no all-caps drama)
   - Subtle outline CTA (not a screaming filled button)
   - Price visible so the user knows what they'd pay before clicking
   - Live "resets in Xh Ym" countdown that ticks every 30s */
.qx-vb {
  padding: 16px 14px 6px;
  text-align: center;
}
.qx-vb h1 {
  font-family: 'Bebas Neue', 'Arial Black', sans-serif;
  font-size: 28px; line-height: 1; font-weight: 400; letter-spacing: .04em;
  color: #eaeaea;
  margin-bottom: 4px;
}
.qx-vb .qx-sub {
  font: 400 10px/1.5 'IBM Plex Mono', monospace;
  color: #666; letter-spacing: .04em;
}
.qx-vb .qx-sub .qx-reset-time {
  color: #aaa; font-weight: 600;
}
.qx-counter {
  padding: 6px 14px;
  text-align: center;
  font: 600 10px/1.5 'IBM Plex Mono', monospace;
  color: #7a7a82; letter-spacing: .04em;
}
.qx-counter b {
  color: #aaa; font-weight: 700;
}
.qx-cta {
  display: block; margin: 10px 14px 8px;
  padding: 12px;
  background: transparent;
  color: #00e5b0 !important;
  font: 700 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: .16em; text-transform: uppercase;
  text-decoration: none; text-align: center;
  border: 1px solid rgba(0,229,176,.6);
  border-radius: 2px;
  white-space: nowrap;
  transition: background .2s, border-color .2s, transform .2s;
}
.qx-cta:hover {
  background: rgba(0,229,176,.08);
  border-color: #00e5b0;
  transform: translateY(-1px);
}
/* Trailing margin so the CTA isn't flush against the box edge —
   replaces the dropped .qx-price footer that used to provide spacing. */
.qx-cta { margin-bottom: 14px; }

/* Free-tier locked variant — Critical Flags / Full Analysis / AI Summary
   stay visible (so users see what they're missing) but are dimmed,
   carry a small "PRO" pill, and clicking opens /pricing instead of
   activating the underlying feature. The wider rules above set the
   shape; .locked just shifts colours + state. */
.fo .locked {
  opacity: .55;
  cursor: pointer;
  position: relative;
  padding-right: 30px;
}
.fo .locked:hover { opacity: .85; }
.fo .lock-pill {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  font-size: 6px;
  font-weight: 700;
  letter-spacing: .12em;
  padding: 2px 4px;
  border-radius: 2px;
  /* Gold "PRO" pill on locked buttons — same gold (#f5d000) as the
     brand-logo for visual consistency. */
  background: rgba(245,208,0,.15);
  color: #f5d000;
  border: 1px solid rgba(245,208,0,.4);
  font-family: 'IBM Plex Mono', monospace;
  pointer-events: none;
}
.fo .locked:hover .lock-pill {
  background: rgba(245,208,0,.25);
  color: #ffe34d;
}

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

/* Slow-network reassurance. Hidden for the first 3s of a scan (covers
   typical fast responses). After 3s, fades in so the user knows we're
   still working and the extension isn't stuck. The element gets removed
   with the rest of the skeleton when buildResultNode swaps in, so the
   animation never lingers on success. */
@keyframes skel-slow-fadein {
  from { opacity: 0; }
  to   { opacity: .9; }
}
.skel-slow-hint {
  margin-top: 12px;
  font: 400 8.5px/1.4 'IBM Plex Mono', monospace;
  color: #555;
  letter-spacing: .08em;
  text-align: center;
  text-transform: uppercase;
  opacity: 0;
  animation: skel-slow-fadein .4s ease 3s forwards;
}

/* Error state — rendered when fetchWithRetry exhausts its 3 retries
   (~10.5s) on a non-silent scan. Replaces the silent display-none
   behavior; user gets a clear "what happened" + a one-click retry. */
.err-vb {
  padding: 18px 14px 8px;
  text-align: center;
}
.err-vb .err-icon {
  font-size: 24px;
  color: #f5d000;
  line-height: 1;
  margin-bottom: 8px;
  text-shadow: 0 0 20px rgba(245,208,0,.2);
}
.err-vb h2 {
  font-family: 'Bebas Neue', 'Arial Black', sans-serif;
  font-size: 22px; line-height: 1.05; font-weight: 400;
  letter-spacing: .04em;
  color: #eaeaea;
  margin-bottom: 4px;
}
.err-vb .err-sub {
  font: 400 9.5px/1.5 'IBM Plex Mono', monospace;
  color: #777;
  letter-spacing: .04em;
}
.err-retry {
  display: block;
  margin: 10px 14px 14px;
  padding: 11px;
  width: calc(100% - 28px);
  background: transparent;
  color: #00e5b0;
  font: 700 10px/1 'IBM Plex Mono', monospace;
  letter-spacing: .14em;
  text-transform: uppercase;
  text-align: center;
  border: 1px solid rgba(0,229,176,.5);
  border-radius: 2px;
  cursor: pointer;
  transition: background .2s, border-color .2s, color .2s, transform .15s;
}
.err-retry:hover {
  background: rgba(0,229,176,.08);
  border-color: #00e5b0;
  color: #4ff5cc;
  transform: translateY(-1px);
}
.err-retry:active {
  transform: translateY(0);
}

.sparkline { padding: 4px 14px 0; }
.sparkline svg { display: block; }

/* ── AI Summary button ─────────────────────────────────────────── */
.ai-btn {
  flex: 1; display: block; padding: 8px;
  font-size: 8px; letter-spacing: .12em;
  text-transform: uppercase; text-align: center;
  border-radius: 2px; transition: color .2s, border-color .2s, background .2s;
  font-family: 'IBM Plex Mono', monospace; background: none; cursor: pointer;
  color: #a78bfa;
  border: 1px solid rgba(167,139,250,.25);
  background: rgba(167,139,250,.05);
}
.ai-btn--active {
  color: #a78bfa;
  border-color: rgba(167,139,250,.25);
  background: rgba(167,139,250,.05);
}
.ai-btn:hover,
.ai-btn--active:hover {
  color: #c4b5fd;
  border-color: rgba(167,139,250,.5);
  background: rgba(167,139,250,.1);
}

/* ── AI Summary panel (inline in overlay) ─────────────────────────
   Pure opacity fade — NO translateY. Vertical movement on panel open
   was being read as "the whole overlay is jiggling" by users, even
   though only the panel content shifted 4px. Fade-only feels rock
   solid. */
@keyframes ai-panel-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes ai-panel-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}

.ai-panel {
  display: none;
  margin: 0 14px 2px;
  border: 1px solid rgba(167,139,250,.15);
  border-radius: 3px;
  background: rgba(167,139,250,.04);
  overflow: hidden;
}
.ai-panel.open {
  display: block;
  animation: ai-panel-in .18s ease;
}
/* The .closing class is added by toggleAiSummary just before removing
   .open; both classes are stripped on animationend. Keeping .open during
   close keeps display:block so the animation can actually play. */
.ai-panel.open.closing {
  animation: ai-panel-out .15s ease forwards;
}

.ai-panel-inner {
  padding: 10px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(167,139,250,.3) transparent;
}
.ai-panel-inner::-webkit-scrollbar { width: 4px; }
.ai-panel-inner::-webkit-scrollbar-track { background: transparent; }
.ai-panel-inner::-webkit-scrollbar-thumb {
  background: rgba(167,139,250,.3);
  border-radius: 2px;
}
.ai-panel-inner::-webkit-scrollbar-thumb:hover {
  background: rgba(167,139,250,.5);
}

/* First sentence — acts as a verdict summary */
.ai-panel-verdict {
  font-size: 10px;
  font-weight: 600;
  color: #c4b5fd;
  line-height: 1.5;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: .01em;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(167,139,250,.1);
}

/* Subsequent sentences */
.ai-panel-line {
  font-size: 9.5px;
  color: #8a8aad;
  line-height: 1.55;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: .01em;
}

/* Loading state */
.ai-panel-loading {
  padding: 10px 12px;
  font-size: 9px;
  color: #555;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: .04em;
  text-align: center;
  animation: ant-pulse 1.2s ease-in-out infinite;
}

/* Empty state */
.ai-panel-empty {
  padding: 10px 12px;
  font-size: 9px;
  color: #444;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: .04em;
  text-align: center;
}

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

/* ── Critical Flags button + panel (inline, replaces DexScreener) ─── */
.cf-btn {
  flex: 1; display: block; padding: 8px;
  font-size: 8px; letter-spacing: .12em;
  text-transform: uppercase; text-align: center;
  border-radius: 2px; transition: color .2s, border-color .2s, background .2s;
  font-family: 'IBM Plex Mono', monospace; background: rgba(255,95,95,.05);
  cursor: pointer;
  color: #cc7070;
  border: 1px solid rgba(255,95,95,.25);
}
.cf-btn:hover {
  color: #ff5f5f;
  border-color: rgba(255,95,95,.5);
  background: rgba(255,95,95,.1);
}

/* Pure opacity fade — same reasoning as ai-panel keyframes. */
@keyframes cf-panel-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes cf-panel-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}

.cf-panel {
  display: none;
  margin: 0 14px 2px;
  border: 1px solid rgba(255,95,95,.15);
  border-radius: 3px;
  background: rgba(255,95,95,.04);
  overflow: hidden;
}
.cf-panel.open {
  display: block;
  animation: cf-panel-in .18s ease;
}
.cf-panel.open.closing {
  animation: cf-panel-out .15s ease forwards;
}

.cf-panel-inner {
  padding: 10px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,95,95,.3) transparent;
}
.cf-panel-inner::-webkit-scrollbar { width: 4px; }
.cf-panel-inner::-webkit-scrollbar-track { background: transparent; }
.cf-panel-inner::-webkit-scrollbar-thumb {
  background: rgba(255,95,95,.3);
  border-radius: 2px;
}
.cf-panel-inner::-webkit-scrollbar-thumb:hover {
  background: rgba(255,95,95,.5);
}

.cf-flag {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
}
.cf-flag + .cf-flag {
  border-top: 1px solid rgba(255,255,255,.04);
  padding-top: 8px;
}

.cf-flag-icon {
  width: 14px; height: 14px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 8px; font-weight: 700;
  flex-shrink: 0;
  margin-top: 1px;
}
.cf-flag-icon-r { background: rgba(255,60,80,.15); color: #ff5f5f; }
.cf-flag-icon-y { background: rgba(245,208,0,.12); color: #f5d000; }
.cf-flag-icon-g { background: rgba(136,136,136,.1); color: #888; }

.cf-flag-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.cf-flag-label {
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: .01em;
}
.cf-flag-cr .cf-flag-label { color: #cc7070; }
.cf-flag-wr .cf-flag-label { color: #c8a840; }
.cf-flag-in .cf-flag-label { color: #888; }

.cf-flag-desc {
  font-size: 9px;
  color: #777;
  line-height: 1.5;
  font-style: italic;
  letter-spacing: .01em;
  font-family: 'IBM Plex Mono', monospace;
}

.cf-panel-empty {
  padding: 10px 12px;
  font-size: 9px;
  color: #444;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: .04em;
  text-align: center;
}
`
