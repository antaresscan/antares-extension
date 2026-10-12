import type { Page } from '@playwright/test';

// The Pro/Free line is drawn on the server (api/_lib/pro-gate.ts): an anonymous caller of /api/scan receives the Free view (verdict,
// score, the Sell/Mint/Freeze/LP line, market data) and NONE of the analysis. The specs that check the analysis itself (the layers, the
// sources, the text of the flags, the token page) therefore need a Pro caller.
//
// The e2e suite has no account. It asks as a Pro INSTALL: the dev escape hatch the server already has (DEV_PRO_INSTALLS, see
// api/_lib/user.ts), which needs the same random string in two places and nothing else:
//   - the GitHub secret E2E_PRO_INSTALL (what these specs send as X-Antares-Install);
//   - the Vercel variable DEV_PRO_INSTALLS (Preview and Production), listing that same string.
// Without the secret the specs that need the analysis are SKIPPED, with the reason below, and the Free contract is still checked
// (e2e/api-pro-gate.spec.ts).

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

export const PRO_INSTALL = process.env.E2E_PRO_INSTALL ?? '';
/** The same shape the server accepts for an install id (api/_lib/middleware.ts, getInstallId). */
export const HAS_PRO = /^[a-zA-Z0-9_-]{8,128}$/.test(PRO_INSTALL);
export const PRO_HEADERS: Record<string, string> = HAS_PRO ? { 'X-Antares-Install': PRO_INSTALL } : {};
export const SKIP_NO_PRO = 'needs the E2E_PRO_INSTALL secret (and the same value in DEV_PRO_INSTALLS on Vercel): only a Pro caller receives the full analysis';

/**
 * Makes the requests a PAGE sends to the API under test carry the Pro install. Scoped to the API of BASE on purpose: a header set on
 * the whole browser context would also go to Google Fonts and every other third party the page loads.
 */
export async function injectProHeaders(page: Page): Promise<void> {
  if (!HAS_PRO) return;
  await page.route(`${BASE}/api/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-antares-install': PRO_INSTALL } }),
  );
}
