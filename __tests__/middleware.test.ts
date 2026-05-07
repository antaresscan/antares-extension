import { describe, it, expect, vi } from "vitest";
import {
  validateCA,
  getClientIp,
  getInstallId,
  setCorsHeaders,
  checkRateLimit,
  ALLOWED_ORIGINS,
} from "../api/_lib/middleware";
import type { VercelRequest, VercelResponse } from "@vercel/node";

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
    const ca = " So11111111111111111111111111111111111111112 ";
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
  it("allows chrome-extension origin", () => {
    const req = mockReq({
      origin: "chrome-extension://abcdef123456",
    });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "chrome-extension://abcdef123456");
  });

  it("allows chrome-extension origin without any token header", () => {
    const req = mockReq({
      origin: "chrome-extension://anotherId789",
    });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(true);
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

  it("allows same-origin request with matching host (production)", () => {
    const req = mockReq({ host: "antares-extension.vercel.app" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(true);
  });

  it("allows same-origin request with matching host (preview deploy)", () => {
    const req = mockReq({ host: "antares-extension-git-feat-x-comealamaisongroupe.vercel.app" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(true);
  });

  it("rejects no-origin request from a different vercel.app project", () => {
    const req = mockReq({ host: "some-other-project.vercel.app" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(false);
  });

  it("rejects no-origin request even when referer claims trust (anti-spoof)", () => {
    // Old behaviour trusted Referer; the new check ignores it because
    // any non-browser client can forge Referer. Host is set by Vercel
    // routing so it cannot be cross-deployment forged.
    const req = mockReq({ referer: "https://antares-extension.vercel.app/token.html" });
    const res = mockRes();
    expect(setCorsHeaders(req, res)).toBe(false);
  });

  it("rejects no-origin no-host request", () => {
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

  it("accepts an optional installId argument without changing success path", async () => {
    const res = mockRes();
    const result = await checkRateLimit(res, "1.2.3.4", "abcdef12-install-id");
    expect(result).toBe(true);
  });
});

// ═══ getInstallId ═══════════════════════════════════════════════════════════
describe("getInstallId", () => {
  it("returns a valid UUIDv4-shaped header", () => {
    const req = mockReq({ "x-antares-install": "a1b2c3d4-1234-4abc-9def-0123456789ab" });
    expect(getInstallId(req)).toBe("a1b2c3d4-1234-4abc-9def-0123456789ab");
  });

  it("accepts a short opaque token (8 chars minimum)", () => {
    const req = mockReq({ "x-antares-install": "abc12345" });
    expect(getInstallId(req)).toBe("abc12345");
  });

  it("trims surrounding whitespace", () => {
    const req = mockReq({ "x-antares-install": "   abc12345   " });
    expect(getInstallId(req)).toBe("abc12345");
  });

  it("returns null when header is missing", () => {
    const req = mockReq({});
    expect(getInstallId(req)).toBeNull();
  });

  it("returns null when header is too short (<8 chars)", () => {
    const req = mockReq({ "x-antares-install": "abc" });
    expect(getInstallId(req)).toBeNull();
  });

  it("returns null when header is too long (>128 chars)", () => {
    const req = mockReq({ "x-antares-install": "a".repeat(200) });
    expect(getInstallId(req)).toBeNull();
  });

  it("returns null when header contains invalid characters", () => {
    const req = mockReq({ "x-antares-install": "abc<script>attack" });
    expect(getInstallId(req)).toBeNull();
  });

  it("returns null for non-string values", () => {
    const req = { headers: { "x-antares-install": 12345 }, socket: {} } as unknown as VercelRequest;
    expect(getInstallId(req)).toBeNull();
  });
});
