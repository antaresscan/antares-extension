// scripts/generate-overlay-preview.ts
//
// Generates a static HTML page that renders the Antares overlay in every
// state we ship — Free quota at various thresholds, Pro/Lifetime badges,
// the affiliate row, the watchlist button. The user opens the output file
// in a browser to verify visually before merging Pro v1.
//
// Run:    npm run preview
// Output: preview/overlay-states.html
//
// The script uses happy-dom to drive buildResultNode without needing a
// real browser — we only need the rendered HTML, not interactivity.
//
// Watchlist interactive states (idle / watching / limit-reached) cannot be
// rendered statically; they are documented in the manual test plan section
// at the bottom of the output.

// Set the PHOTON_REF env var BEFORE importing the modules — constants.ts
// reads it at module-load time. With this set, the affiliate row will
// render in the preview. Use a bogus handle so the link is obvious in the
// preview but harmless if clicked.
process.env.PLASMO_PUBLIC_PHOTON_REF = "preview-demo-ref";

import { Window } from "happy-dom";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── happy-dom bootstrap ──────────────────────────────────────────────────────

const window = new Window();
const { document } = window;

// Stub the chrome.* APIs the content script imports — buildResultNode itself
// does not call them, but other modules in the import graph do.
const chromeStub = {
  runtime: { sendMessage: () => undefined, lastError: null },
  storage: {
    local: {
      get: (_keys: unknown, cb?: (val: Record<string, unknown>) => void) => {
        if (cb) cb({});
      },
    },
  },
};

// Bridge happy-dom globals onto Node's global before importing the modules
const g = globalThis as unknown as Record<string, unknown>;
g.window = window;
g.document = document;
g.HTMLElement = window.HTMLElement;
g.HTMLDivElement = window.HTMLDivElement;
g.HTMLButtonElement = window.HTMLButtonElement;
g.HTMLAnchorElement = window.HTMLAnchorElement;
g.Node = window.Node;
g.Element = window.Element;
g.DocumentFragment = window.DocumentFragment;
g.chrome = chromeStub;

// ─── Module imports (after globals are wired) ─────────────────────────────────

import { buildResultNode } from "../contents/modules/components";
import { state } from "../contents/modules/state";
import { SHADOW_CSS } from "../contents/modules/styles";
import type { ScanResponseData, QuotaStatus } from "../shared/types";

// ─── Sample data builder ──────────────────────────────────────────────────────

const SAMPLE_CA = "So11111111111111111111111111111111111111112";

function makeData(over: Partial<ScanResponseData> = {}): ScanResponseData {
  return {
    score: 850,
    risk: "SAFE",
    flags: [],
    pair: null,
    resolvedMint: SAMPLE_CA,
    confidence: 92,
    sources_used: ["dexscreener", "rugcheck", "goplus", "helius"],
    holders: 12_400,
    marketCap: 4_200_000,
    priceUsd: 0.0042,
    liquidity: 320_000,
    volume24h: 1_200_000,
    tokenSymbol: "DEMO",
    tokenName: "Demo Token",
    mintAuthority: false,
    freezeAuthority: false,
    lpBurned: true,
    lpLocked: false,
    honeypot: false,
    safeBlocked: false,
    candles: Array.from({ length: 20 }, (_, i) => ({ close: 0.004 + i * 0.0001 })),
    layers: {
      DexScreener: { trust: 1, available: true },
      RugCheck: { trust: 1, available: true },
      GoPlus: { trust: 1, available: true },
      Helius: { trust: 0.9, available: true },
    },
    ...over,
  } as ScanResponseData;
}

const RESET_AT = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate() + 1,
);

function quota(
  tier: QuotaStatus["tier"],
  used: number,
  limit: number,
): QuotaStatus {
  return {
    tier,
    used,
    limit,
    remaining: tier === "free" ? Math.max(0, limit - used) : -1,
    resetAt: tier === "free" ? RESET_AT : 0,
  };
}

// ─── Variants ─────────────────────────────────────────────────────────────────

interface Variant {
  title: string;
  subtitle: string;
  data: ScanResponseData;
}

