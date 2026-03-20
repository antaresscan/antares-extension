import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html><head><title>Antares Privacy Policy</title></head>
<body style="max-width:700px;margin:40px auto;font-family:system-ui;padding:0 20px">
<h1>Antares Scanner — Privacy Policy</h1>
<p><strong>Last updated:</strong> 2026-03-20</p>
<h2>What data we collect</h2>
<p>Antares collects <strong>only</strong> Solana token contract addresses (public blockchain data) that appear on web pages you visit. We do NOT collect:</p>
<ul>
<li>Personal information (name, email, etc.)</li>
<li>Browsing history</li>
<li>Wallet addresses or private keys</li>
<li>Financial information</li>
<li>Cookies or tracking data</li>
</ul>
<h2>How we use data</h2>
<p>Contract addresses are sent to our API (antares-extension.vercel.app) to perform risk analysis using public blockchain data from DexScreener, RugCheck, GoPlus, Helius, and Solscan. Results are cached temporarily (1–24 hours) and never stored permanently.</p>
<h2>Third-party services</h2>
<p>We query public APIs (DexScreener, RugCheck, GoPlus, Helius, Solscan, GeckoTerminal) with only the contract address. No user data is shared.</p>
<h2>Data storage</h2>
<p>Scan results are cached in Upstash Redis (encrypted, auto-expiring) and locally in your browser via chrome.storage. You can clear local data at any time.</p>
<h2>Contact</h2>
<p>Questions? Open an issue at <a href="https://github.com/COMEALAMAISONGROUPE/antares-extension">github.com/COMEALAMAISONGROUPE/antares-extension</a></p>
</body></html>`);
}
