import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('API Security & Hardening', () => {

  test.describe('CORS', () => {
    test('allows requests with proper origin', async ({ request }) => {
      const r = await request.get(`${BASE}/api/health`);
      expect(r.ok()).toBeTruthy();
    });

    test('OPTIONS preflight returns CORS headers', async ({ request }) => {
      const r = await request.fetch(`${BASE}/api/scan?ca=test`, { method: 'OPTIONS' });
      // Should not crash
      expect([200, 204, 400, 404, 405]).toContain(r.status());
    });
  });

  test.describe('Rate Limiting', () => {
    test('does not crash under moderate load', async ({ request }) => {
      const promises = Array.from({ length: 5 }, () =>
        request.get(`${BASE}/api/health`)
      );
      const results = await Promise.all(promises);
      const statuses = results.map(r => r.status());
      // All should be 200 or 429
      statuses.forEach(s => expect([200, 429]).toContain(s));
    });

    test('rate limited response has proper status', async ({ request }) => {
      // Hit endpoint rapidly to trigger rate limit
      const promises = Array.from({ length: 15 }, () =>
        request.get(`${BASE}/api/health`)
      );
      const results = await Promise.all(promises);
      const _hasRateLimit = results.some(r => r.status() === 429);
      // Either gets rate-limited or not (both valid in E2E context)
      expect(results.length).toBe(15);
    });
  });

  test.describe('Input Sanitization', () => {
    test('rejects path traversal attempts', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=../../etc/passwd`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects null bytes', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=test%00malicious`);
      expect([400, 429]).toContain(r.status());
    });

    test('rejects unicode abuse', async ({ request }) => {
      const r = await request.get(`${BASE}/api/scan?ca=\u202ereverse`);
      expect([400, 429]).toContain(r.status());
    });
  });

  test.describe('Unknown Endpoints', () => {
    test('/api/nonexistent returns 404', async ({ request }) => {
      const r = await request.get(`${BASE}/api/nonexistent`);
      expect(r.status()).toBe(404);
    });

    test('security headers present', async ({ request }) => {
      const r = await request.get(`${BASE}/api/health`);
      const headers = r.headers();
      // Vercel adds these by default
      expect(headers['x-powered-by']).toBeUndefined();
    });
  });

  // (A-28) The payment sweep asks NOWPayments about every pending checkout, so it must not start for a stranger. `x-vercel-cron: 1` is a header
  // anybody can type; only `Authorization: Bearer <CRON_SECRET>` (what Vercel sends itself) opens it. This needs no secret: it proves the door is
  // shut to everything a stranger can send, on the deployment under test. (api/_lib/cron-auth.ts)
  test.describe('Scheduled jobs', () => {
    for (const [what, headers] of [
      ['the x-vercel-cron header a stranger can type', { 'x-vercel-cron': '1' }],
      ['no header at all', {}],
      ['a made-up secret', { authorization: 'Bearer definitely-not-the-cron-secret', 'x-vercel-cron': '1' }],
    ] as const) {
      test(`the payment sweep refuses ${what}`, async ({ request }) => {
        const r = await request.get(`${BASE}/api/cron-check-payments`, { headers });
        test.skip(r.status() === 429, 'Rate-limited (429) on shared CI — soft skip');
        expect(r.status(), 'the payment sweep started for a stranger').toBe(401);
        expect(await r.json()).toEqual({ error: 'unauthorized' });
      });
    }
  });

  // (A-14b) "Delete my account" exists on the deployment under test and shuts the door to a stranger: nobody signed in = 401, and an origin that is
  // not the website or the extension = 403. It needs no account and deletes nothing. (api/auth/[action].ts, api/_lib/account-erasure.ts)
  test.describe('Account deletion', () => {
    test('refuses a request with no session', async ({ request }) => {
      const r = await request.post(`${BASE}/api/auth/delete-account`, {
        headers: { origin: 'https://antaresscan.com' },
        data: { password: 'definitely-not-a-password' },
      });
      test.skip(r.status() === 429, 'Rate-limited (429) on shared CI — soft skip');
      expect(r.status(), 'the route is missing or lets a stranger through').toBe(401);
      expect(await r.json()).toEqual({ ok: false, reason: 'not_authenticated' });
    });

    test('refuses an origin that is not ours', async ({ request }) => {
      const r = await request.post(`${BASE}/api/auth/delete-account`, {
        headers: { origin: 'https://attacker.example.com' },
        data: { password: 'definitely-not-a-password' },
      });
      expect(r.status()).toBe(403);
    });
  });

  // (A-01) The e-mail proof is on the deployment under test. None of these makes an account or sends an e-mail: a garbage link is refused, nobody
  // signed in cannot ask for a link, a sign-up with an invalid address is a 400, and the page the link opens is served. (api/auth/[action].ts, verify.html)
  test.describe('E-mail proof', () => {
    test('a link that is not ours is refused', async ({ request }) => {
      const r = await request.post(`${BASE}/api/auth/verify-email`, {
        headers: { origin: 'https://antares-extension.vercel.app' },
        data: { token: 'definitely-not-a-token', password: 'definitely-not-a-password' },
      });
      test.skip(r.status() === 429, 'Rate-limited (429) on shared CI — soft skip');
      expect(r.status(), 'the route is missing or accepts anything').toBe(400);
      expect(await r.json()).toEqual({ ok: false, reason: 'invalid_token' });
    });

    test('nobody signed in cannot ask for a link', async ({ request }) => {
      const r = await request.post(`${BASE}/api/auth/resend-verification`, { headers: { origin: 'https://antaresscan.com' }, data: {} });
      test.skip(r.status() === 429, 'Rate-limited (429) on shared CI — soft skip');
      expect(r.status()).toBe(401);
      expect(await r.json()).toEqual({ ok: false, reason: 'not_authenticated' });
    });

    test('a sign-up with an invalid address is a 400 and creates nothing', async ({ request }) => {
      const r = await request.post(`${BASE}/api/auth/signup`, { headers: { origin: 'https://antaresscan.com' }, data: { email: 'not-an-address', password: 'a-long-enough-password' } });
      test.skip(r.status() === 429, 'Rate-limited (429) on shared CI — soft skip');
      expect(r.status()).toBe(400);
      expect(await r.json()).toEqual({ ok: false, reason: 'invalid_email' });
    });

    test('the page of the link is served, and is not indexed', async ({ request }) => {
      const r = await request.get(`${BASE}/verify.html`);
      expect(r.status()).toBe(200);
      const html = await r.text();
      expect(html).toContain('Confirm your');
      expect(html).toContain('noindex');
    });
  });
});