const variants: Variant[] = [
  {
    title: "Free · normal usage",
    subtitle: "Quota 12/50 — gray badge, watchlist available, no affiliate (CAUTION verdict)",
    data: makeData({
      risk: "CAUTION",
      score: 620,
      _quota: quota("free", 12, 50),
      flags: [
        { label: "Top-10 holders concentration above 50%", severity: "warning", impact: 30 },
      ],
    }),
  },
  {
    title: "Free · approaching limit (warn)",
    subtitle: "Quota 47/50 — yellow badge",
    data: makeData({
      _quota: quota("free", 47, 50),
    }),
  },
  {
    title: "Free · limit reached",
    subtitle: "Quota 50/50 — red 'PRO' link, ready to convert",
    data: makeData({
      _quota: quota("free", 50, 50),
    }),
  },
  {
    title: "Pro · unlimited",
    subtitle: "Green PRO badge, no affiliate row (clean UI as paid benefit)",
    data: makeData({
      _quota: quota("pro", 0, -1),
    }),
  },
  {
    title: "Lifetime · founder",
    subtitle: "Green LIFE badge",
    data: makeData({
      _quota: quota("lifetime", 0, -1),
    }),
  },
  {
    title: "Free · SAFE with affiliate row",
    subtitle: "Free user on a SAFE token — Photon affiliate row at the bottom (PHOTON_REF set)",
    data: makeData({
      _quota: quota("free", 5, 50),
    }),
  },
  {
    title: "Free · DANGER verdict (no affiliate)",
    subtitle: "Affiliate row hidden — we never recommend trading flagged tokens",
    data: makeData({
      risk: "DANGER",
      score: 280,
      _quota: quota("free", 8, 50),
      flags: [
        { label: "LP not burned", severity: "critical", impact: 200 },
        { label: "Mint authority active", severity: "critical", impact: 250 },
      ],
    }),
  },
  {
    title: "Free · RUG verdict",
    subtitle: "Hard kill — score < 350, RUG label, watchlist still available",
    data: makeData({
      risk: "RUG",
      score: 80,
      _quota: quota("free", 30, 50),
      flags: [
        { label: "Honeypot — sells blocked", severity: "critical", impact: 400 },
      ],
    }),
  },
];

// ─── Render each variant ──────────────────────────────────────────────────────

