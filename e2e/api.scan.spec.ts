import { test, expect } from '@playwright/test';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

test.describe('API Scan Endpoint', () => {
  test('should return 400 if no URL provided', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/scan`, {
      data: {},
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  test('should return 400 for invalid URL format', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/scan`, {
      data: { url: 'not-a-valid-url' },
    });
    expect(response.status()).toBe(400);
  });

  test('should successfully scan a valid URL', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/scan`, {
      data: { url: 'https://example.com' },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toHaveProperty('results');
  });

  test('should handle timeout gracefully', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/scan`, {
      data: { url: 'https://httpstat.us/200?sleep=30000' },
      timeout: 60000,
    });
    expect([200, 408, 504]).toContain(response.status());
  });
});
