import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  sets: new Map<string, Set<string>>(),
  /** key -> seconds, as set by EXPIRE (and cleared by PERSIST / DEL). */
  ttl: new Map<string, number>(),
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && mocks.store.has(k)) return null;
      mocks.store.set(k, v);
      if (opts?.ex) mocks.ttl.set(k, opts.ex);
      return "OK";
    });
    get = vi.fn(async (k: string) => mocks.store.get(k) ?? null);
    del = vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) { mocks.ttl.delete(k); if (mocks.store.delete(k)) n++; }
      return n;
    });
    expire = vi.fn(async (k: string, seconds: number) => { if (!mocks.store.has(k)) return 0; mocks.ttl.set(k, seconds); return 1; });
    persist = vi.fn(async (k: string) => (mocks.ttl.delete(k) ? 1 : 0));
    hdel = vi.fn(async (k: string, ...fields: string[]) => {
      const h = mocks.store.get(k) as Record<string, string> | undefined;
      if (!h) return 0;
      let n = 0;
      for (const f of fields) if (f in h) { delete h[f]; n++; }
      return n;
    });
    multi = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const tx = {
        hset: (k: string, f: Record<string, string>) => { queued.push(() => this.hset(k, f)); return tx; },
        expire: (k: string, sec: number) => { queued.push(() => this.expire(k, sec)); return tx; },
        exec: async () => { const out: unknown[] = []; for (const q of queued) out.push(await q()); return out; },
      };
      return tx;
    };
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
  _resetSessionSecretCacheForTests,
} from "../api/_lib/account";
import { PENDING_ACCOUNT_TTL_SECONDS } from "../api/_lib/email-proof";

