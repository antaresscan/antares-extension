// __tests__/scan-report.test.ts — the message the overlay sends to the service worker
// (SCAN_RESULT) so the toolbar badge, the risk-escalation notification and the local scan
// history work. They were dead from 2026-04-05 (the only code that set them lived in a
// background `SCAN` handler nobody sent a message to any more — audit A-13).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanResultMessageSchema } from "../shared/schemas";
import type { ScanResponseData } from "../shared/types";
import { buildScanResultMessage, reportScanResult } from "../contents/modules/scan-report";

const CA = "So11111111111111111111111111111111111111112";

const scan = (over: Partial<ScanResponseData> = {}): ScanResponseData =>
  ({ score: 720, risk: "CAUTION", flags: [], tokenSymbol: "WIF", ...over }) as ScanResponseData;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildScanResultMessage", () => {
  it("carries the contract, the verdict, the score and the symbol", () => {
    expect(buildScanResultMessage(CA, scan())).toEqual({
      type: "SCAN_RESULT",
      ca: CA,
      risk: "CAUTION",
      score: 720,
      symbol: "WIF",
    });
  });

  it("satisfies the documented message schema for every verdict the badge knows", () => {
    for (const risk of ["SAFE", "CAUTION", "DANGER", "RUG"]) {
      const msg = buildScanResultMessage(CA, scan({ risk }));
      expect(ScanResultMessageSchema.safeParse(msg).success, risk).toBe(true);
    }
  });

  it("falls back to the DexScreener pair symbol when the payload has no tokenSymbol", () => {
    const msg = buildScanResultMessage(CA, scan({ tokenSymbol: null, pair: { baseToken: { symbol: "BONK" } } }));
    expect(msg?.symbol).toBe("BONK");
  });

  it("sends an empty symbol, not undefined, when there is none", () => {
    expect(buildScanResultMessage(CA, scan({ tokenSymbol: null, pair: null }))?.symbol).toBe("");
  });

  it("caps a very long symbol", () => {
    const msg = buildScanResultMessage(CA, scan({ tokenSymbol: "X".repeat(500) }));
    expect(msg?.symbol).toHaveLength(24);
  });

  it("sends score 0 when the score is missing or not a finite number", () => {
    expect(buildScanResultMessage(CA, scan({ score: Number.NaN }))?.score).toBe(0);
    expect(buildScanResultMessage(CA, scan({ score: undefined as unknown as number }))?.score).toBe(0);
  });

  it("sends nothing for a verdict the badge cannot show", () => {
    expect(buildScanResultMessage(CA, scan({ risk: "UNKNOWN" }))).toBeNull();
    expect(buildScanResultMessage(CA, scan({ risk: "" }))).toBeNull();
    expect(buildScanResultMessage(CA, scan({ risk: undefined as unknown as string }))).toBeNull();
    expect(buildScanResultMessage(CA, scan({ risk: "constructor" }))).toBeNull();
  });
});

// A scan made while a data source did not answer has no verdict for the user (the overlay shows "Limited data"): the badge, the risk-escalation
// notification and the history must hear nothing of it, whatever verdict it reached (a false RUG would raise a false alert).
describe("a scan with a silent source (sourceGap) is not reported", () => {
  it.each(["SAFE", "CAUTION", "DANGER", "RUG"])("%s with the mark: nothing is sent to the worker", (risk) => {
    expect(buildScanResultMessage(CA, scan({ risk, sourceGap: true } as Partial<ScanResponseData>))).toBeNull();
  });

  it("nothing is posted either", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    reportScanResult(CA, scan({ risk: "RUG", sourceGap: true } as Partial<ScanResponseData>));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("witness: the same scan without the mark is reported, and so is one the server marked false", () => {
    expect(buildScanResultMessage(CA, scan({ risk: "RUG" }))?.risk).toBe("RUG");
    expect(buildScanResultMessage(CA, scan({ risk: "RUG", sourceGap: false } as Partial<ScanResponseData>))?.risk).toBe("RUG");
  });

  it("a verdict served from memory (it has its own line and a real, old verdict) is still reported", () => {
    expect(buildScanResultMessage(CA, scan({ risk: "SAFE", sourceGap: true, scannedAgoSec: 360 } as Partial<ScanResponseData>))?.risk).toBe("SAFE");
  });
});

describe("reportScanResult", () => {
  it("posts SCAN_RESULT to the service worker", () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    reportScanResult(CA, scan({ risk: "DANGER", score: 310 }));
    expect(sendMessage).toHaveBeenCalledWith({ type: "SCAN_RESULT", ca: CA, risk: "DANGER", score: 310, symbol: "WIF" });
  });

  it("posts nothing when there is no verdict to show", () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    reportScanResult(CA, scan({ risk: "UNKNOWN" }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never lets a dead worker break the overlay (rejected promise)", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: () => Promise.reject(new Error("Receiving end does not exist")) } });
    expect(() => reportScanResult(CA, scan())).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  });

  it("never lets an orphaned content script break the overlay (sendMessage throws)", () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: () => {
          throw new Error("Extension context invalidated.");
        },
      },
    });
    expect(() => reportScanResult(CA, scan())).not.toThrow();
  });
});
