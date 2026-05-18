// __tests__/integration-account-overlay-sync.test.ts
//
// END-TO-END regression test for the website-account ↔ extension-overlay
// sync. This is the test the founder asked for explicitly: "be 100% sure
// it's working before pushing — do the tests".
//
// We simulate the EXACT production flow that the user's browser walks
// through, against the same Redis mock the rest of the auth tests use:
//
//   1. POST /api/auth/signup    → creates account, sets cookie
//   2. setUserTier(install, X)  → simulates a Solana payment confirming
//   3. POST /api/auth/sync-token with the cookie + X-Antares-Install
//                                → server auto-binds install→email,
//                                  returns JWT for the bridge
//   4. resolveTierAndBypass(req, install) using the JWT in
//      X-Antares-Session header → MUST return X (the user's actual tier)
//
// A single bug anywhere in that chain (cookie not set, sync-token not
// auto-binding, header not honoured by readSessionToken,
// resolveTierAndBypass not honouring binding, etc.) makes this test
// fail. So when it's green, the production flow is verified.
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
    sadd = vi.fn(async (k: string, ...members: string[]) => {
      const existing = (mocks.store.get(k) as Set<string>) ?? new Set<string>();
      let added = 0;
      for (const m of members) {
        if (!existing.has(m)) {
          existing.add(m);
          added++;
        }
      }
      mocks.store.set(k, existing);
      return added;
    });
    smembers = vi.fn(async (k: string) => {
      const v = mocks.store.get(k);
      return v ? [...(v as Set<string>)] : [];
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
import { Redis } from "@upstash/redis";
import { initUserStorage, setUserTier, resolveTierAndBypass } from "../api/_lib/user";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";

const ORIGIN = "https://antares-website.vercel.app";
const VALID_INSTALL = "11111111-1111-4111-8111-111111111111";

function mockReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  action?: string;
}): VercelRequest {
  const { method = "POST", headers = {}, body, action } = opts;
  const query = action ? { action } : {};
  return { method, headers, query, body, socket: {} } as unknown as VercelRequest;
}

interface MockResHelper {
  res: VercelResponse;
  setCookie: () => string | null;
  json: () => unknown;
  status: () => number | undefined;
}

function mockRes(): MockResHelper {
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const setHeaderCalls: [string, string][] = [];
  const res = {
    setHeader: vi.fn((k: string, v: string) => {
      setHeaderCalls.push([k, v]);
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      jsonBody = body;
      if (statusCode === undefined) statusCode = 200;
      return res;
    }),
    end: vi.fn(),
  } as unknown as VercelResponse;
  return {
    res,
    setCookie: () => {
      const found = setHeaderCalls.find(([k]) => k === "Set-Cookie");
      return found ? found[1] : null;
    },
    json: () => jsonBody,
    status: () => statusCode,
  };
}

function extractTokenFromCookie(setCookie: string): string {
  // Format: antares_session=<jwt>; Max-Age=...; Path=/; HttpOnly; ...
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  expect(match).toBeTruthy();
  return decodeURIComponent(match![1]);
}

// Dev/founder allowlist is env-var only (no hardcoded list in account.ts).
process.env.DEV_LIFETIME_EMAILS = "test-dev@example.com";
process.env.DEV_PRO_EMAILS = "test-dev@example.com";

beforeEach(() => {
  mocks.store.clear();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-thirty-two-chars-min-required";
  process.env.SESSION_SECRET = "0".repeat(64);

  // Wire userStorage to the same MockRedis the auth dispatcher uses.
  initUserStorage(new Redis({ url: "x", token: "y" }));
});

