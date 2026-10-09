// __tests__/http-auth-log.test.ts
//
// A 401/403 from an upstream means OUR credentials were refused. fetchJson and
// fetchJsonPost return null for every failure, which hid a month-long Helius
// outage. They now log the host and the status (never the URL, which can carry
// the key), at most once a minute per host and status, and fetchJsonPost
// reports every HTTP status to an optional callback.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const warn = vi.fn();
vi.mock("../api/_lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
  },
}));

import {
  fetchJson,
  fetchJsonPost,
  _resetAuthLogThrottleForTests,
  _resetCircuitBreakersForTests,
} from "../api/_lib/http";

const SECRET = "SECRET-KEY-123";
const URL_WITH_KEY = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;

function stubFetch(status: number, body: unknown = {}) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const authLogs = () =>
  warn.mock.calls.filter((c) => c[1] === "upstream rejected our credentials");

beforeEach(() => {
  warn.mockReset();
  _resetAuthLogThrottleForTests();
  _resetCircuitBreakersForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJsonPost — status callback", () => {
  it("reports the HTTP status of a refused call and still returns null", async () => {
    stubFetch(401);
    const onStatus = vi.fn();

    const res = await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0, {}, onStatus);

    expect(res).toBeNull();
    expect(onStatus).toHaveBeenCalledWith(401);
  });

  it("reports 200 too, and returns the parsed body", async () => {
    stubFetch(200, { result: 1 });
    const onStatus = vi.fn();

    expect(await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0, {}, onStatus)).toEqual({ result: 1 });
    expect(onStatus).toHaveBeenCalledWith(200);
  });

  it("works without a callback (existing callers)", async () => {
    stubFetch(200, { ok: true });
    expect(await fetchJsonPost(URL_WITH_KEY, {})).toEqual({ ok: true });
  });
});

describe("401/403 are logged, safely", () => {
  it.each([401, 403])("logs host and status for a %i, and never the key or the URL", async (status) => {
    stubFetch(status);

    await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0);

    const logs = authLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe("http");
    expect(logs[0][2]).toEqual({ host: "mainnet.helius-rpc.com", status });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("api-key");
  });

  it("fetchJson (GET) logs a refusal too", async () => {
    stubFetch(401);

    await fetchJson(`https://api.helius.xyz/v0/x?api-key=${SECRET}`);

    expect(authLogs()).toHaveLength(1);
    expect(authLogs()[0][2]).toEqual({ host: "api.helius.xyz", status: 401 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("logs once a minute per host and status, so a dead key does not flood the logs", async () => {
    stubFetch(401);

    for (let i = 0; i < 5; i++) await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0);

    expect(authLogs()).toHaveLength(1);
  });

  it("a different status on the same host is logged separately", async () => {
    stubFetch(401);
    await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0);
    stubFetch(403);
    await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0);

    expect(authLogs()).toHaveLength(2);
  });

  it("a different host is logged separately", async () => {
    stubFetch(401);
    await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0);
    await fetchJsonPost("https://pro-api.solscan.io/v2.0/x", {}, 1000, 0);

    expect(authLogs()).toHaveLength(2);
  });

  it.each([404, 400, 500])("a %i is not an authentication problem and is not logged as one", async (status) => {
    stubFetch(status);

    await fetchJsonPost(URL_WITH_KEY, {}, 1000, 0);

    expect(authLogs()).toHaveLength(0);
  });
});

describe("fetchJson — status callback", () => {
  it("reports 401 so the caller can tell 'refused' from 'unknown', and still returns null", async () => {
    stubFetch(401);
    const onStatus = vi.fn();

    const res = await fetchJson("https://pro-api.solscan.io/v2.0/token/meta", {}, 1000, 0, onStatus);

    expect(res).toBeNull();
    expect(onStatus).toHaveBeenCalledWith(401);
  });

  it("reports 404 as 404 (an unknown token is a normal answer, not a refusal)", async () => {
    stubFetch(404);
    const onStatus = vi.fn();

    await fetchJson("https://pro-api.solscan.io/v2.0/token/meta", {}, 1000, 0, onStatus);

    expect(onStatus).toHaveBeenCalledWith(404);
    expect(onStatus).not.toHaveBeenCalledWith(401);
  });

  it("reports 200 and returns the parsed body", async () => {
    stubFetch(200, { data: { ok: true } });
    const onStatus = vi.fn();

    const res = await fetchJson("https://pro-api.solscan.io/v2.0/token/meta", {}, 1000, 0, onStatus);

    expect(res).toEqual({ data: { ok: true } });
    expect(onStatus).toHaveBeenCalledWith(200);
  });

  it("works unchanged without a callback", async () => {
    stubFetch(200, { a: 1 });
    expect(await fetchJson("https://pro-api.solscan.io/v2.0/x", {}, 1000, 0)).toEqual({ a: 1 });
  });
});
