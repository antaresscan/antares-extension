import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../api/_lib/logger";

describe("logger.metric", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a JSON line with level=metric, event and data fields", () => {
    logger.metric("scan.outcome", { requestId: "abc", score: 850 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(payload.level).toBe("metric");
    expect(payload.event).toBe("scan.outcome");
    expect(payload.requestId).toBe("abc");
    expect(payload.score).toBe(850);
    expect(typeof payload.ts).toBe("string");
  });

  it("always emits regardless of LOG_LEVEL", () => {
    // Even with LOG_LEVEL='error', metric should still go out.
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error";
    try {
      logger.metric("scan.outcome", { sourcesUsed: 6 });
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (prevLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prevLevel;
    }
  });

  it("preserves nested structured fields (layers object)", () => {
    logger.metric("scan.outcome", {
      layers: {
        dexscreener: { trust: 0.7, available: true },
        goplus: { trust: 0.2, available: true },
      },
    });

    type MetricPayload = {
      layers: Record<string, { trust: number; available: boolean }>;
    };
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string) as MetricPayload;
    expect(payload.layers.dexscreener).toEqual({ trust: 0.7, available: true });
    expect(payload.layers.goplus.trust).toBe(0.2);
  });
});
