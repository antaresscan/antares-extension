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
    del = vi.fn(async (k: string) => {
      const had = mocks.store.delete(k);
      return had ? 1 : 0;
    });
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

import dispatcher from "../api/auth/[action]";
import { signSession } from "../api/_lib/account";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";

const ORIGIN = "https://antares-website.vercel.app";

interface MockReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  action?: string;
}

function mockReq({
  method = "POST",
  headers = {},
  body,
  action,
}: MockReqOpts = {}): VercelRequest {
  const query = action ? { action } : {};
  return { method, headers, query, body, socket: {} } as unknown as VercelRequest;
}

// Wrappers so the rest of the file can keep talking about
// "signupHandler(req, res)" — under the hood we route through the
// single dispatcher with the action query param set, exactly like
// Vercel does for /api/auth/<action> in production.
function signupHandler(req: VercelRequest, res: VercelResponse) {
  (req as unknown as { query: Record<string, string> }).query = { action: "signup" };
  return dispatcher(req, res);
}
function loginHandler(req: VercelRequest, res: VercelResponse) {
  (req as unknown as { query: Record<string, string> }).query = { action: "login" };
  return dispatcher(req, res);
}
function logoutHandler(req: VercelRequest, res: VercelResponse) {
  (req as unknown as { query: Record<string, string> }).query = { action: "logout" };
  return dispatcher(req, res);
}
function meHandler(req: VercelRequest, res: VercelResponse) {
  (req as unknown as { query: Record<string, string> }).query = { action: "me" };
  return dispatcher(req, res);
}
function syncTokenHandler(req: VercelRequest, res: VercelResponse) {
  (req as unknown as { query: Record<string, string> }).query = { action: "sync-token" };
  return dispatcher(req, res);
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
//
// Logout just clears the session cookie. The session-gated
// `getEffectiveTierFromRequest` (in api/_lib/user.ts) handles the
// "no cookie → Free" semantics on every API call, so we don't need
// to mutate any per-install Redis state at logout time.
describe("POST /api/auth/logout", () => {
  const SOME_INSTALL_ID = "11111111-1111-4111-8111-111111111111";

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

  it("does NOT mutate install→email binding or stored tier", async () => {
    // Anti-regression: the cookie is the gate. Storage stays intact so
    // signing back in instantly restores tier without re-redeem.
    mocks.store.set(
      `account:install:${SOME_INSTALL_ID}`,
      "real-customer@example.com",
    );
    mocks.store.set(`user:${SOME_INSTALL_ID}:tier`, "lifetime");

    const req = mockReq({
      headers: { origin: ORIGIN, "x-antares-install": SOME_INSTALL_ID },
    });
    const res = mockRes();
    await logoutHandler(req, res);

    expect(mocks.store.get(`account:install:${SOME_INSTALL_ID}`)).toBe(
      "real-customer@example.com",
    );
    expect(mocks.store.get(`user:${SOME_INSTALL_ID}:tier`)).toBe("lifetime");
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

// ── sync-token ────────────────────────────────────────────────────────────
//
// /api/auth/sync-token is what closes the website-account ↔ extension-
// overlay loop. The website calls it after login with the user's
// install_id (probed from the bridge). The endpoint:
//   1. Verifies the session cookie → identifies the user.
//   2. AUTO-BINDS the install_id to the user's email if the install
//      isn't yet bound (this is the fix for the "I'm signed in but
//      overlay shows Free" bug — without auto-bind the API has a valid
//      session but no install→email mapping, so resolveTierAndBypass
//      returns Free).
//   3. Returns the JWT in the response body so the website can hand
//      it to the extension via the bridge.
describe("POST /api/auth/sync-token", () => {
  const VALID_INSTALL = "11111111-1111-4111-8111-111111111111";
  const OTHER_INSTALL = "22222222-2222-4222-8222-222222222222";

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
    const req = mockReq({ headers: { origin: ORIGIN } });
    const res = mockRes();
    await syncTokenHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 200 + JWT when signed in", async () => {
    const cookie = signSession("alice@example.com");
    const req = mockReq({
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    const res = mockRes();
    await syncTokenHandler(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, email: "alice@example.com", token: expect.any(String) }),
    );
  });

  it("auto-binds install_id to email when install has no binding yet", async () => {
    const cookie = signSession("alice@example.com");
    const req = mockReq({
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        "x-antares-install": VALID_INSTALL,
      },
    });
    const res = mockRes();
    await syncTokenHandler(req, res);

    // Binding should now exist pointing at the signed-in email
    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBe(
      "alice@example.com",
    );
  });

  it("does NOT overwrite existing binding to a different email (anti-hijack)", async () => {
    // Pre-existing binding to bob (e.g. bob paid via Solana)
    mocks.store.set(`account:install:${OTHER_INSTALL}`, "bob@example.com");
    mocks.store.set(`user:${OTHER_INSTALL}:tier`, "yearly");

    // Eve signs in on bob's browser and tries to claim bob's install
    const cookie = signSession("alice@example.com");
    const req = mockReq({
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        "x-antares-install": OTHER_INSTALL,
      },
    });
    const res = mockRes();
    await syncTokenHandler(req, res);

    // Binding stays with bob — alice can't claim bob's paid install
    expect(mocks.store.get(`account:install:${OTHER_INSTALL}`)).toBe(
      "bob@example.com",
    );
    // Stored tier untouched too (not that the endpoint touches it,
    // but anti-regression check).
    expect(mocks.store.get(`user:${OTHER_INSTALL}:tier`)).toBe("yearly");
    // Sync-token still succeeds — alice gets a JWT, just no tier mapping.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, email: "alice@example.com" }),
    );
  });

  it("idempotent re-bind (same email) is a no-op", async () => {
    mocks.store.set(`account:install:${VALID_INSTALL}`, "alice@example.com");

    const cookie = signSession("alice@example.com");
    const req = mockReq({
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        "x-antares-install": VALID_INSTALL,
      },
    });
    const res = mockRes();
    await syncTokenHandler(req, res);

    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBe(
      "alice@example.com",
    );
  });

  it("works without install_id header (cookie-only flow, no bind attempted)", async () => {
    const cookie = signSession("alice@example.com");
    const req = mockReq({
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    const res = mockRes();
    await syncTokenHandler(req, res);

    // Token returned, no binding written (no install to bind).
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, token: expect.any(String) }),
    );
  });

  it("rejects GET with 405", async () => {
    const req = mockReq({ method: "GET", headers: { origin: ORIGIN } });
    const res = mockRes();
    await syncTokenHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
