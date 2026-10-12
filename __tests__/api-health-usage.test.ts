// __tests__/api-health-usage.test.ts
//
// /api/health?usage=N shows how each upstream API is used and refused (api/_lib/usage.ts). It tells how the service is used, so it is
// reserved to the owner: `Authorization: Bearer <CRON_SECRET>`. Without a CRON_SECRET the view is OFF, never open. It lives in
// /api/health because the project already has the 12 serverless functions Vercel Hobby allows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mockReadUsage = vi.fn();
vi.mock("../api/_lib/usage", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api/_lib/usage")>()), readUsage: (...a: unknown[]) => mockReadUsage(...a) }));
vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import handler from "../api/health";

const SECRET = "owner-secret-for-the-test-0123456789";
const REPORT = { days: [{ date: "2026-10-11", providers: { helius: { calls: 3 } } }], totals: {}, basis: {} };

async function call(query: Record<string, string>, authorization?: string) {
  let status = 200;
  let body: unknown = null;
  const res = {
    setHeader: () => {},
    status(code: number) { status = code; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as VercelResponse;
  await handler({ query, headers: authorization === undefined ? {} : { authorization } } as unknown as VercelRequest, res);
  return { status, body };
}

const saved = process.env.CRON_SECRET;
beforeEach(() => { mockReadUsage.mockReset(); mockReadUsage.mockResolvedValue(REPORT); process.env.CRON_SECRET = SECRET; });
afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });

describe("/api/health?usage=N", () => {
  it("answers the report to the owner", async () => {
    const r = await call({ usage: "7" }, `Bearer ${SECRET}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(REPORT);
    expect(mockReadUsage).toHaveBeenCalledWith(7);
  });

  it("refuses a request with no credentials, and does not read anything", async () => {
    const r = await call({ usage: "7" });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "unauthorized" });
    expect(mockReadUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong secret", `Bearer ${SECRET}x`],
    ["a secret of the right length", `Bearer ${"x".repeat(SECRET.length)}`],
    ["the secret without 'Bearer '", SECRET],
    ["an empty header", ""],
    ["another scheme", `Basic ${SECRET}`],
  ])("refuses %s", async (_label, header) => {
    const r = await call({ usage: "7" }, header);
    expect(r.status).toBe(401);
    expect(mockReadUsage).not.toHaveBeenCalled();
  });

  it("is OFF when no CRON_SECRET is configured, even for 'Bearer ' with nothing after it", async () => {
    delete process.env.CRON_SECRET;
    for (const header of ["Bearer ", "Bearer", "Bearer undefined", ""]) {
      const r = await call({ usage: "7" }, header);
      expect(r.status).toBe(401);
    }
    expect(mockReadUsage).not.toHaveBeenCalled();
  });

  it("witness: without ?usage the health check is unchanged and public", async () => {
    const r = await call({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok" });
    expect(mockReadUsage).not.toHaveBeenCalled();
  });
});
