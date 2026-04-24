import type { VercelRequest, VercelResponse } from "@vercel/node";

// /api/privacy → 301 to /privacy.html
//
// The canonical privacy policy lives in privacy.html at the repo root so it
// can be authored and styled like any other static page. This route used to
// serve its own inline HTML, which silently drifted out of sync with the
// canonical copy (e.g. it still listed only 2 permissions after the manifest
// grew to 5, and it never mentioned Gemini or Upstash). Redirecting removes
// the duplication and guarantees every entry point — options page link,
// Chrome Web Store listing, old bookmarks — lands on the same document.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Location", "/privacy.html");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(301).end();
}
