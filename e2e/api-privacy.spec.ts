import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('/api/privacy Endpoint', () => {
  test('returns 200 status', async ({ request }) => {
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

  test('contains required privacy sections', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body).toContain('What data we collect');
    expect(body).toContain('How we use data');
    expect(body).toContain('Third-party services');
    expect(body).toContain('Data storage');
    expect(body).toContain('Contact');
  });

  test('explicitly states no personal data collection', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    // Should mention they do NOT collect personal info
    expect(body.toLowerCase()).toContain('do not');
  });

  test('mentions blockchain data only', async ({ request }) => {
    const r = await request.get(`${BASE}/api/privacy`);
    const body = await r.text();
    expect(body).toContain('Solana token contract addresses');
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
