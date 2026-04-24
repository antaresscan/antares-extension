import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

// /api/privacy redirects to /privacy.html (single-source-of-truth privacy
// policy). Playwright's request context follows redirects by default, so
// every assertion here operates against the final landing document.
test.describe('/api/privacy Endpoint', () => {
  test('returns 200 status after redirect', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    expect(r.status()).toBe(200);
  });

  test('returns HTML content-type', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const ct = r.headers()['content-type'] || '';
    expect(ct).toContain('text/html');
  });

  test('contains privacy policy title', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body).toContain('Privacy Policy');
  });

  test('covers every mandatory GDPR / Chrome Web Store section', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    // Each string below corresponds to a section heading we rely on for
    // GDPR compliance and Chrome Web Store listing justification. If a
    // section is renamed, update both the policy and this assertion.
    expect(body).toContain('Data we process');
    expect(body).toContain('Where the Extension injects');
    expect(body).toContain('Third-party processors');
    expect(body).toContain('International transfers');
    expect(body).toContain('Data retention');
    expect(body).toContain('Your rights');
    expect(body).toContain('Contact');
  });

  test('discloses every material processor', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    // Audit caught these as previously missing — ensure they stay disclosed.
    expect(body).toContain('Vercel');
    expect(body).toContain('Upstash');
    expect(body).toContain('Gemini');
    expect(body).toContain('Sentry');
    expect(body).toContain('DexScreener');
    expect(body).toContain('RugCheck');
    expect(body).toContain('GoPlus');
    expect(body).toContain('Helius');
    expect(body).toContain('Solscan');
    expect(body).toContain('GeckoTerminal');
  });

  test('mentions blockchain data only', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body.toLowerCase()).toContain('contract address');
  });

  test('lists the 8 supported injection hosts', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    const hosts = [
      'dexscreener.com',
      'birdeye.so',
      'pump.fun',
      'photon-sol.tinyastro.io',
      'axiom.trade',
      'gmgn.ai',
      'app.telemetry.io',
      'geckoterminal.com',
    ];
    for (const host of hosts) {
      expect(body, `missing host ${host} in privacy policy`).toContain(host);
    }
  });

  test('is valid HTML', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body).toContain('<!DOCTYPE html');
    expect(body).toContain('<html');
    expect(body).toContain('</html>');
  });

  test('has last updated date', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body).toMatch(/Last updated.*\d{4}/);
  });

  test('responds within 3s', async ({ request }) => {
    const start = Date.now();
    await request.get(`${BASE}/api/privacy`);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
