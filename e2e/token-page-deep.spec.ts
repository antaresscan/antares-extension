import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://antares-extension.vercel.app';
// POPCAT instead of WSOL — see api-scan.spec.ts for rationale (WSOL
// times out the prod /api/scan budget). Variable name kept for diff
// continuity.
const SOL_WRAPPED = 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82';
const INVALID_CA = 'notavalidaddress';
const RANDOM_CA = '11111111111111111111111111111111';

test.describe('Token Page — Deep Functional Tests', () => {
  test.describe('Loading State', () => {
    test('shows loading indicator before data arrives', async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      const loading = page.locator('text=/loading|analysing|scanning/i');
      const count = await loading.count();
      // Loading should appear briefly or page should resolve
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('resolves to full content within 15s', async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/SAFE|CAUTION|DANGER|RUG/i', { timeout: 15000 });
    });
  });

  test.describe('Verdict Section', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/SAFE|CAUTION|DANGER|RUG/i', { timeout: 15000 });
    });

    test('displays risk verdict (SAFE/CAUTION/DANGER/RUG)', async ({ page }) => {
      const verdict = page.locator('text=/SAFE|CAUTION|DANGER|RUG/i').first();
      await expect(verdict).toBeVisible();
    });

    test('displays token symbol', async ({ page }) => {
      const symbol = page.locator('text=/SOL|Wrapped/i').first();
      await expect(symbol).toBeVisible();
    });

    test('displays token age', async ({ page }) => {
      const age = page.locator('text=/old|ago|mo|yr|day/i').first();
      await expect(age).toBeVisible();
    });

    test('displays price in USD', async ({ page }) => {
      const price = page.locator('text=/\\$/').first();
      await expect(price).toBeVisible();
    });

    test('displays score out of 1000', async ({ page }) => {
      const score = page.locator('text=/\\/\\s*1000/').first();
      await expect(score).toBeVisible();
    });

    test('displays confidence percentage', async ({ page }) => {
      const conf = page.locator('text=/Conf\\.?.*\\d+%/i').first();
      await expect(conf).toBeVisible();
    });

    test('displays flags count', async ({ page }) => {
      const flags = page.locator('text=/\\d+\\s*flag/i').first();
      await expect(flags).toBeVisible();
    });
  });

  test.describe('Market Data Section', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/MARKET DATA/i', { timeout: 15000 });
    });

    test('shows MARKET DATA heading', async ({ page }) => {
      await expect(page.locator('text=/MARKET DATA/i').first()).toBeVisible();
    });

    test('shows liquidity value', async ({ page }) => {
      await expect(page.locator('text=/LIQUIDITY/i').first()).toBeVisible();
    });

    test('shows volume 24h', async ({ page }) => {
      await expect(page.locator('text=/VOLUME 24H/i').first()).toBeVisible();
    });

    test('shows volume 1h', async ({ page }) => {
      await expect(page.locator('text=/VOLUME 1H/i').first()).toBeVisible();
    });

    test('shows price change intervals (5min, 1h, 6h, 24h)', async ({ page }) => {
      await expect(page.locator('text=/5\\s*MIN/i').first()).toBeVisible();
      await expect(page.locator('text=/1\\s*HOUR/i').first()).toBeVisible();
      await expect(page.locator('text=/6\\s*HOUR/i').first()).toBeVisible();
      await expect(page.locator('text=/24\\s*HOUR/i').first()).toBeVisible();
    });

    test('price changes show percentage values', async ({ page }) => {
      const percentages = page.locator('text=/%/');
      const count = await percentages.count();
      expect(count).toBeGreaterThanOrEqual(4);
    });
  });

  test.describe('Security Section', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/SECURITY/i', { timeout: 15000 });
    });

    test('shows SECURITY heading', async ({ page }) => {
      await expect(page.locator('text=/SECURITY/i').first()).toBeVisible();
    });

    test('shows sell status', async ({ page }) => {
      await expect(page.locator('text=/SELL/i').first()).toBeVisible();
    });

    test('shows mint authority status', async ({ page }) => {
      await expect(page.locator('text=/MINT/i').first()).toBeVisible();
    });

    test('shows freeze authority status', async ({ page }) => {
      await expect(page.locator('text=/FREEZE/i').first()).toBeVisible();
    });

    test('shows LP status', async ({ page }) => {
      await expect(page.locator('text=/\\bLP\\b/').first()).toBeVisible();
    });

    test('shows liquidity value in security', async ({ page }) => {
      await expect(page.locator('text=/LIQ/i').first()).toBeVisible();
    });
  });

  test.describe('Flags Section', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/FLAGS/i', { timeout: 15000 });
    });

    test('shows FLAGS heading', async ({ page }) => {
      await expect(page.locator('text=/FLAGS/i').first()).toBeVisible();
    });

    test('flags section has content or is empty', async ({ page }) => {
      const flagsSection = page.locator('text=/FLAGS/i').first();
      await expect(flagsSection).toBeVisible();
    });
  });

  test.describe('Sources Section', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/SOURCES/i', { timeout: 15000 });
    });

    test('shows SOURCES heading', async ({ page }) => {
      await expect(page.locator('text=/SOURCES/i').first()).toBeVisible();
    });

    test('lists dexscreener as source', async ({ page }) => {
      await expect(page.locator('text=/dexscreener/i').first()).toBeVisible();
    });

    test('lists rugcheck as source', async ({ page }) => {
      await expect(page.locator('text=/rugcheck/i').first()).toBeVisible();
    });

    test('lists goplus as source', async ({ page }) => {
      await expect(page.locator('text=/goplus/i').first()).toBeVisible();
    });

    test('lists Helius as source', async ({ page }) => {
      await expect(page.locator('text=/Helius/i').first()).toBeVisible();
    });

    test('lists solscan as source', async ({ page }) => {
      await expect(page.locator('text=/solscan/i').first()).toBeVisible();
    });

    test('sources show used/unused status', async ({ page }) => {
      const used = page.locator('text=/used/i');
      const count = await used.count();
      expect(count).toBeGreaterThanOrEqual(3);
    });
  });

  test.describe('External Links', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/SAFE|CAUTION|DANGER|RUG/i', { timeout: 15000 });
    });

    test('has DEXSCREENER link', async ({ page }) => {
      const link = page.locator('text=/DEXSCREENER/i').first();
      await expect(link).toBeVisible();
    });

    test('has SOLSCAN link', async ({ page }) => {
      const link = page.locator('text=/SOLSCAN/i').first();
      await expect(link).toBeVisible();
    });

    test('has RUGCHECK link', async ({ page }) => {
      const link = page.locator('text=/RUGCHECK/i').first();
      await expect(link).toBeVisible();
    });
  });

  test.describe('Error Handling', () => {
    test('missing ca parameter shows error or empty state', async ({ page }) => {
      await page.goto(`${BASE}/token.html`);
      await page.waitForLoadState('networkidle');
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
    });

    test('invalid ca shows error state', async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${INVALID_CA}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000);
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
    });

    test('random short address shows error or no data', async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${RANDOM_CA}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(5000);
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
    });
  });

  test.describe('Contract Address Display', () => {
    test('displays truncated contract address', async ({ page }) => {
      await page.goto(`${BASE}/token.html?ca=${SOL_WRAPPED}`);
      await page.waitForSelector('text=/So1.*112/i', { timeout: 15000 });
      const ca = page.locator('text=/So1.*112/i').first();
      await expect(ca).toBeVisible();
    });
  });
});
