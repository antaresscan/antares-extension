import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  sets: new Map<string, Set<string>>(),
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
    sadd = vi.fn(async (k: string, ...members: string[]) => {
      const set = mocks.sets.get(k) ?? new Set();
      members.forEach((m) => set.add(m));
      mocks.sets.set(k, set);
      return members.length;
    });
    smembers = vi.fn(async (k: string) =>
      Array.from(mocks.sets.get(k) ?? []),
    );
  }
  return { Redis: MockRedis };
});

import { Redis } from "@upstash/redis";
import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  createAccount,
  getAccount,
  authenticate,
  bindInstallToAccount,
  getAccountByInstall,
} from "../api/_lib/account";

beforeEach(() => {
  mocks.store.clear();
  mocks.sets.clear();
  process.env.SESSION_SECRET = "0".repeat(64); // 64-char test secret
});

describe("hashPassword + verifyPassword", () => {
  it("hashes and verifies a valid password", () => {
    const hash = hashPassword("hunter2hunter2");
    expect(hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(verifyPassword("hunter2hunter2", hash)).toBe(true);
  });

  it("rejects wrong passwords", () => {
    const hash = hashPassword("correct horse");
    expect(verifyPassword("wrong horse", hash)).toBe(false);
  });

  it("rejects passwords shorter than 8 chars at hash time", () => {
    expect(() => hashPassword("short")).toThrow();
    expect(() => hashPassword("")).toThrow();
  });

  it("rejects passwords longer than 256 chars at hash time", () => {
    expect(() => hashPassword("a".repeat(257))).toThrow();
  });

  it("rejects non-string inputs to verifyPassword", () => {
    expect(verifyPassword(null as unknown as string, "scrypt$ab$cd")).toBe(false);
    expect(verifyPassword("ok", null as unknown as string)).toBe(false);
  });

  it("returns false for malformed hash strings", () => {
    expect(verifyPassword("plaintext", "not-a-hash")).toBe(false);
    expect(verifyPassword("plaintext", "scrypt$badhex$badhex")).toBe(false);
    expect(verifyPassword("plaintext", "scrypt$aa$bb")).toBe(false); // wrong key length
  });
});

describe("signSession + verifySession", () => {
  it("round-trips a valid session token", () => {
    const token = signSession("user@example.com");
    const payload = verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user@example.com");
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a tampered signature", () => {
    const token = signSession("user@example.com");
    const tampered = token.slice(0, -2) + "XX";
    expect(verifySession(tampered)).toBeNull();
  });

  it("rejects a tampered payload (sig mismatch)", () => {
    const token = signSession("user@example.com");
    const parts = token.split(".");
    // Replace the payload with a forged one — signature won't match.
    const forged = Buffer.from(
      JSON.stringify({ sub: "attacker@evil.com", exp: 9999999999, iat: 0 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifySession(`${parts[0]}.${forged}.${parts[2]}`)).toBeNull();
  });

  it("rejects expired tokens", () => {
    // Sign with a past `now` so exp is in the past
    const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const token = signSession("user@example.com", past);
    expect(verifySession(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySession("")).toBeNull();
    expect(verifySession("not-a-jwt")).toBeNull();
    expect(verifySession("a.b")).toBeNull();
    expect(verifySession("a.b.c.d")).toBeNull();
  });

  it("rejects sessions when SESSION_SECRET is too short and no Redis fallback available", () => {
    process.env.SESSION_SECRET = "short";
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    expect(() => signSession("user@example.com")).toThrow();
  });

  it("falls back to UPSTASH_REDIS_REST_TOKEN derivation when SESSION_SECRET is unset", () => {
    // Bootstrap path: deployment has Redis configured but operator
    // hasn't set SESSION_SECRET yet. Auth should still work.
    delete process.env.SESSION_SECRET;
    process.env.UPSTASH_REDIS_REST_TOKEN = "x".repeat(64);
    const token = signSession("bootstrap@example.com");
    const verified = verifySession(token);
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe("bootstrap@example.com");
  });

  it("explicit SESSION_SECRET takes precedence over Redis fallback", () => {
    process.env.SESSION_SECRET = "1".repeat(64);
    process.env.UPSTASH_REDIS_REST_TOKEN = "y".repeat(64);
    const tokenA = signSession("user@example.com");

    // Switch to fallback only — different key, shouldn't verify the
    // token issued under the explicit secret.
    delete process.env.SESSION_SECRET;
    expect(verifySession(tokenA)).toBeNull();
  });

  it("rotating SESSION_SECRET invalidates every session at once", () => {
    process.env.SESSION_SECRET = "a".repeat(64);
    const token = signSession("user@example.com");
    expect(verifySession(token)).not.toBeNull();
    process.env.SESSION_SECRET = "b".repeat(64);
    expect(verifySession(token)).toBeNull();
  });
});

describe("createAccount + getAccount", () => {
  it("creates an account from email + password", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const out = await createAccount(redis, {
      email: "Alice@Example.com",
      password: "supersecret",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.account.email).toBe("alice@example.com"); // lowercased
    expect(out.account.id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.account.passwordHash).toMatch(/^scrypt\$/);
  });

  it("rejects invalid email", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const out = await createAccount(redis, {
      email: "not-an-email",
      password: "supersecret",
    });
    expect(out).toEqual({ ok: false, reason: "invalid_email" });
  });

  it("rejects weak password", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const out = await createAccount(redis, {
      email: "alice@example.com",
      password: "short",
    });
    expect(out).toEqual({ ok: false, reason: "weak_password" });
  });

  it("rejects duplicate email", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await createAccount(redis, {
      email: "alice@example.com",
      password: "firstpass1",
    });
    const second = await createAccount(redis, {
      email: "Alice@example.com", // case-insensitive duplicate
      password: "secondpass1",
    });
    expect(second).toEqual({ ok: false, reason: "already_exists" });
  });

  it("getAccount returns null for unknown email", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    expect(await getAccount(redis, "nobody@nowhere.com")).toBeNull();
  });

  it("getAccount returns the stored account", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await createAccount(redis, {
      email: "alice@example.com",
      password: "firstpass1",
    });
    const fetched = await getAccount(redis, "Alice@Example.COM");
    expect(fetched?.email).toBe("alice@example.com");
  });
});

