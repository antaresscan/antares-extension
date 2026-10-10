// __tests__/preview-isolation.test.ts
//
// A Vercel PREVIEW deployment (a pull request's deployment, the one the e2e tests) shares the Upstash database with
// production. These tests pin the isolation: a preview neither READS what production cached (its e2e would then test
// production's code, not the pull request's) nor WRITES into production's cache (a broken pull request would serve
// wrong verdicts to real users). Production, a local run and the unit tests keep exactly the keys they always had.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";
import { isPreviewDeployment, deploymentNamespace } from "../api/_lib/deployment";
import { cacheKey, lockKey, initCache, getCachedResult, setCachedResult, setShortCachedResult, acquireScanLock, releaseScanLock } from "../api/_lib/cache";
import { ENGINE_VERSION, INSIDER_GRAPH_CACHE_PREFIX } from "../api/_lib/constants";
import { buildInsiderActivity, initActivityCache } from "../api/_lib/insider-activity";
import { buildInsiderGraph, initGraphCache } from "../api/_lib/insider-graph";

const CA = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

/** A Redis double that records every key it is asked for and honours SET NX. */
function fakeRedis() {
  const store = new Map<string, unknown>();
  const reads: string[] = [];
  const writes: string[] = [];
  const redis = {
    get: async (k: string) => { reads.push(k); return store.get(k) ?? null; },
    setex: async (k: string, _ttl: number, v: unknown) => { writes.push(k); store.set(k, v); return "OK"; },
    set: async (k: string, v: unknown, opts?: { nx?: boolean }) => { if (opts?.nx && store.has(k)) return null; writes.push(k); store.set(k, v); return "OK"; },
    del: async (k: string) => { store.delete(k); return 1; },
  } as unknown as Redis;
  return { redis, store, reads, writes };
}

const asPreview = (id = "dpl_AAA") => { vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL_DEPLOYMENT_ID", id); };
const asProduction = () => { vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_PROD"); };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  initCache(null as unknown as Redis);
  initActivityCache(null);
  initGraphCache(null as unknown as Redis);
});

describe("deploymentNamespace", () => {
  it("is empty in production, in development and when VERCEL_ENV is unset (a local run, the unit tests)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(deploymentNamespace()).toBe("");
    vi.stubEnv("VERCEL_ENV", "development");
    expect(deploymentNamespace()).toBe("");
    vi.stubEnv("VERCEL_ENV", "");
    expect(deploymentNamespace()).toBe("");
    expect([isPreviewDeployment()]).toEqual([false]);
  });

  it("is one namespace per preview deployment", () => {
    asPreview("dpl_AAA");
    const a = deploymentNamespace();
    asPreview("dpl_BBB");
    const b = deploymentNamespace();
    expect(isPreviewDeployment()).toBe(true);
    expect(a).toBe("pv:dpl_AAA:");
    expect(b).toBe("pv:dpl_BBB:");
    expect(a).not.toBe(b);
  });

  it("falls back to the commit, then to a fixed tag, and strips anything that is not a safe key character", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "3c01fdb");
    expect(deploymentNamespace()).toBe("pv:3c01fdb:");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    expect(deploymentNamespace()).toBe("pv:unknown:");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_a:b c*d\n");
    expect(deploymentNamespace()).toBe("pv:dpl_abcd:");
  });
});

describe("scan cache keys", () => {
  it("production keys are exactly the ones production always used", () => {
    asProduction();
    expect(cacheKey(CA)).toBe(`antares:${ENGINE_VERSION}:${CA}`);
    expect(lockKey(CA)).toBe(`antares:lock:${ENGINE_VERSION}:${CA}`);
    vi.unstubAllEnvs();
    expect(cacheKey(CA)).toBe(`antares:${ENGINE_VERSION}:${CA}`);
  });

  it("a preview's keys carry its deployment namespace, for the cache and for the lock", () => {
    asPreview("dpl_AAA");
    expect(cacheKey(CA)).toBe(`antares:pv:dpl_AAA:${ENGINE_VERSION}:${CA}`);
    expect(lockKey(CA)).toBe(`antares:lock:pv:dpl_AAA:${ENGINE_VERSION}:${CA}`);
  });
});

