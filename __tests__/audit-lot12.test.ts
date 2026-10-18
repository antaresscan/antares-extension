// __tests__/audit-lot12.test.ts — Lot 12 of the file-by-file audit (2026-10-17): api/_lib/goplus-auth.ts, goplus-cache.ts,
// rugcheck-memory.ts, last-good.ts, outage.ts, usage.ts. Fails on the previous code.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchJsonMock = vi.fn();
vi.mock("../api/_lib/http", () => ({ fetchJson: (...a: unknown[]) => fetchJsonMock(...a) }));
vi.mock("../api/_lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

const { fetchGoPlusSecurity, _resetGoPlusAuthForTests } = await import("../api/_lib/goplus-auth");

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const tokenOk = { code: 1, message: "OK", result: { access_token: "Bearer tok-1", expires_in: 7200 } };
const dataOk = { code: 1, result: { [MINT]: { holder_count: "10" } } };

beforeEach(() => {
  fetchJsonMock.mockReset();
  _resetGoPlusAuthForTests();
  process.env.GOPLUS_APP_KEY = "app-key";
  process.env.GOPLUS_APP_SECRET = "app-secret";
});
afterEach(() => { delete process.env.GOPLUS_APP_KEY; delete process.env.GOPLUS_APP_SECRET; });

describe("goplus-auth — a network blip does not throw a valid token away", () => {
  it("after an authenticated call that got NO answer, the next scan reuses the token (it asked GoPlus for a new one)", async () => {
    const tokenCalls = () => fetchJsonMock.mock.calls.filter((c) => String(c[0]).endsWith("/token")).length;
    fetchJsonMock
      .mockResolvedValueOnce(tokenOk) // token exchange
      .mockResolvedValueOnce(null)    // authenticated lookup: no answer (timeout)
      .mockResolvedValueOnce(dataOk)  // anonymous fallback of this scan
      .mockResolvedValue(dataOk);     // whatever comes next
    await fetchGoPlusSecurity(MINT);
    await fetchGoPlusSecurity(MINT);
    expect(tokenCalls()).toBe(1);
  });
});
