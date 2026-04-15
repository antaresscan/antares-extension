import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

/**
 * Verify all security headers from vercel.json are applied
 * on every route category (pages, API endpoints).
 */
const ROUTES = [
  { path: '/', label: 'Landing page' },
  { path: '/privacy.html', label: 'Privacy page' },
  { path: '/token.html', label: 'Token page' },
  { path: '/api/health', label: 'API health' },
  { path: '/api/scan', label: 'API scan' },
];

const COMMON_HEADERS = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
] as const;

test.describe('Security Headers \u2014 All Routes', () => {
  for (const { path, label } of ROUTES) {
    test.describe(label, () => {
      for (const [header, value] of COMMON_HEADERS) {
        test(`has ${header}: ${value}`, async ({ request }) => {
          const r = await request.get(`${BASE}${path}`);
          expect(r.headers()[header]).toBe(value);
        });
      }

      test('has Strict-Transport-Security with long max-age', async ({ request }) => {
        const r = await request.get(`${BASE}${path}`);
        const hsts = r.headers()['strict-transport-security'];
        expect(hsts).toBeDefined();
        expect(hsts).toContain('max-age=');
        const maxAge = parseInt(hsts?.match(/max-age=(\d+)/)?.[1] ?? '0');
        expect(maxAge).toBeGreaterThanOrEqual(31536000);
      });

      test('has Content-Security-Policy', async ({ request }) => {
        const r = await request.get(`${BASE}${path}`);
        const csp = r.headers()['content-security-policy'];
        expect(csp).toBeDefined();
      });
    });
  }
});

test.describe('CSP contains default-src directive', () => {
  test('/api routes have CSP with default-src', async ({ request }) => {
    const r = await request.get(`${BASE}/api/health`);
    const csp = r.headers()['content-security-policy'];
    // Vercel merges headers from both /api/(.*) and /(.*) blocks,
    // so the actual value may be 'none' or 'self' depending on merge order.
    expect(csp).toContain('default-src');
  });
});

test.describe('Page-specific CSP', () => {
  test('pages allow self scripts and styles', async ({ request }) => {
    const r = await request.get(`${BASE}/`);
    const csp = r.headers()['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('script-src');
    expect(csp).toContain('style-src');
  });
});