describe("authenticate", () => {
  it("returns ok on correct credentials", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await createAccount(redis, {
      email: "alice@example.com",
      password: "firstpass1",
    });
    const out = await authenticate(redis, {
      email: "alice@example.com",
      password: "firstpass1",
    });
    expect(out.ok).toBe(true);
  });

  it("returns invalid_credentials on wrong password", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await createAccount(redis, {
      email: "alice@example.com",
      password: "firstpass1",
    });
    const out = await authenticate(redis, {
      email: "alice@example.com",
      password: "wrongpass",
    });
    expect(out).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("returns invalid_credentials on unknown email (no enumeration)", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const out = await authenticate(redis, {
      email: "nobody@nowhere.com",
      password: "anything",
    });
    expect(out).toEqual({ ok: false, reason: "invalid_credentials" });
  });
});

describe("bindInstallToAccount + getAccountByInstall", () => {
  it("binds an install_id to an account and looks it up", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await createAccount(redis, {
      email: "alice@example.com",
      password: "firstpass1",
    });
    await bindInstallToAccount(redis, "install-test-aaaaaaaaaaaa", "alice@example.com");
    const fetched = await getAccountByInstall(redis, "install-test-aaaaaaaaaaaa");
    expect(fetched?.email).toBe("alice@example.com");
  });

  it("returns null for unbound install", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    expect(await getAccountByInstall(redis, "install-test-zzzzzzzzzzzz")).toBeNull();
  });
});