beforeEach(() => {
  mocks.store.clear();
  mocks.sets.clear();
  mocks.ttl.clear();
  process.env.SESSION_SECRET = "0".repeat(64); // 64-char test secret
  // getSessionSecret is now memoised at module scope (fires the bootstrap
  // warn once per cold-start instead of once per request). Vitest reuses
  // the module across tests, so any test that swaps SESSION_SECRET mid-
  // run must reset the cache first or it keeps verifying with the stale
  // key.
  _resetSessionSecretCacheForTests();
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
    _resetSessionSecretCacheForTests();
    expect(() => signSession("user@example.com")).toThrow();
  });

  it("falls back to UPSTASH_REDIS_REST_TOKEN derivation when SESSION_SECRET is unset", () => {
    // Bootstrap path: deployment has Redis configured but operator
    // hasn't set SESSION_SECRET yet. Auth should still work.
    delete process.env.SESSION_SECRET;
    process.env.UPSTASH_REDIS_REST_TOKEN = "x".repeat(64);
    _resetSessionSecretCacheForTests();
    const token = signSession("bootstrap@example.com");
    const verified = verifySession(token);
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe("bootstrap@example.com");
  });

  it("explicit SESSION_SECRET takes precedence over Redis fallback", () => {
    process.env.SESSION_SECRET = "1".repeat(64);
    process.env.UPSTASH_REDIS_REST_TOKEN = "y".repeat(64);
    _resetSessionSecretCacheForTests();
    const tokenA = signSession("user@example.com");

    // Switch to fallback only — different key, shouldn't verify the
    // token issued under the explicit secret.
    delete process.env.SESSION_SECRET;
    _resetSessionSecretCacheForTests();
    expect(verifySession(tokenA)).toBeNull();
  });

  it("rotating SESSION_SECRET invalidates every session at once", () => {
    process.env.SESSION_SECRET = "a".repeat(64);
    _resetSessionSecretCacheForTests();
    const token = signSession("user@example.com");
    expect(verifySession(token)).not.toBeNull();
    process.env.SESSION_SECRET = "b".repeat(64);
    _resetSessionSecretCacheForTests();
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

  it("A-01: the new account is UNCONFIRMED, holds a confirmation secret that is never a bare number, and expires by itself after 48 h", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const out = await createAccount(redis, { email: "alice@example.com", password: "supersecret" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.account.emailVerified).toBe(false);
    expect(out.account.verifyNonce).toMatch(/^n[0-9a-f]{32}$/);
    expect(out.account.verifySentAt).toBe(0);
    const stored = mocks.store.get("account:alice@example.com") as Record<string, string>;
    expect(stored.emailVerified).toBe("0");
    expect(stored.verifyNonce).toBe(out.account.verifyNonce);
    expect(mocks.ttl.get("account:alice@example.com")).toBe(PENDING_ACCOUNT_TTL_SECONDS);
    expect(PENDING_ACCOUNT_TTL_SECONDS).toBe(48 * 3600);
  });

  it("A-01: two accounts never share a confirmation secret", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const a = await createAccount(redis, { email: "a@example.com", password: "supersecret" });
    const b = await createAccount(redis, { email: "b@example.com", password: "supersecret" });
    expect(a.ok && b.ok && a.account.verifyNonce !== b.account.verifyNonce).toBe(true);
  });

  it("A-01: the creation mutex is released afterwards (a sign-up that fails later can try again at once)", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await createAccount(redis, { email: "alice@example.com", password: "supersecret" });
    expect([...mocks.store.keys()].filter((k) => k.startsWith("account-create:"))).toEqual([]);
  });

  it("A-01: the mutex key names a hash of the address, never the address", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const seen: string[] = [];
    const real = (redis as unknown as { set: (k: string, ...r: unknown[]) => unknown }).set.bind(redis);
    (redis as unknown as { set: unknown }).set = (k: string, ...r: unknown[]) => { seen.push(k); return real(k, ...r); };
    await createAccount(redis, { email: "alice@example.com", password: "supersecret" });
    expect(seen.some((k) => /^account-create:[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(seen.some((k) => k.includes("alice"))).toBe(false);
  });

  it("A-01: a sign-up that arrives while another one for the same address is in flight creates nothing and is told the address is taken", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const { createHash } = await import("node:crypto");
    mocks.store.set(`account-create:${createHash("sha256").update("alice@example.com").digest("hex")}`, "1"); // the winner holds the mutex
    const out = await createAccount(redis, { email: "alice@example.com", password: "supersecret" });
    expect(out).toEqual({ ok: false, reason: "already_exists", existing: null });
    expect(mocks.store.has("account:alice@example.com")).toBe(false);
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
    expect(second).toMatchObject({ ok: false, reason: "already_exists" });
    // the second sign-up never replaces anything: the first password still opens the account (nobody can take an address between its owner's
    // sign-up and the click on the link)
    expect((await authenticate(redis, { email: "alice@example.com", password: "firstpass1" })).ok).toBe(true);
    expect((await authenticate(redis, { email: "alice@example.com", password: "secondpass1" })).ok).toBe(false);
    if (!second.ok && second.reason === "already_exists") expect(second.existing?.email).toBe("alice@example.com");
  });

  it("getAccount reads a confirmed account even when Redis hands back the NUMBER 1 (Upstash deserialises), and a numeric-looking nonce as text", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    mocks.store.set("account:alice@example.com", { id: "abc", email: "alice@example.com", passwordHash: "x", createdAt: 1_700_000_000_000, emailVerified: 1, sessionVersion: 5, verifyNonce: 12345, verifySentAt: 99 });
    const a = await getAccount(redis, "alice@example.com");
    expect(a?.emailVerified).toBe(true);
    expect(a?.verifyNonce).toBe("12345");
    expect(a?.verifySentAt).toBe(99);
    mocks.store.set("account:bob@example.com", { id: "abc", email: "bob@example.com", passwordHash: "x", createdAt: "1", emailVerified: "0" });
    const b = await getAccount(redis, "bob@example.com");
    expect(b?.emailVerified).toBe(false);
    expect(b?.verifyNonce).toBeUndefined();
    expect(b?.verifySentAt).toBe(0);
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
