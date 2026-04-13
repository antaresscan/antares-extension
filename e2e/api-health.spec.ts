import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('API /api/health', () => {
  test('returns 200 with status ok', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    expect(r.ok()).toBeTruthy();
    const b = await r.json();
    expect(b.status).toBe('ok');
  });

  test('returns version string', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    const b = await r.json();
    expect(b.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('returns a timestamp', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    const b = await r.json();
    expect(typeof b.timestamp).toBe('number');
    expect(b.timestamp).toBeGreaterThan(0);
  });

  test('has CORS headers', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    expect(r.headers()['access-control-allow-origin']).toBeDefined();
  });

  test('responds under 2 seconds', async ({ request }) => {
    const start = Date.now();
    await request.get(`${BASE}/api/health`);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('returns JSON content-type', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    expect(r.headers()['content-type']).toContain('application/json');
  });
});
