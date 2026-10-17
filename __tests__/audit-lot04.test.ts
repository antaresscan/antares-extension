// __tests__/audit-lot04.test.ts — Lot 4 of the file-by-file audit (2026-10-17): login-guard.ts, email-verify.ts, mailer.ts
// (session-cookie.ts: a comment; email-proof.ts, mail-templates.ts, verify.html: nothing to fix). Each test fails on the previous code.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), metric: vi.fn() } }));

import { checkLoginLock, LOGIN_MAX_FAILURES } from "../api/_lib/login-guard";
import { confirmEmail, signVerifyToken, parseVerifyToken } from "../api/_lib/email-verify";
import { hashPassword } from "../api/_lib/account";
import { ACCOUNT_KEY } from "../api/_lib/keys";
import { sendMail } from "../api/_lib/mailer";

/** A Redis that answers like Upstash over the network: every command takes a little while (so concurrent callers interleave). */
function slowRedis() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  const tick = () => new Promise((r) => setTimeout(r, 1));
  return {
    store,
    incr: vi.fn(async (k: string) => { await tick(); const n = Number(store.get(k) ?? 0) + 1; store.set(k, n); return n; }),
    expire: vi.fn(async (k: string, s: number) => { await tick(); ttls.set(k, s); return 1; }),
    ttl: vi.fn(async (k: string) => { await tick(); return ttls.get(k) ?? -1; }),
    get: vi.fn(async (k: string) => { await tick(); return store.get(k) ?? null; }),
    del: vi.fn(async (k: string) => { await tick(); return store.delete(k) ? 1 : 0; }),
    pipeline() {
      const q: Array<() => Promise<unknown>> = [];
      const p = {
        get: (k: string) => { q.push(() => this.get(k)); return p; },
        ttl: (k: string) => { q.push(() => this.ttl(k)); return p; },
        exec: async () => { const out: unknown[] = []; for (const f of q) out.push(await f()); return out; },
      };
      return p;
    },
  };
}

describe("login-guard.ts — concurrent guesses", () => {
  it("30 guesses fired at once on one account: at most 10 reach the password check (they all did: the count was read before any was recorded)", async () => {
    const redis = slowRedis();
    let passwordChecks = 0;
    // What a password form does: ask the lock, then check the password (~50 ms of scrypt), then (old code) record the failure.
    const attempt = async () => {
      const lock = await checkLoginLock(redis as never, "alice@example.com");
      if (lock.locked) return "429";
      passwordChecks++;
      await new Promise((r) => setTimeout(r, 20)); // the password check
      return "401";
    };
    const answers = await Promise.all(Array.from({ length: 30 }, attempt));
    expect(passwordChecks).toBeLessThanOrEqual(LOGIN_MAX_FAILURES);
    expect(answers.filter((a) => a === "429").length).toBeGreaterThanOrEqual(30 - LOGIN_MAX_FAILURES);
  });
});

describe("email-verify.ts — confirming does not hold the event loop", () => {
  it("other work runs while the password of a confirmation is checked (the synchronous scrypt held it for ~50 ms)", async () => {
    const email = "bob@example.com";
    const fields: Record<string, string> = {
      id: "x", email, passwordHash: hashPassword("a-long-enough-password"), createdAt: String(Date.now()),
      emailVerified: "0", sessionVersion: "1", verifyNonce: "n" + "a".repeat(32), verifySentAt: "0",
    };
    const redis = {
      hgetall: vi.fn(async () => ({ ...fields })),
      multi: () => {
        const tx = { hset: () => tx, hdel: () => tx, persist: () => tx, exec: async () => [] };
        return tx;
      },
    };
    process.env.SESSION_SECRET = "s".repeat(64);
    const parsed = parseVerifyToken(signVerifyToken(email, fields.verifyNonce));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    let ranMeanwhile = false;
    let done = false;
    const p = confirmEmail(redis as never, parsed, "a-long-enough-password").then((r) => { done = true; return r; });
    setImmediate(() => { ranMeanwhile = !done; });
    expect((await p).ok).toBe(true);
    expect(ranMeanwhile).toBe(true);
    expect(ACCOUNT_KEY(email)).toBe("account:bob@example.com");
  });
});

describe("mailer.ts — the answer of Resend is not left hanging", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
  });

  it("cancels the body it does not read, so the connection goes back to the pool", async () => {
    process.env.RESEND_API_KEY = "re_test";
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    expect(await sendMail({ to: "a@b.co", subject: "s", text: "t", html: "<p>t</p>" })).toEqual({ ok: true });
    expect(cancelled).toBe(true);
  });
});
