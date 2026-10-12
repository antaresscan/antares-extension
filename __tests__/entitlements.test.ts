import { describe, it, expect, vi } from "vitest";
import { decideTier, isPaidTier, parseDevTier, type SessionFact, type Tier, type TierFacts } from "../api/_lib/entitlements";

// The table of api/_lib/entitlements.ts, row by row. The facts are plain functions here, so no Redis, no session, no environment: and a
// test can say which facts a row read, which is the cost of a scan (every Redis read is a command on a metered plan).

const EMAIL = "owner@example.com";
const OTHER = "someone-else@example.com";

// What a test can set: the plain facts, and the answers the functions give (session, bound e-mail, licence tier, stored tier).
type Options = Omit<Partial<TierFacts>, "session" | "boundEmail" | "licenseTier" | "installTier"> & { session?: SessionFact; bound?: string | null; license?: Tier; stored?: Tier };

function facts(over: Options = {}) {
  const calls = { session: vi.fn(), boundEmail: vi.fn(), licenseTier: vi.fn(), installTier: vi.fn() };
  const session = over.session ?? { kind: "email" as const, email: EMAIL };
  const f: TierFacts = {
    devInstall: false,
    devTier: null,
    storageAvailable: true,
    isDevEmail: () => false,
    ...over,
    session: async () => { calls.session(); return session; },
    boundEmail: async () => { calls.boundEmail(); return over.bound ?? null; },
    licenseTier: async (email: string) => { calls.licenseTier(email); return over.license ?? "free"; },
    installTier: async () => { calls.installTier(); return over.stored ?? "free"; },
  };
  return { f, calls };
}

describe("row 1: a dev install", () => {
  it("is Yearly with no header, and bypasses the quota", async () => {
    const { f } = facts({ devInstall: true });
    expect(await decideTier(f)).toEqual({ tier: "yearly", bypassQuota: true, reason: "dev-install" });
  });

  it("is the tier the header names", async () => {
    for (const t of ["free", "pro", "yearly", "lifetime"] as Tier[]) {
      const { f } = facts({ devInstall: true, devTier: t });
      expect((await decideTier(f)).tier).toBe(t);
    }
  });

  it("reads nothing: no storage, no session, no licence", async () => {
    const { f, calls } = facts({ devInstall: true, storageAvailable: false });
    await decideTier(f);
    expect(calls.session).not.toHaveBeenCalled();
    expect(calls.licenseTier).not.toHaveBeenCalled();
  });
});

describe("rows 2 to 4: nothing proves who the caller is", () => {
  it("2. without storage the caller is Free, and nothing is read", async () => {
    const { f, calls } = facts({ storageAvailable: false, license: "lifetime" });
    expect(await decideTier(f)).toEqual({ tier: "free", bypassQuota: false, reason: "no-storage" });
    expect(calls.session).not.toHaveBeenCalled();
  });

  it("3. a session that cannot be read is Free, with the error kept for the logs", async () => {
    const { f, calls } = facts({ session: { kind: "error", name: "TypeError", message: "boom" }, license: "lifetime" });
    expect(await decideTier(f)).toEqual({ tier: "free", bypassQuota: false, reason: "session-error", error: { name: "TypeError", message: "boom" } });
    expect(calls.licenseTier).not.toHaveBeenCalled();
  });

  it("4. no session is Free, even for a paying customer: logging out means Free", async () => {
    const { f, calls } = facts({ session: { kind: "none" }, license: "lifetime", stored: "lifetime", bound: EMAIL });
    expect(await decideTier(f)).toEqual({ tier: "free", bypassQuota: false, reason: "no-session" });
    expect(calls.boundEmail).not.toHaveBeenCalled();
    expect(calls.licenseTier).not.toHaveBeenCalled();
    expect(calls.installTier).not.toHaveBeenCalled();
  });
});

describe("row 5: a dev e-mail can test with the tier it names", () => {
  it("takes the tier of the header, bypasses the quota, and does not look for a licence", async () => {
    const { f, calls } = facts({ isDevEmail: (e) => e === EMAIL, devTier: "free", license: "lifetime" });
    const d = await decideTier(f);
    expect(d).toMatchObject({ tier: "free", bypassQuota: true, reason: "dev-header", sessionEmail: EMAIL });
    expect(calls.licenseTier).not.toHaveBeenCalled();
  });

  it("witness: the header means nothing for an e-mail that is not a dev e-mail", async () => {
    const { f } = facts({ devTier: "lifetime", license: "pro" });
    expect(await decideTier(f)).toMatchObject({ tier: "pro", reason: "license" });
  });

  it("witness: a dev e-mail with no header (or a header naming no tier) falls through to its licence", async () => {
    const { f } = facts({ isDevEmail: () => true, devTier: null, license: "yearly" });
    expect(await decideTier(f)).toMatchObject({ tier: "yearly", bypassQuota: true, reason: "license" });
  });
});

