import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown) => {
      mocks.store.set(k, v);
      return "OK";
    });
    get = vi.fn(async (k: string) => mocks.store.get(k) ?? null);
    hset = vi.fn(async (k: string, fields: Record<string, string>) => {
      const existing = (mocks.store.get(k) as Record<string, string>) ?? {};
      mocks.store.set(k, { ...existing, ...fields });
      return Object.keys(fields).length;
    });
    hgetall = vi.fn(async (k: string) => {
      const v = mocks.store.get(k);
      return v ? { ...(v as Record<string, string>) } : null;
    });
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return {
    ...actual,
    checkRateLimit: vi.fn().mockResolvedValue(true),
    initRateLimiters: vi.fn(),
  };
});

import signupHandler from "../api/auth/signup";
import loginHandler from "../api/auth/login";
import logoutHandler from "../api/auth/logout";
import meHandler from "../api/auth/me";
import { signSession } from "../api/_lib/account";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";

const ORIGIN = "https://antares-website.vercel.app";

interface MockReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function mockReq({
  method = "POST",
  headers = {},
  body,
}: MockReqOpts = {}): VercelRequest {
  return { method, headers, query: {}, body, socket: {} } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

function getSetCookieHeader(res: VercelResponse): string | null {
  const calls = (res.setHeader as unknown as { mock: { calls: [string, string][] } })
    .mock.calls;
  const sc = calls.find(([k]) => k === "Set-Cookie");
  return sc ? sc[1] : null;
}

beforeEach(() => {
  mocks.store.clear();
  vi.clearAllMocks();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.SESSION_SECRET = "0".repeat(64);
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.SESSION_SECRET;
});

// ── signup ────────────────────────────────────────────────────────────────
describe("POST /api/auth/signup", () => {
  it("rejects GET with 405", async () => {
    const req = mockReq({ method: "GET", headers: { origin: ORIGIN } });
    const res = mockRes();
    await signupHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects bad origin with 403", async () => {
    const req = mockReq({ headers: { origin: "https://attacker.example.com" } });
    const res = mockRes();
    await signupHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects malformed email with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "not-email", password: "supersecret" },
    });
    const res = mockRes();
    await signupHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects weak password with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "alice@example.com", password: "short" },
    });
    const res = mockRes();
    await signupHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("creates account, sets session cookie, returns 200", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "alice@example.com", password: "supersecret1" },
    });
    const res = mockRes();
    await signupHandler(req, res);
    const setCookie = getSetCookieHeader(res);
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, email: "alice@example.com" }),
    );
  });

  it("rejects duplicate email with 409", async () => {
    const req1 = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "alice@example.com", password: "supersecret1" },
    });
    await signupHandler(req1, mockRes());
    const req2 = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "alice@example.com", password: "differentpass" },
    });
    const res2 = mockRes();
    await signupHandler(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(409);
  });
});

// ── login ────────────────────────────────────────────────────────────────
describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    // Pre-create an account
    await signupHandler(
      mockReq({
        headers: { origin: ORIGIN },
        body: { email: "alice@example.com", password: "supersecret1" },
      }),
      mockRes(),
    );
  });

  it("returns 200 + cookie on correct credentials", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "alice@example.com", password: "supersecret1" },
    });
    const res = mockRes();
    await loginHandler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(401);
    const cookie = getSetCookieHeader(res);
    expect(cookie).toContain(SESSION_COOKIE_NAME);
  });

  it("returns 401 on wrong password", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "alice@example.com", password: "wrong-pass" },
    });
    const res = mockRes();
    await loginHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 401 on unknown email (no enumeration)", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "nobody@nowhere.com", password: "anything12" },
    });
    const res = mockRes();
    await loginHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects bad origin with 403", async () => {
    const req = mockReq({ headers: { origin: "https://attacker.example.com" } });
    const res = mockRes();
    await loginHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ── logout ────────────────────────────────────────────────────────────────
describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const req = mockReq({ headers: { origin: ORIGIN } });
    const res = mockRes();
    await logoutHandler(req, res);
    const cookie = getSetCookieHeader(res);
    expect(cookie).toContain("Max-Age=0");
  });

  it("rejects GET with 405", async () => {
    const req = mockReq({ method: "GET", headers: { origin: ORIGIN } });
    const res = mockRes();
    await logoutHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});

// ── me ────────────────────────────────────────────────────────────────
describe("GET /api/auth/me", () => {
  beforeEach(async () => {
    await signupHandler(
      mockReq({
        headers: { origin: ORIGIN },
        body: { email: "alice@example.com", password: "supersecret1" },
      }),
      mockRes(),
    );
  });

  it("returns 401 when no session cookie", async () => {
    const req = mockReq({ method: "GET", headers: { origin: ORIGIN } });
    const res = mockRes();
    await meHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 200 + email when valid session cookie", async () => {
    const token = signSession("alice@example.com");
    const req = mockReq({
      method: "GET",
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    const res = mockRes();
    await meHandler(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, email: "alice@example.com" }),
    );
  });

  it("rejects POST with 405", async () => {
    const req = mockReq({ method: "POST", headers: { origin: ORIGIN } });
    const res = mockRes();
    await meHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
