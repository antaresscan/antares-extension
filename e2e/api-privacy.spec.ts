import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

// /api/privacy redirects to /privacy.html (single source of truth).
// Content-level invariants — section names, processor list, supported
// injection hosts — live in __tests__/privacy-html.test.ts so they can
// fail a PR *before* the preview deploys, not after. This e2e suite only
// asserts HTTP-level invariants that depend on the live deployment.
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

  test('returns a well-formed HTML document', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body).toContain('<!DOCTYPE html');
    expect(body).toContain('<html');
    expect(body).toContain('</html>');
  });

  test('contains a privacy policy heading', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body).toContain('Privacy Policy');
  });

  test('responds within 3s', async ({ request }) => {
    const start = Date.now();
    await request.get(`${BASE}/api/privacy`);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