describe("E2E: account ↔ overlay tier sync (the one the founder kept asking for)", () => {
  it("sign up → simulate payment → /api/auth/sync-token auto-binds → scan returns user's tier", async () => {
    // ── 1. User signs up at /signup.html with email + password ──────────
    const signup = mockRes();
    await dispatcher(
      mockReq({
        method: "POST",
        action: "signup",
        headers: { origin: ORIGIN },
        body: { email: "alice@example.com", password: "supersecret1" },
      }),
      signup.res,
    );
    expect(signup.status()).toBe(200);
    const setCookieHeader = signup.setCookie();
    expect(setCookieHeader, "signup must set the session cookie").toBeTruthy();
    const sessionJwt = extractTokenFromCookie(setCookieHeader!);

    // ── 2. Simulate a Solana payment confirming on this install ─────────
    // (cron-check-payments calls setUserTier(install, "yearly", expiry))
    await setUserTier(
      VALID_INSTALL,
      "yearly",
      Date.now() + 365 * 24 * 60 * 60 * 1000,
    );
    expect(mocks.store.get(`user:${VALID_INSTALL}:tier`)).toBe("yearly");

    // Sanity check: at THIS point, no install→email binding exists. The
    // user is signed in but the API can't map session→tier yet. A scan
    // request right now should return Free (this is the bug we fixed).
    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBeUndefined();
    const preBindRequest = mockReq({
      method: "GET",
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=${sessionJwt}`,
      },
    });
    const preBindTier = await resolveTierAndBypass(preBindRequest, VALID_INSTALL);
    expect(
      preBindTier.tier,
      "before sync-token auto-bind, signed-in user with no binding gets Free",
    ).toBe("free");

    // ── 3. /account.html calls /api/auth/sync-token with the install_id ─
    // This is what the website was missing before — the call that
    // creates the install→email binding so the next scan resolves tier.
    const syncTokenRes = mockRes();
    await dispatcher(
      mockReq({
        method: "POST",
        action: "sync-token",
        headers: {
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE_NAME}=${sessionJwt}`,
          "x-antares-install": VALID_INSTALL,
        },
      }),
      syncTokenRes.res,
    );
    expect(syncTokenRes.status()).toBe(200);
    const syncTokenBody = syncTokenRes.json() as {
      ok: boolean;
      token: string;
      email: string;
    };
    expect(syncTokenBody.ok).toBe(true);
    expect(syncTokenBody.email).toBe("alice@example.com");
    expect(typeof syncTokenBody.token).toBe("string");

    // The auto-bind MUST have fired — this is the critical assertion.
    expect(
      mocks.store.get(`account:install:${VALID_INSTALL}`),
      "sync-token must auto-bind install_id → email",
    ).toBe("alice@example.com");

    // ── 4. The extension's NEXT scan call uses the JWT as a header ──────
    // resolveTierAndBypass should now return the user's actual tier.
    // This is what the overlay uses to render Pro/Yearly/Lifetime.
    const scanRequest = mockReq({
      method: "GET",
      headers: {
        origin: ORIGIN,
        "x-antares-session": syncTokenBody.token,
      },
    });
    const result = await resolveTierAndBypass(scanRequest, VALID_INSTALL);

    expect(
      result.tier,
      "After sign-in + sync-token auto-bind, the overlay must reflect the user's tier (yearly), NOT Free",
    ).toBe("yearly");
  });

  it("sign-out → scan returns Free even though tier + binding are still in Redis", async () => {
    // Pre-seed: user previously signed in, has tier and binding.
    mocks.store.set(`account:install:${VALID_INSTALL}`, "alice@example.com");
    await setUserTier(VALID_INSTALL, "yearly", Date.now() + 365 * 24 * 60 * 60 * 1000);

    // Now they're signed out — no cookie, no X-Antares-Session.
    const scanRequest = mockReq({
      method: "GET",
      headers: { origin: ORIGIN },
    });
    const result = await resolveTierAndBypass(scanRequest, VALID_INSTALL);

    expect(
      result.tier,
      "Signed out users see Free — the tier still in Redis must NOT leak through",
    ).toBe("free");
  });

  it("different user signs in on the same browser → scan returns Free (anti-hijack)", async () => {
    // Bob paid + signed up + linked install.
    mocks.store.set(`account:install:${VALID_INSTALL}`, "bob@example.com");
    await setUserTier(VALID_INSTALL, "yearly", Date.now() + 365 * 24 * 60 * 60 * 1000);

    // Eve signs up on Bob's browser.
    const signup = mockRes();
    await dispatcher(
      mockReq({
        method: "POST",
        action: "signup",
        headers: { origin: ORIGIN },
        body: { email: "eve@example.com", password: "supersecret1" },
      }),
      signup.res,
    );
    const eveJwt = extractTokenFromCookie(signup.setCookie()!);

    // Eve calls sync-token with install_id — must NOT overwrite Bob's binding.
    const syncTokenRes = mockRes();
    await dispatcher(
      mockReq({
        method: "POST",
        action: "sync-token",
        headers: {
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE_NAME}=${eveJwt}`,
          "x-antares-install": VALID_INSTALL,
        },
      }),
      syncTokenRes.res,
    );
    expect(syncTokenRes.status()).toBe(200);

    // Binding stays with Bob.
    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBe(
      "bob@example.com",
    );

    // Eve's scan: cookie says Eve, binding says Bob, mismatch → Free.
    const scanReq = mockReq({
      method: "GET",
      headers: {
        origin: ORIGIN,
        "x-antares-session": (syncTokenRes.json() as { token: string }).token,
      },
    });
    const result = await resolveTierAndBypass(scanReq, VALID_INSTALL);
    expect(
      result.tier,
      "Eve must see Free on Bob's install — anti-hijack",
    ).toBe("free");
  });

  it("REPRODUCES the user's bug: sign up → redeem license → scan must return user's tier (NOT Free)", async () => {
    // This is the founder's exact scenario from their screenshot:
    //   - Signed in as test-dev@example.com
    //   - Clicked LINK TO MY EXTENSION → redeemed Lifetime licence
    //   - /account.html shows "✓ Linked" + CURRENT TIER: Lifetime
    //   - Overlay STILL shows FREE
    //
    // Cause: redeemLicense() in api/_lib/license.ts writes
    // user:<install>:tier but does NOT write account:install:<install>
    // = email. So even after a successful redeem the install→email
    // binding is missing, and resolveTierAndBypass returns Free
    // because session email ≠ bound email (no bound email at all).

    // Sign up
    const signup = mockRes();
    await dispatcher(
      mockReq({
        method: "POST",
        action: "signup",
        headers: { origin: ORIGIN },
        body: { email: "alice@example.com", password: "supersecret1" },
      }),
      signup.res,
    );
    const sessionJwt = extractTokenFromCookie(signup.setCookie()!);

    // Issue + redeem a Lifetime licence (mimics LINK TO MY EXTENSION
    // button — auto-redeem of an unredeemed licence).
    const { issueLicense, redeemLicense } = await import("../api/_lib/license");
    const redis = new Redis({ url: "x", token: "y" });
    const license = await issueLicense(redis, {
      email: "alice@example.com",
      tier: "yearly",
      intentReference: "test-intent-1",
      amountUsd: 149.99,
    });
    const redeemResult = await redeemLicense(redis, license.key, VALID_INSTALL);
    expect(redeemResult.ok).toBe(true);

    // Tier IS set on the install (redeem worked) — this is what
    // /account.html sees + reports as "CURRENT TIER".
    expect(mocks.store.get(`user:${VALID_INSTALL}:tier`)).toBe("yearly");

    // Now the extension scans with the session token. This is what
    // the OVERLAY sees. Founder rule: it MUST return Yearly (tier the
    // user paid for), not Free.
    const scanReq = mockReq({
      method: "GET",
      headers: {
        origin: "chrome-extension://fakeextensionid",
        "x-antares-session": sessionJwt,
        "x-antares-install": VALID_INSTALL,
      },
    });
    const result = await resolveTierAndBypass(scanReq, VALID_INSTALL);
    expect(
      result.tier,
      "After redeem the overlay must show the user's tier — currently it returns Free because redeemLicense doesn't write account:install:<id>",
    ).toBe("yearly");
  });

  it("scan call uses session token from header (cookie-free path) — what the extension actually does", async () => {
    // The extension can't carry the cookie cross-origin reliably; it
    // sends X-Antares-Session: <jwt> instead. This test exercises
    // exactly that path.
    const signup = mockRes();
    await dispatcher(
      mockReq({
        method: "POST",
        action: "signup",
        headers: { origin: ORIGIN },
        body: { email: "alice@example.com", password: "supersecret1" },
      }),
      signup.res,
    );
    const sessionJwt = extractTokenFromCookie(signup.setCookie()!);

    await setUserTier(VALID_INSTALL, "yearly", Date.now() + 365 * 24 * 60 * 60 * 1000);

    // sync-token (with cookie) → auto-bind + JWT
    const syncTokenRes = mockRes();
    await dispatcher(
      mockReq({
        method: "POST",
        action: "sync-token",
        headers: {
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE_NAME}=${sessionJwt}`,
          "x-antares-install": VALID_INSTALL,
        },
      }),
      syncTokenRes.res,
    );
    const { token } = syncTokenRes.json() as { token: string };

    // Scan request from the extension: NO cookie, just the header.
    const scanReq = mockReq({
      method: "GET",
      headers: {
        origin: "chrome-extension://fakeextensionid",
        "x-antares-session": token,
        "x-antares-install": VALID_INSTALL,
      },
    });
    const result = await resolveTierAndBypass(scanReq, VALID_INSTALL);
    expect(result.tier).toBe("yearly");
  });
});
