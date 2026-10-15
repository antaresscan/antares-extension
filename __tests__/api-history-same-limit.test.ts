import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// The Free tier is the verdict, unlimited; only the explanation of the verdict is Pro. So /api/history must give a Free caller exactly what
// it gives a Pro one. The tier is mocked here (the other test file has no Redis, so its caller is always Free).

const tierRef = { current: "free" as "free" | "pro" | "yearly" | "lifetime" };
const getScanHistory = vi.fn().mockResolvedValue([]);

vi.mock("../api/_lib/user", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/user")>("../api/_lib/user");
  return {
    ...actual,
    initUserStorage: vi.fn(),
    getEffectiveTierFromRequest: vi.fn(async () => tierRef.current),
    getScanHistory: (...args: unknown[]) => getScanHistory(...args),
  };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return { ...actual, initRateLimiters: vi.fn(), checkRateLimit: vi.fn().mockResolvedValue(true) };
});

import handler from "../api/history";

const ORIGIN = "chrome-extension://noemghbbbgcpnocdcflcaccnhnfehpfa";
const INSTALL = "install-history-same-limit-cccc";

function call(query: Record<string, string>) {
  const req = { method: "GET", headers: { origin: ORIGIN, "x-antares-install": INSTALL }, query, socket: {} } as unknown as VercelRequest;
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis() } as unknown as VercelResponse;
  return handler(req, res).then(() => ({
    answer: (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { limit: number; retentionDays: number; tier: string },
    asked: getScanHistory.mock.calls.at(-1)?.[1] as { limit: number; sinceMs: number },
  }));
}

beforeEach(() => { getScanHistory.mockClear(); });

describe("/api/history gives every tier the same", () => {
  it.each(["free", "pro", "yearly", "lifetime"] as const)("%s: a limit of 1000 is 100, and storage is asked for 100", async (tier) => {
    tierRef.current = tier;
    const { answer, asked } = await call({ limit: "1000" });
    expect(answer.limit).toBe(100);
    expect(asked.limit).toBe(100);
    expect(answer.tier).toBe(tier); // still reported, for the clients that read it
  });

  it.each(["free", "pro"] as const)("%s: asking for nothing gives 100, asking for 25 gives 25", async (tier) => {
    tierRef.current = tier;
    expect((await call({})).answer.limit).toBe(100);
    expect((await call({ limit: "25" })).answer.limit).toBe(25);
  });

  it("the window is the same for Free and Pro: 30 days", async () => {
    tierRef.current = "free";
    const free = await call({});
    tierRef.current = "pro";
    const pro = await call({});
    expect(free.answer.retentionDays).toBe(30);
    expect(pro.answer.retentionDays).toBe(30);
  });

  it("witness: the old Free cap of 10 is gone", async () => {
    tierRef.current = "free";
    expect((await call({ limit: "50" })).answer.limit).not.toBe(10);
  });
});
