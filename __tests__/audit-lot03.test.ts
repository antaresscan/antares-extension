// __tests__/audit-lot03.test.ts — Lot 3 of the file-by-file audit (2026-10-17): account.ts (account-erasure.ts: nothing changed).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logged: Array<{ level: string; module: string; message: string; data?: Record<string, unknown> }> = [];
vi.mock("../api/_lib/logger", () => ({
  logger: {
    info: (module: string, message: string, data?: Record<string, unknown>) => logged.push({ level: "info", module, message, data }),
    warn: (module: string, message: string, data?: Record<string, unknown>) => logged.push({ level: "warn", module, message, data }),
    error: (module: string, message: string, data?: Record<string, unknown>) => logged.push({ level: "error", module, message, data }),
    metric: vi.fn(),
  },
}));

import {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
  revokeAllSessions,
  ensureDevLifetimeLicense,
  ensureDevProLicense,
  signSession,
  _resetSessionSecretCacheForTests,
} from "../api/_lib/account";
import { ACCOUNT_KEY } from "../api/_lib/keys";
import { scrubObject } from "../shared/sentry-scrub";

beforeEach(() => {
  logged.length = 0;
});

describe("account.ts — password hashing off the event loop", () => {
  it("hashPasswordAsync and hashPassword write the same format, and each verifies the other's hash", async () => {
    const a = await hashPasswordAsync("correct horse battery");
    const s = hashPassword("correct horse battery");
    expect(a).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPasswordAsync("correct horse battery", s)).toBe(true);
    expect(await verifyPasswordAsync("wrong horse battery", a)).toBe(false);
  });

  it("the async check lets other work run while it hashes (the sync one held the event loop for the whole scrypt)", async () => {
    const h = hashPassword("correct horse battery");
    let otherWorkRanBeforeTheEnd = false;
    let done = false;
    const check = verifyPasswordAsync("correct horse battery", h).then((ok) => { done = true; return ok; });
    setImmediate(() => { otherWorkRanBeforeTheEnd = !done; });
    expect(await check).toBe(true);
    expect(otherWorkRanBeforeTheEnd).toBe(true);
  });

  it("refuses a password longer than any password we can hold, before hashing it (it could never match)", async () => {
    const h = hashPassword("correct horse battery");
    const huge = "x".repeat(257);
    expect(verifyPassword(huge, h)).toBe(false);
    expect(await verifyPasswordAsync(huge, h)).toBe(false);
  });

  it("a malformed stored hash is no match, never an exception", async () => {
    for (const stored of ["", "scrypt$$", "scrypt$zz$zz", "bcrypt$a$b", `scrypt$$${"00".repeat(64)}`]) {
      expect(verifyPassword("whatever123", stored)).toBe(false);
      expect(await verifyPasswordAsync("whatever123", stored)).toBe(false);
    }
  });
});

describe("account.ts — revokeAllSessions", () => {
  it("an account erased between the check and the increment leaves no orphan hash behind (HINCRBY would have created one)", async () => {
    const store = new Map<string, Record<string, string>>();
    store.set(ACCOUNT_KEY("alice@example.com"), { email: "alice@example.com", sessionVersion: "1" });
    const redis = {
      hget: vi.fn(async (k: string, f: string) => store.get(k)?.[f] ?? null),
      hincrby: vi.fn(async (k: string, f: string, by: number) => {
        store.delete(k); // the account is erased by a concurrent "delete my account" right now
        const h = store.get(k) ?? {};
        h[f] = String(Number(h[f] ?? 0) + by);
        store.set(k, h); // what HINCRBY really does on a missing key: a new hash with only the counter
        return Number(h[f]);
      }),
      del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    };
    expect(await revokeAllSessions(redis as never, "alice@example.com")).toBeNull();
    expect(store.has(ACCOUNT_KEY("alice@example.com"))).toBe(false);
  });
});

describe("account.ts — what the dev grants write in the logs", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("never the e-mail, not even inside the grant's reference", async () => {
    process.env.DEV_LIFETIME_EMAILS = "dev@example.com";
    process.env.DEV_PRO_EMAILS = "dev@example.com";
    const store = new Map<string, unknown>();
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean }) => {
        if (opts?.nx && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      }),
      del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
      hset: vi.fn(async (k: string, fields: Record<string, string>) => { store.set(k, { ...(store.get(k) as object ?? {}), ...fields }); return 1; }),
      hgetall: vi.fn(async (k: string) => store.get(k) ?? null),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => []),
      multi: () => {
        const ops: Array<() => Promise<unknown>> = [];
        const tx = {
          hset: (k: string, f: Record<string, string>) => { ops.push(() => redis.hset(k, f)); return tx; },
          sadd: () => { ops.push(async () => 1); return tx; },
          set: (k: string, v: unknown) => { ops.push(() => redis.set(k, v)); return tx; },
          exec: async () => Promise.all(ops.map((o) => o())),
        };
        return tx;
      },
    };
    await ensureDevLifetimeLicense(redis as never, "dev@example.com");
    await ensureDevProLicense(redis as never, "dev@example.com");
    const grants = logged.filter((l) => /dev-(yearly|pro) (ensured|issuance failed)/.test(l.message));
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(JSON.stringify(g.data)).not.toContain("dev@example.com");
  });
});

describe("account.ts — a SESSION_SECRET that is set but too short is named as such", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    _resetSessionSecretCacheForTests();
  });

  it("says 'set but N characters', not 'not set'", () => {
    process.env.SESSION_SECRET = "short-secret";
    process.env.UPSTASH_REDIS_REST_TOKEN = "t".repeat(40);
    _resetSessionSecretCacheForTests();
    signSession("a@example.com");
    const w = logged.find((l) => l.level === "warn" && l.module === "auth");
    expect(w?.message).toContain("SESSION_SECRET is set but has 12 characters");
  });
});

describe("Sentry — the install id header is scrubbed (it opens /api/history and names the install a deletion erases)", () => {
  it("X-Antares-Install is replaced, a context field install_id stays readable (pinned decision)", () => {
    expect(scrubObject({ "X-Antares-Install": "uuid-1", install_id: "uuid-1" })).toEqual({ "X-Antares-Install": "[scrubbed]", install_id: "uuid-1" });
  });
});