function renderVariant(variant: Variant): string {
  // Each render gets a fresh boxEl — buildResultNode mutates state.boxEl.className.
  // happy-dom's HTMLElement is structurally compatible with lib.dom's
  // HTMLDivElement at runtime; the cast is purely to satisfy TypeScript
  // since the global typings don't unify the two implementations.
  const box = document.createElement("div");
  box.className = "box";
  state.boxEl = box as unknown as HTMLDivElement;

  const node = buildResultNode(variant.data, SAMPLE_CA);
  // Same type-vs-runtime story for appendChild — happy-dom accepts the node,
  // TypeScript complains because lib.dom's Node interface is structurally
  // different. Cast through unknown to bridge.
  (box as unknown as HTMLElement).appendChild(node as unknown as Element);

  return `
    <section class="variant">
      <header class="variant-head">
        <h3>${escapeHtml(variant.title)}</h3>
        <p>${escapeHtml(variant.subtitle)}</p>
      </header>
      <div class="overlay-frame">
        ${(box as unknown as HTMLElement).outerHTML}
      </div>
    </section>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── HTML wrapper ─────────────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Antares overlay preview · Pro v1</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    /* Page chrome — not part of the extension overlay */
    body {
      margin: 0;
      background: #0a0a0c;
      color: #c8c8cc;
      font-family: 'IBM Plex Mono', monospace;
      padding: 40px 20px;
    }
    h1 {
      font: 400 48px/1 'Bebas Neue', sans-serif;
      letter-spacing: 0.04em;
      color: #00e5b0;
      text-align: center;
      margin: 0 0 8px;
    }
    .subtitle {
      text-align: center;
      color: #888;
      font-size: 12px;
      margin-bottom: 8px;
      letter-spacing: 0.06em;
    }
    .meta {
      text-align: center;
      color: #555;
      font-size: 10px;
      letter-spacing: 0.16em;
      margin-bottom: 48px;
      text-transform: uppercase;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(330px, 360px));
      gap: 32px;
      max-width: 1500px;
      margin: 0 auto;
      justify-content: center;
    }
    .variant-head {
      margin-bottom: 14px;
      padding: 0 4px;
    }
    .variant-head h3 {
      font: 600 12px/1.2 'IBM Plex Mono', monospace;
      color: #00e5b0;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin: 0 0 4px;
    }
    .variant-head p {
      font-size: 11px;
      color: #777;
      line-height: 1.5;
      margin: 0;
    }
    .overlay-frame {
      background: #050507;
      padding: 16px;
      border: 1px solid #1a1a1e;
      border-radius: 4px;
    }
    .overlay-frame .box {
      width: 290px;
      margin: 0 auto;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.04);
      position: relative;
    }
    /* Verdict-coloured topbar (matches in-extension styling) */
    .topbar { height: 2px; }
    .box.safe    .topbar { background: linear-gradient(90deg,transparent,#00e5b0,transparent); }
    .box.caution .topbar { background: linear-gradient(90deg,transparent,#f5d000,transparent); }
    .box.danger  .topbar { background: linear-gradient(90deg,transparent,#ff5f5f,transparent); }
    .box.rug     .topbar { background: linear-gradient(90deg,transparent,#ff2244,transparent); }
    /* Verdict-coloured background tint to match the real overlay */
    .box.safe    { background: linear-gradient(180deg,#0b100f 0%,#090b0a 100%); }
    .box.caution { background: linear-gradient(180deg,#0e0d0a 0%,#0a0a09 100%); }
    .box.danger  { background: linear-gradient(180deg,#0e0a0a 0%,#0a0909 100%); }
    .box.rug     { background: linear-gradient(180deg,#100809 0%,#0a0808 100%); }

    .test-plan {
      max-width: 900px;
      margin: 80px auto 40px;
      background: #111114;
      border: 1px solid #1a1a1e;
      padding: 32px;
      border-radius: 4px;
    }
    .test-plan h2 {
      font: 400 28px/1 'Bebas Neue', sans-serif;
      letter-spacing: 0.04em;
      color: #00e5b0;
      margin: 0 0 16px;
    }
    .test-plan ul {
      font-size: 12px;
      line-height: 1.8;
      color: #888;
      padding-left: 20px;
    }
    .test-plan li code {
      background: #0a0a0c;
      color: #00e5b0;
      padding: 1px 5px;
      border-radius: 2px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
    }

    /* ── Antares overlay CSS — pulled from contents/modules/styles.ts ── */
    ${SHADOW_CSS}
  </style>
</head>
<body>
  <h1>Antares Overlay Preview</h1>
  <p class="subtitle">Pro v1 — quota badge, affiliate row, watchlist button</p>
  <p class="meta">${variants.length} static states · regenerate via <code>npm run preview</code></p>

  <div class="grid">
    ${variants.map(renderVariant).join("")}
  </div>

  <div class="test-plan">
    <h2>Manual test plan — interactive states</h2>
    <p style="font-size:12px;color:#888;line-height:1.7;margin-bottom:14px">
      The states above cover everything that's deterministic from <code>buildResultNode</code>.
      Three more behaviours need a real browser load to verify:
    </p>
    <ul>
      <li><strong style="color:#bbb">Watchlist · happy path</strong> — load extension, scan a SAFE token,
          click <code>+ Watch</code> → button flips to <code>✓ Watching</code> + green border, stays disabled.</li>
      <li><strong style="color:#bbb">Watchlist · limit reached</strong> — as Free user with 5 items already
          watched, click <code>+ Watch</code> on a 6th → button shows <code>Limit → PRO</code> + red border;
          subsequent click opens <code>https://antares-website.vercel.app/pricing</code> in a new tab.</li>
      <li><strong style="color:#bbb">Quota cap</strong> — perform 50 scans in &lt; 24h → 51st scan fails
          with HTTP 429, overlay disappears (existing rate-limit-handling path).</li>
      <li><strong style="color:#bbb">Pro tier flip</strong> — <code>SET user:&lt;your-install-id&gt;:tier "pro"</code>
          in Upstash directly, refresh a token page → quota badge becomes <code>PRO</code>, affiliate row hides.</li>
    </ul>
    <p style="font-size:11px;color:#555;margin-top:18px;font-style:italic">
      All deterministic states (above) come from a single <code>buildResultNode()</code> call per variant
      using happy-dom, so any visual regression here will reproduce 1:1 in the live extension.
    </p>
  </div>
</body>
</html>
`;

// ─── Write output ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outDir = resolve(__dirname, "..", "preview");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "overlay-states.html");
writeFileSync(outFile, html, "utf8");

console.log(`✓ Wrote ${outFile}`);
console.log(`  Open the file directly in a browser to verify the ${variants.length} states.`);
