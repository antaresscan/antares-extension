// __tests__/api-health-usage.test.ts
//
// /api/health?usage=N shows how each upstream API is used and refused (api/_lib/usage.ts). It tells how the service is used, so it is
// reserved to the owner: `Authorization: Bearer <CRON_SECRET>`. Without a CRON_SECRET the view is OFF, never open. It lives in
// /api/health because the project already has the 12 serverless functions Vercel Hobby allows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mockReadUsage = vi.fn();
const mockCaptureError = vi.fn();
vi.mock("../api/_lib/sentry", () => ({ initSentry: vi.fn(), captureError: (...a: unknown[]) => mockCaptureError(...a) }));
vi.mock("../api/_lib/usage", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api/_lib/usage")>()), readUsage: (...a: unknown[]) => mockReadUsage(...a) }));
const mockLoggerError = vi.fn();
vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => mockLoggerError(...a) } }));

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
beforeEach(() => { mockCaptureError.mockReset(); mockLoggerError.mockReset(); mockReadUsage.mockReset(); mockReadUsage.mockResolvedValue(REPORT); process.env.CRON_SECRET = SECRET; });
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

// ─── /api/health?watch=limited: the daily check of yesterday's share of "Limited data" answers (vercel.json cron) ─────────────────────────────
describe("/api/health?watch=limited", () => {
  const share = (total: number, limited: number, causes: Record<string, number> = {}) => ({ total, limited, share: total ? limited / total : 0, causes });
  const twoDays = (yesterday: ReturnType<typeof share>, today = share(10, 0)) => ({
    days: [{ date: "2026-10-13", providers: {}, scans: yesterday }, { date: "2026-10-14", providers: {}, scans: today }], totals: {}, scans: yesterday, basis: {},
  });

  it("above 3 % of 50 scans or more: answers alert:true, writes an error line and a Sentry event that name the sources", async () => {
    mockReadUsage.mockResolvedValue(twoDays(share(200, 20, { helius: 18, goplus: 3 })));
    const r = await call({ watch: "limited" }, `Bearer ${SECRET}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ date: "2026-10-13", alert: true });
    expect((r.body as { message: string }).message).toContain("helius 18, goplus 3");
    expect(mockReadUsage).toHaveBeenCalledWith(2);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    expect(String((mockCaptureError.mock.calls[0][0] as Error).message)).toContain("Limited data");
  });

  it("at or below 3 %: no alert, nothing written", async () => {
    mockReadUsage.mockResolvedValue(twoDays(share(1000, 30, { helius: 30 })));
    const r = await call({ watch: "limited" }, `Bearer ${SECRET}`);
    expect(r.body).toMatchObject({ alert: false });
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it("too few scans to judge: no alert even when every one was Limited data", async () => {
    mockReadUsage.mockResolvedValue(twoDays(share(10, 10, { helius: 10 })));
    const r = await call({ watch: "limited" }, `Bearer ${SECRET}`);
    expect(r.body).toMatchObject({ alert: false });
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it("judges YESTERDAY (a full day), and only reports today", async () => {
    mockReadUsage.mockResolvedValue(twoDays(share(100, 0), share(60, 30, { helius: 30 })));
    const r = await call({ watch: "limited" }, `Bearer ${SECRET}`);
    expect(r.body).toMatchObject({ alert: false, today: { total: 60, limited: 30 } });
  });

  it("is reserved to the owner, like the usage view", async () => {
    for (const header of [undefined, `Bearer ${SECRET}x`, "", SECRET]) {
      const r = await call({ watch: "limited" }, header);
      expect(r.status).toBe(401);
    }
    delete process.env.CRON_SECRET;
    expect((await call({ watch: "limited" }, "Bearer ")).status).toBe(401);
    expect(mockReadUsage).not.toHaveBeenCalled();
  });

  it("the public health check is still public and does not read the usage", async () => {
    const r = await call({ watch: "something-else" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok" });
    expect(mockReadUsage).not.toHaveBeenCalled();
  });

  it("vercel.json asks Vercel to call it once a day", () => {
    const cfg = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const cron = cfg.crons.find((c) => c.path === "/api/health?watch=limited");
    expect(cron?.schedule).toMatch(/^\d+ \d+ \* \* \*$/); // daily: the Hobby plan allows nothing more frequent
  });
});
