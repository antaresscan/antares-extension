import { vi, describe, it, expect, beforeEach } from "vitest";
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

import { Redis } from "@upstash/redis";
import {
  buildSessionCookie,
  buildClearSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  readSessionToken,
  getAccountFromRequest,
  SESSION_COOKIE_NAME,
} from "../api/_lib/session-cookie";
import { signSession, createAccount } from "../api/_lib/account";

beforeEach(() => {
  mocks.store.clear();
  process.env.SESSION_SECRET = "0".repeat(64);
});

function mockRes() {
  return {
    setHeader: vi.fn(),
  } as unknown as VercelResponse;
}

function mockReq(cookieHeader?: string) {
  return {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  } as unknown as VercelRequest;
}

describe("buildSessionCookie", () => {
  it("builds a cookie with HttpOnly + Secure + SameSite=None by default", () => {
    const cookie = buildSessionCookie("token123");
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=token123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=");
  });

  it("can override secure for tests", () => {
    const cookie = buildSessionCookie("token", { secure: false, sameSite: "Lax" });
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("URL-encodes the token value", () => {
    const cookie = buildSessionCookie("a.b.c+with/special=chars");
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=a.b.c%2Bwith%2Fspecial%3Dchars`);
  });
});

describe("buildClearSessionCookie", () => {
  it("clears the cookie via Max-Age=0", () => {
    const cookie = buildClearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("setSessionCookie + clearSessionCookie", () => {
  it("sets a Set-Cookie header with a fresh JWT", () => {
    const res = mockRes();
    setSessionCookie(res, "user@example.com");
    const calls = (res.setHeader as unknown as { mock: { calls: [string, string][] } }).mock.calls;
    const setCookie = calls.find(([h]) => h === "Set-Cookie");
    expect(setCookie).toBeDefined();
    expect(setCookie![1]).toContain(SESSION_COOKIE_NAME);
  });

  it("clearSessionCookie zeros the cookie", () => {
    const res = mockRes();
    clearSessionCookie(res);
    const calls = (res.setHeader as unknown as { mock: { calls: [string, string][] } }).mock.calls;
    const setCookie = calls.find(([h]) => h === "Set-Cookie");
    expect(setCookie![1]).toContain("Max-Age=0");
  });
});

describe("readSessionToken", () => {
  it("extracts the token from a single-cookie header", () => {
    const req = mockReq(`${SESSION_COOKIE_NAME}=abc.def.ghi`);
    expect(readSessionToken(req)).toBe("abc.def.ghi");
  });

  it("extracts when other cookies are present", () => {
    const req = mockReq(`other=foo; ${SESSION_COOKIE_NAME}=abc.def.ghi; another=bar`);
    expect(readSessionToken(req)).toBe("abc.def.ghi");
  });

  it("URL-decodes the value", () => {
    const req = mockReq(`${SESSION_COOKIE_NAME}=a.b.c%2Bwith%2Fspecial%3Dchars`);
    expect(readSessionToken(req)).toBe("a.b.c+with/special=chars");
  });

  it("returns null when cookie is missing", () => {
    expect(readSessionToken(mockReq())).toBeNull();
    expect(readSessionToken(mockReq("other=foo"))).toBeNull();
  });
});

describe("getAccountFromRequest", () => {
  it("returns the account when cookie carries a valid signed JWT", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await createAccount(redis, {
      email: "alice@example.com",
      password: "firstpass1",
    });
    const token = signSession("alice@example.com");
    const req = mockReq(`${SESSION_COOKIE_NAME}=${token}`);
    const account = await getAccountFromRequest(req, redis);
    expect(account?.email).toBe("alice@example.com");
  });

  it("returns null for missing cookie", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const account = await getAccountFromRequest(mockReq(), redis);
    expect(account).toBeNull();
  });

  it("returns null for tampered token", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const token = signSession("alice@example.com");
    const tampered = token.slice(0, -2) + "XX";
    const req = mockReq(`${SESSION_COOKIE_NAME}=${tampered}`);
    expect(await getAccountFromRequest(req, redis)).toBeNull();
  });

  it("returns null when account no longer exists in Redis (deleted user)", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    // Sign a token for an email that was never created
    const token = signSession("ghost@example.com");
    const req = mockReq(`${SESSION_COOKIE_NAME}=${token}`);
    expect(await getAccountFromRequest(req, redis)).toBeNull();
  });
});
