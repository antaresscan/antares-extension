import { describe, it, expect, vi } from "vitest";
import { fetchSnapshot, classifyRugCheck } from "../../scripts/backtest/fetch-snapshot";

const CA = "So11111111111111111111111111111111111111112";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function failResponse(status: number): Response {
  return new Response("", { status });
}

describe("fetchSnapshot", () => {
  it("merges fields from all four sources into a single TokenSnapshot", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("dexscreener")) {
        return jsonResponse({
          pairs: [
            { liquidity: { usd: 50_000 }, volume: { h24: 12_000 }, pairCreatedAt: Date.now() - 24 * 3_600_000 },
          ],
        });
      }
      if (u.includes("helius-rpc.com")) {
        // We can't easily distinguish the two RPC calls in this single-fn mock,
        // so we sniff the body to pick a response.
        return jsonResponse({
          result:
            url instanceof Request
              ? null
              : { value: [{ amount: "100", uiAmount: 100 }] },
        });
      }
      if (u.includes("gopluslabs")) {
        return jsonResponse({
          result: {
            [CA]: {
              is_honeypot: "0",
              cannot_sell_all: "0",
              mintable: { status: "0" },
              freezable: { status: "0" },
              dex: [{ liquidity: "50000", liquidity_type: "burned", burn_percent: 100 }],
            },
          },
        });
      }
      if (u.includes("rugcheck")) {
        return jsonResponse({ score: 1000, risks: [] });
      }
      return failResponse(404);
    });

    const snap = await fetchSnapshot(CA, { heliusKey: "test-key" }, fetchMock as unknown as typeof fetch);

    expect(snap.ca).toBe(CA);
    expect(snap.liquidityUsd).toBe(50_000);
    expect(snap.volume24hUsd).toBe(12_000);
    expect(snap.tokenAgeHours).toBeGreaterThanOrEqual(23);
    expect(snap.tokenAgeHours).toBeLessThanOrEqual(25);
    expect(snap.honeypot).toBe(false);
    expect(snap.mintAuthorityActive).toBe(false);
    expect(snap.freezeAuthorityActive).toBe(false);
    expect(snap.lpBurned).toBe(true);
    expect(snap.rugcheckClassification).toBe("safe");
  });

  it("returns null fields when DexScreener has no pairs", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ pairs: [] }));
    const snap = await fetchSnapshot(CA, { heliusKey: null }, fetchMock as unknown as typeof fetch);
    expect(snap.liquidityUsd).toBeNull();
    expect(snap.tokenAgeHours).toBeNull();
  });

  it("returns null fields when an upstream source 5xxs", async () => {
    const fetchMock = vi.fn(async () => failResponse(503));
    const snap = await fetchSnapshot(CA, { heliusKey: null }, fetchMock as unknown as typeof fetch);
    expect(snap.liquidityUsd).toBeNull();
    expect(snap.honeypot).toBeNull();
    expect(snap.rugcheckClassification).toBeNull();
  });

  it("does not call Helius when heliusKey is null", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonResponse({ pairs: [] });
    });
    await fetchSnapshot(CA, { heliusKey: null }, fetchMock as unknown as typeof fetch);
    expect(urls.some(u => u.includes("helius-rpc.com"))).toBe(false);
  });

  it("treats one source's null as non-overwriting when another source has the field", async () => {
    // GoPlus returns an honest "honeypot=true" reading. RugCheck returns nothing.
    // The snapshot must surface honeypot=true, not get clobbered to null.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("gopluslabs")) {
        return jsonResponse({
          result: { [CA]: { is_honeypot: "1", mintable: {}, freezable: {}, dex: [] } },
        });
      }
      return failResponse(503);
    });
    const snap = await fetchSnapshot(CA, { heliusKey: null }, fetchMock as unknown as typeof fetch);
    expect(snap.honeypot).toBe(true);
  });
});

describe("classifyRugCheck", () => {
  it("returns null on null input", () => {
    expect(classifyRugCheck(null)).toBeNull();
  });

  it("returns 'rug' on score >= 30000", () => {
    expect(classifyRugCheck({ score: 30_000 })).toBe("rug");
    expect(classifyRugCheck({ score: 50_000 })).toBe("rug");
  });

  it("returns 'danger' on score >= 10000 but < 30000", () => {
    expect(classifyRugCheck({ score: 15_000 })).toBe("danger");
  });

  it("returns 'danger' on any risk with level 'danger' regardless of score", () => {
    expect(classifyRugCheck({ score: 0, risks: [{ name: "X", level: "danger" }] })).toBe("danger");
  });

  it("returns 'safe' on score < 5000 with no danger risk", () => {
    expect(classifyRugCheck({ score: 1000 })).toBe("safe");
  });

  it("returns null in the ambiguous middle band (5000-9999)", () => {
    expect(classifyRugCheck({ score: 7000 })).toBeNull();
  });
});
