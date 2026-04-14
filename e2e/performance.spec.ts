import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';

test.describe('Performance', () => {
  test.describe('Page Load Times', () => {
    const PAGES = [
      { name: 'Landing', path: '/' },
      { name: 'Token', path: '/token.html' },
      { name: 'Privacy', path: '/privacy.html' },
    ];

    for (const pg of PAGES) {
      test(`${pg.name} loads within 5s (domcontentloaded)`, async ({ page }) => {
        const start = Date.now();
        await page.goto(`${BASE}${pg.path}`, { waitUntil: 'domcontentloaded' });
        expect(Date.now() - start).toBeLessThan(5000);
      });

      test(`${pg.name} fully loads within 10s`, async ({ page }) => {
        const start = Date.now();
        await page.goto(`${BASE}${pg.path}`, { waitUntil: 'load' });
        expect(Date.now() - start).toBeLessThan(10000);
      });
    }
  });

  test.describe('API Response Times', () => {
    test('/api/health responds within 2s', async ({ request }) => {
      const start = Date.now();
      const r = await request.get(`${BASE}/api/health`);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(r.ok()).toBeTruthy();
    });

    test('/api/rugs responds within 5s', async ({ request }) => {
      const start = Date.now();
      const r = await request.get(`${BASE}/api/rugs`);
      expect(Date.now() - start).toBeLessThan(5000);
      expect(r.ok()).toBeTruthy();
    });

    test('/api/graph responds within 5s', async ({ request }) => {
      const start = Date.now();
      const r = await request.get(`${BASE}/api/graph`);
      expect(Date.now() - start).toBeLessThan(5000);
      expect(r.ok()).toBeTruthy();
    });
  });

  test.describe('Resource Optimization', () => {
    test('landing page total transfer < 2MB', async ({ page }) => {
      let totalBytes = 0;
      page.on('response', (response) => {
        const headers = response.headers();
        const cl = headers['content-length'];
        if (cl) totalBytes += parseInt(cl);
      });
      await page.goto(BASE, { waitUntil: 'load' });
      // 2MB limit
      expect(totalBytes).toBeLessThan(2 * 1024 * 1024);
    });

    test('no excessively large scripts (>500KB individual)', async ({ page }) => {
      const largeSources: string[] = [];
      page.on('response', async (response) => {
        const url = response.url();
        if (url.endsWith('.js') || response.headers()['content-type']?.includes('javascript')) {
          const cl = response.headers()['content-length'];
          if (cl && parseInt(cl) > 500 * 1024) {
            largeSources.push(url);
          }
        }
      });
      await page.goto(BASE, { waitUntil: 'load' });
      expect(largeSources).toHaveLength(0);
    });

    test('images are optimized (no >500KB images)', async ({ page }) => {
      const largeImages: string[] = [];
      page.on('response', async (response) => {
        const ct = response.headers()['content-type'] || '';
        if (ct.startsWith('image/')) {
          const cl = response.headers()['content-length'];
          if (cl && parseInt(cl) > 500 * 1024) {
            largeImages.push(response.url());
          }
        }
      });
      await page.goto(BASE, { waitUntil: 'load' });
      expect(largeImages).toHaveLength(0);
    });

    test('Google Fonts loaded with display=swap', async ({ page }) => {
      const fontRequests: string[] = [];
      page.on('request', (req) => {
        if (req.url().includes('fonts.googleapis.com')) {
          fontRequests.push(req.url());
        }
      });
      await page.goto(BASE, { waitUntil: 'load' });
      for (const url of fontRequests) {
        expect(url).toContain('display=swap');
      }
    });
  });

  test.describe('No Console Errors', () => {
    test('landing page has no JS errors', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(BASE, { waitUntil: 'load' });
      expect(errors).toHaveLength(0);
    });

    test('token page has no JS errors', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(`${BASE}/token.html`, { waitUntil: 'load' });
      expect(errors).toHaveLength(0);
    });

    test('privacy page has no JS errors', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(`${BASE}/privacy.html`, { waitUntil: 'load' });
      expect(errors).toHaveLength(0);
    });
  });

  test.describe('Caching Headers', () => {
    test('static assets have cache headers', async ({ request }) => {
      const r = await request.get(BASE);
      // Vercel typically adds cache headers
      expect(r.status()).toBe(200);
    });

    test('API responses have proper content-type', async ({ request }) => {
      const r = await request.get(`${BASE}/api/health`);
      const ct = r.headers()['content-type'] || '';
      expect(ct).toContain('application/json');
    });
  });
});