describe("row 6: a licence owned by the e-mail", () => {
  it.each(["pro", "yearly", "lifetime"] as Tier[])("gives %s, and the stored tier of the install is not read", async (t) => {
    const { f, calls } = facts({ license: t });
    expect(await decideTier(f)).toMatchObject({ tier: t, bypassQuota: false, reason: "license" });
    expect(calls.installTier).not.toHaveBeenCalled();
    expect(calls.licenseTier).toHaveBeenCalledWith(EMAIL);
  });

  it("bypasses the quota only for a dev e-mail", async () => {
    const { f } = facts({ license: "pro", isDevEmail: () => true });
    expect((await decideTier(f)).bypassQuota).toBe(true);
  });

  it("beats a binding to another e-mail: what you paid with your own e-mail follows you to any install", async () => {
    const { f } = facts({ license: "yearly", bound: OTHER });
    expect(await decideTier(f)).toMatchObject({ tier: "yearly", reason: "license" });
  });
});

describe("rows 7 and 8: the install", () => {
  it("7. an install bound to ANOTHER e-mail is Free: nobody inherits what someone else paid on it", async () => {
    const { f, calls } = facts({ bound: OTHER, stored: "lifetime" });
    expect(await decideTier(f)).toMatchObject({ tier: "free", bypassQuota: false, reason: "install-bound-elsewhere", boundEmail: OTHER });
    expect(calls.installTier).not.toHaveBeenCalled();
  });

  it.each(["free", "pro", "yearly", "lifetime"] as Tier[])("8. an install bound to THIS e-mail gives the tier stored on it (%s)", async (t) => {
    const { f } = facts({ bound: EMAIL, stored: t });
    expect(await decideTier(f)).toMatchObject({ tier: t, reason: "install-stored" });
  });

  it("8. bypasses the quota for a dev e-mail", async () => {
    const { f } = facts({ bound: EMAIL, stored: "free", isDevEmail: () => true });
    expect((await decideTier(f)).bypassQuota).toBe(true);
  });
});

describe("row 9: a session, no licence, no binding", () => {
  it("is Free", async () => {
    const { f, calls } = facts();
    expect(await decideTier(f)).toMatchObject({ tier: "free", bypassQuota: false, reason: "no-license-no-binding" });
    expect(calls.installTier).not.toHaveBeenCalled();
  });
});

describe("what each row reads, in order (the cost of a scan)", () => {
  it("a signed-in caller reads the session once, the binding once, then the licence: nothing else when the licence decides", async () => {
    const { f, calls } = facts({ license: "pro" });
    await decideTier(f);
    expect(calls.session).toHaveBeenCalledTimes(1);
    expect(calls.boundEmail).toHaveBeenCalledTimes(1);
    expect(calls.licenseTier).toHaveBeenCalledTimes(1);
    expect(calls.installTier).not.toHaveBeenCalled();
  });

  it("the stored tier of the install is read only for an install bound to the caller", async () => {
    const bound = facts({ bound: EMAIL });
    await decideTier(bound.f);
    expect(bound.calls.installTier).toHaveBeenCalledTimes(1);
    const unbound = facts({ bound: null });
    await decideTier(unbound.f);
    expect(unbound.calls.installTier).not.toHaveBeenCalled();
  });
});

describe("parseDevTier", () => {
  it("reads a tier whatever its case or spaces, and the first value of a repeated header", () => {
    expect(parseDevTier(" PRO ")).toBe("pro");
    expect(parseDevTier("Lifetime")).toBe("lifetime");
    expect(parseDevTier(["yearly", "free"])).toBe("yearly");
  });

  it("names no tier for anything else", () => {
    for (const v of [undefined, null, "", "admin", "enterprise", [], ["bogus"]]) expect(parseDevTier(v as string | string[] | null | undefined), String(v)).toBeNull();
  });
});

describe("isPaidTier", () => {
  it("is the one definition of who sees the explanation of the verdict: everyone but Free", () => {
    expect(isPaidTier("free")).toBe(false);
    for (const t of ["pro", "yearly", "lifetime"] as Tier[]) expect(isPaidTier(t)).toBe(true);
  });
});
