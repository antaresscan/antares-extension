import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateCA,
  getClientIp,
  setCorsHeaders,
  checkRateLimit,
  ALLOWED_ORIGINS,
} from "../api/_lib/middleware";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockReq(headers: Record<string, string> = {}, socket?: Record<string, unknown>): VercelRequest {
  return { headers, socket: socket ?? {} } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as VercelResponse;
}

// ═══ validateCA ═════════════════════════════════════════════════════════════
describe("validateCA", () => {
  it("returns trimmed CA for valid Solana address", () => {
    const ca = "So11111111111111111111111111111111111111112";
    expect(validateCA(ca)).toBe(ca);
  });

  it("returns trimmed CA with whitespace", () => {
    const ca = "  So11111111111111111111111111111111111111112  ";
    expect(validateCA(ca)).toBe(ca.trim());
  });

  it("returns null for invalid CA", () => {
    expect(validateCA("not-a-valid-ca")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(validateCA("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(validateCA(123)).toBeNull();
    expect(validateCA(null)).toBeNull();
    expect(validateCA(undefined)).toBeNull();
  });
});

// ═══ getClientIp ════════════════════════════════════════════════════════════
describe("getClientIp", () => {
  it("returns x-real-ip when present", () => {
    const req = mockReq({ "x-real-ip": "1.2.3.4" });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("returns first x-forwarded-for IP", () => {
    const req = mockReq({ "x-forwarded-for": "5.6.7.8, 9.10.11.12" });
    expect(getClientIp(req)).toBe("5.6.7.8");
  });

  it("returns socket remoteAddress as fallback", () => {
    const req = mockReq({}, { remoteAddress: "127.0.0.1" });
    expect(getClientIp(req)).toBe("127.0.0.1");
  });

  it("returns 'unknown' when no IP info", () => {
    const req = mockReq();
    expect(getClientIp(req)).toBe("unknown");
  });
});

// ═══ setCorsHeaders ═════════════════════════════════════════════════════════
describe("setCorsHeaders", () => {
  beforeEach(() => {
    vi.stubEnv("ANTARES_EXT_TOKEN", "test-token-123");
  });

  it("allows chrome-extension origin with valid token", () => {
    const req = mockReq({
      origin: "chrome-extension://abcdef123456",
      "x-antares-token": "test-token-123",
    });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "chrome-extension://abcdef123456");
  });

  it("rejects chrome-extension origin with invalid token", () => {
    const req = mockReq({
      origin: "chrome-extension://abcdef123456",
      "x-antares-token": "wrong-token",
    });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(false);
  });

  it("rejects chrome-extension origin with missing token", () => {
    const req = mockReq({ origin: "chrome-extension://abcdef123456" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(false);
  });

  it("allows known origin from ALLOWED_ORIGINS", () => {
    const req = mockReq({ origin: "https://dexscreener.com" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "https://dexscreener.com");
  });

  it("rejects unknown origin", () => {
    const req = mockReq({ origin: "https://evil.com" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(false);
  });

  it("allows same-origin request with matching referer", () => {
    const req = mockReq({ referer: "https://antares-extension.vercel.app/token.html" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(true);
  });

  it("rejects no-origin request without matching referer", () => {
    const req = mockReq({ referer: "https://evil.com/page" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(false);
  });

  it("rejects no-origin no-referer request", () => {
    const req = mockReq();
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(false);
  });

  it("ALLOWED_ORIGINS contains expected domains", () => {
    expect(ALLOWED_ORIGINS).toContain("https://dexscreener.com");
    expect(ALLOWED_ORIGINS).toContain("https://pump.fun");
  });
});

// ═══ checkRateLimit (no Redis configured) ═══════════════════════════════════
describe("checkRateLimit", () => {
  it("returns true when no rate limiter is configured", async () => {
    const res = mockRes();
    const result = await checkRateLimit(res, "1.2.3.4");
    expect(result).toBe(true);
  });
});