describe("a preview and production never see each other's scans", () => {
  it("a preview does NOT read what production cached (its e2e must run the pull request's code)", async () => {
    const f = fakeRedis();
    initCache(f.redis);
    asProduction();
    setCachedResult(CA, { risk: "SAFE", from: "production" }, 100_000, "SAFE");
    await Promise.resolve();
    asPreview("dpl_AAA");
    expect(await getCachedResult(CA, "r1")).toBeNull();
  });

  it("a preview does NOT write where production reads (a broken pull request cannot serve users a wrong verdict)", async () => {
    const f = fakeRedis();
    initCache(f.redis);
    asPreview("dpl_AAA");
    setCachedResult(CA, { risk: "RUG", from: "preview" }, 100_000, "RUG");
    setShortCachedResult(CA, { risk: "RUG", from: "preview" }, 30);
    await Promise.resolve();
    expect(f.writes.length).toBeGreaterThan(0);
    expect(f.writes.every((k) => k.includes("pv:dpl_AAA:"))).toBe(true);
    asProduction();
    expect(await getCachedResult(CA, "r2")).toBeNull();
  });

  it("a preview reads its own entries, and another preview does not", async () => {
    const f = fakeRedis();
    initCache(f.redis);
    asPreview("dpl_AAA");
    setCachedResult(CA, { risk: "SAFE", from: "A" }, 100_000, "SAFE");
    await Promise.resolve();
    expect(await getCachedResult(CA, "r3")).toEqual({ risk: "SAFE", from: "A" });
    asPreview("dpl_BBB");
    expect(await getCachedResult(CA, "r4")).toBeNull();
  });

  it("the single-flight lock is namespaced too: a lock held by production does not make a preview wait", async () => {
    const f = fakeRedis();
    initCache(f.redis);
    asProduction();
    expect(await acquireScanLock(CA)).toBe(true);   // production holds the lock
    asPreview("dpl_AAA");
    expect(await acquireScanLock(CA)).toBe(true);   // the preview is not blocked by it...
    expect(await acquireScanLock(CA)).toBe(false);  // ...and has its own lock
    await releaseScanLock(CA);
    expect(await acquireScanLock(CA)).toBe(true);
    asProduction();
    expect(await acquireScanLock(CA)).toBe(false);  // production's lock was untouched by the preview's release
  });
});

describe("derived caches (holder activity, insider graph)", () => {
  it("holder activity: production key unchanged, preview key namespaced", async () => {
    const f = fakeRedis();
    initActivityCache(f.redis);
    asProduction();
    await buildInsiderActivity(CA, [], 1_000_000, 0.5, "k");
    asPreview("dpl_AAA");
    await buildInsiderActivity(CA, [], 1_000_000, 0.5, "k");
    expect(f.reads).toContain(`iact:${CA}`);
    expect(f.reads).toContain(`pv:dpl_AAA:iact:${CA}`);
  });

  it("holder activity: the per-wallet signature cache is namespaced too (a preview never reads production's, nor writes into it)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in unit tests")));
    const f = fakeRedis();
    f.store.set("pv:dpl_AAA:iasig:WALLET1", []); // a signature list cached by THIS preview
    f.store.set("iasig:WALLET1", []);            // and one cached by production
    initActivityCache(f.redis);
    asPreview("dpl_AAA");
    await buildInsiderActivity(CA, [{ owner: "WALLET1", uiAmount: 100 }], 1_000_000, 0.5, "k");
    expect(f.reads).toContain("pv:dpl_AAA:iasig:WALLET1");
    expect(f.reads).not.toContain("iasig:WALLET1");
    expect(f.writes.every((k) => k.startsWith("pv:dpl_AAA:"))).toBe(true);
  });

  it("insider graph: production key unchanged, preview key namespaced", async () => {
    const f = fakeRedis();
    initGraphCache(f.redis);
    asProduction();
    await buildInsiderGraph(CA, [], 100000, "k", new Set());
    asPreview("dpl_AAA");
    await buildInsiderGraph(CA, [], 100000, "k", new Set());
    expect(f.reads).toContain(`${INSIDER_GRAPH_CACHE_PREFIX}${CA}`);
    expect(f.reads).toContain(`pv:dpl_AAA:${INSIDER_GRAPH_CACHE_PREFIX}${CA}`);
  });
});
