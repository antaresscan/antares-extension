// __tests__/helius.test.ts
//
// How the Helius key is sent. Production lost its holder data and nothing said
// why: the key went out as an `Authorization: Bearer` header (not described in
// Helius's docs, which show `?api-key=` only) and every refusal was swallowed as
// a silent null. heliusRpc starts with the documented `?api-key=` form, falls
// back to the Bearer header ONLY when Helius refuses the key, remembers the
// winner, and logs the refusal without ever writing the key.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetchJsonPost = vi.fn();
vi.mock("../api/_lib/http", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/http")>("../api/_lib/http");
  return { ...actual, fetchJsonPost: (...args: unknown[]) => mockFetchJsonPost(...args) };
});

const warn = vi.fn();
vi.mock("../api/_lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
  },
}));

import {
  heliusRpc,
  heliusRestUrl,
  getHeliusRpcAuthMode,
  getHeliusDiagnostics,
  normalizeHeliusKey,
  describeHeliusKey,
  _resetHeliusAuthForTests,
} from "../api/_lib/helius";
import { HELIUS_BASE } from "../api/_lib/constants";

const KEY = "SECRET-KEY-123";
const BODY = { jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: ["mint"] };
const QUERY_URL = `${HELIUS_BASE}/?api-key=${encodeURIComponent(KEY)}`;
const BEARER = { Authorization: `Bearer ${KEY}` };

type Call = [string, object, number, number, Record<string, string>, ((s: number) => void)?];

/** Queue one upstream answer: the HTTP status Helius gave, and the parsed body. */
function respond(status: number, json: unknown) {
  mockFetchJsonPost.mockImplementationOnce(async (...args: unknown[]) => {
    const onStatus = args[5] as ((s: number) => void) | undefined;
    if (status > 0) onStatus?.(status);
    return json;
  });
}

const callAt = (i: number) => mockFetchJsonPost.mock.calls[i] as Call;

beforeEach(() => {
  mockFetchJsonPost.mockReset();
  warn.mockReset();
  _resetHeliusAuthForTests();
});

describe("heliusRpc — documented ?api-key= form first", () => {
  it("returns the answer after a single request", async () => {
    respond(200, { result: { value: [] } });

    const res = await heliusRpc(KEY, BODY);

    expect(res).toEqual({ result: { value: [] } });
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
    const [url, , , , headers] = callAt(0);
    expect(url).toBe(QUERY_URL);
    expect(headers).toEqual({});
    expect(getHeliusRpcAuthMode()).toBe("query");
  });

  it("forwards the timeout and retry count it was given", async () => {
    respond(200, { result: 1 });
    await heliusRpc(KEY, BODY, 5000, 0);
    const [, , ms, retries] = callAt(0);
    expect(ms).toBe(5000);
    expect(retries).toBe(0);
  });
});

describe("heliusRpc — fallback to the Bearer header when the query form is refused", () => {
  it("retries once with the header on 401, then remembers it", async () => {
    respond(401, null);
    respond(200, { result: { value: [1] } });

    const res = await heliusRpc(KEY, BODY);

    expect(res).toEqual({ result: { value: [1] } });
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(2);
    const [secondUrl, , , , secondHeaders] = callAt(1);
    expect(secondUrl).toBe(HELIUS_BASE);
    expect(secondUrl).not.toContain("api-key");
    expect(secondHeaders).toEqual(BEARER);
    expect(getHeliusRpcAuthMode()).toBe("bearer");

    // The next call goes straight to the form that worked: one request, no probe.
    mockFetchJsonPost.mockClear();
    respond(200, { result: 2 });
    await heliusRpc(KEY, BODY);
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
    expect(callAt(0)[4]).toEqual(BEARER);
  });

  it("treats 403 like 401", async () => {
    respond(403, null);
    respond(200, { result: 1 });

    expect(await heliusRpc(KEY, BODY)).toEqual({ result: 1 });
    expect(getHeliusRpcAuthMode()).toBe("bearer");
  });

  it("falls back on an HTTP 200 whose JSON-RPC error names the key", async () => {
    respond(200, { jsonrpc: "2.0", error: { code: -32401, message: "Invalid API key" } });
    respond(200, { result: "ok" });

    expect(await heliusRpc(KEY, BODY)).toEqual({ result: "ok" });
    expect(getHeliusRpcAuthMode()).toBe("bearer");
  });

  it("switches back if the header form is later the one that gets refused", async () => {
    respond(401, null);
    respond(200, { result: 1 });
    await heliusRpc(KEY, BODY);
    expect(getHeliusRpcAuthMode()).toBe("bearer");

    respond(401, null); // header now refused
    respond(200, { result: 2 }); // query form works again
    expect(await heliusRpc(KEY, BODY)).toEqual({ result: 2 });
    expect(getHeliusRpcAuthMode()).toBe("query");
  });
});

describe("heliusRpc — no second request when the key is not the problem", () => {
  it.each([
    ["500 server error", 500, null],
    ["429 rate limit", 429, null],
    ["network error (no status)", 0, null],
  ])("%s", async (_label, status, json) => {
    respond(status, json);

    expect(await heliusRpc(KEY, BODY)).toBeNull();
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
    expect(getHeliusRpcAuthMode()).toBe("query");
  });

  it("an ordinary JSON-RPC error (bad params) is returned as is, with one request", async () => {
    const err = { jsonrpc: "2.0", error: { code: -32602, message: "Invalid param: not a Token mint" } };
    respond(200, err);

    expect(await heliusRpc(KEY, BODY)).toEqual(err);
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
  });

  it("an empty key makes no request at all", async () => {
    expect(await heliusRpc("", BODY)).toBeNull();
    expect(mockFetchJsonPost).not.toHaveBeenCalled();
  });
});

describe("heliusRpc — both forms refused", () => {
  it("returns null after exactly two requests and logs both statuses, never the key", async () => {
    respond(401, null);
    respond(403, null);

    expect(await heliusRpc(KEY, BODY)).toBeNull();

    expect(mockFetchJsonPost).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const [module, message, data] = warn.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(module).toBe("helius");
    expect(message).toMatch(/both ways/i);
    expect(data).toEqual({ query: 401, bearer: 403 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });

  it("the mode is left alone (still the default) when both are refused", async () => {
    respond(401, null);
    respond(401, null);
    await heliusRpc(KEY, BODY);
    expect(getHeliusRpcAuthMode()).toBe("query");
  });

  it("logs at most once a minute, so a dead key does not flood the logs", async () => {
    for (let i = 0; i < 3; i++) {
      respond(401, null);
      respond(401, null);
      await heliusRpc(KEY, BODY);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// getSignaturesForAddress (Insider Watch / Sniper Map) needs a `result` array.
// An earlier version of the activity feed got HTTP 200 without `result` in one
// form and silently rendered empty for every token.
describe("heliusRpc — usable check (HTTP 200 without what the caller needs)", () => {
  const usable = (r: { result?: unknown }) => Array.isArray(r.result);
  const SIGS = { result: [{ signature: "s1" }] };

  it("a usable first answer makes a single request", async () => {
    respond(200, SIGS);

    expect(await heliusRpc<{ result?: unknown }>(KEY, BODY, 5000, 1, { usable })).toEqual(SIGS);
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
  });

  it("an unusable 200 gets one retry in the other form, for this call only", async () => {
    respond(200, { jsonrpc: "2.0" });
    respond(200, SIGS);

    const res = await heliusRpc<{ result?: unknown }>(KEY, BODY, 5000, 1, { usable });

    expect(res).toEqual(SIGS);
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(2);
    expect(callAt(1)[4]).toEqual(BEARER);
    // The remembered mode is untouched: this was not an authentication refusal.
    expect(getHeliusRpcAuthMode()).toBe("query");
    expect(getHeliusDiagnostics().lastRpc).toMatchObject({ outcome: "ok", query: 200, bearer: 200 });
  });

  it("logs that case once a minute, without the key", async () => {
    for (let i = 0; i < 3; i++) {
      respond(200, { jsonrpc: "2.0" });
      respond(200, SIGS);
      await heliusRpc<{ result?: unknown }>(KEY, BODY, 5000, 1, { usable });
    }

    const logs = warn.mock.calls.filter((c) => /unusable/i.test(String(c[1])));
    expect(logs).toHaveLength(1);
    expect(logs[0][2]).toMatchObject({ method: "getTokenLargestAccounts", form: "query", status: 200 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });

  it("when both forms give an unusable answer, the first is returned and the key is NOT reported as refused", async () => {
    respond(200, { jsonrpc: "2.0" });
    respond(200, { jsonrpc: "2.0" });

    const res = await heliusRpc<{ result?: unknown }>(KEY, BODY, 5000, 1, { usable });

    expect(res).toEqual({ jsonrpc: "2.0" });
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(getHeliusDiagnostics().lastRpc).toMatchObject({ outcome: "failed" });
  });

  it("an authentication refusal still switches the remembered mode, with or without the check", async () => {
    respond(401, null);
    respond(200, SIGS);

    await heliusRpc<{ result?: unknown }>(KEY, BODY, 5000, 1, { usable });

    expect(getHeliusRpcAuthMode()).toBe("bearer");
  });

  it("without the check, a 200 lacking `result` is returned as is, with one request (other callers)", async () => {
    // getTokenAccounts puts `total` at the top level, so a missing `result` is
    // not an anomaly in general.
    respond(200, { total: 1234 });

    expect(await heliusRpc(KEY, BODY)).toEqual({ total: 1234 });
    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
  });
});

describe("heliusRestUrl — the Enhanced Transactions API only takes ?api-key=", () => {
  it("appends the key with ? when the path has no query", () => {
    expect(heliusRestUrl("/v0/transactions", KEY)).toBe(
      `https://api.helius.xyz/v0/transactions?api-key=${KEY}`,
    );
  });

  it("appends it with & when the path already has one", () => {
    expect(heliusRestUrl("/v0/addresses/abc/transactions?limit=200", KEY)).toBe(
      `https://api.helius.xyz/v0/addresses/abc/transactions?limit=200&api-key=${KEY}`,
    );
  });

  it("URL-encodes the key", () => {
    expect(heliusRestUrl("/v0/x", "a b&c")).toContain("api-key=a%20b%26c");
  });

  it("repairs a key pasted as a whole RPC URL", () => {
    expect(heliusRestUrl("/v0/x", `https://mainnet.helius-rpc.com/?api-key=${UUID}`)).toBe(
      `https://api.helius.xyz/v0/x?api-key=${UUID}`,
    );
  });
});

// ─── The key as pasted into Vercel ─────────────────────────────────────────
// Helius's "Connect" panel shows a full RPC URL, not the bare key, so the
// usual slips are the whole URL, a "Bearer " prefix, quotes, a stray space or
// newline. Each made every request fail with a swallowed 401.
const UUID = "8c739183-1a2b-4c3d-8e4f-0123456789ab";

describe("normalizeHeliusKey", () => {
  it.each([
    ["a bare UUID is left alone", UUID, UUID],
    ["a trailing newline", `${UUID}\n`, UUID],
    ["surrounding spaces", `  ${UUID}  `, UUID],
    ["double quotes", `"${UUID}"`, UUID],
    ["single quotes", `'${UUID}'`, UUID],
    ["a Bearer prefix", `Bearer ${UUID}`, UUID],
    ["the whole RPC URL", `https://mainnet.helius-rpc.com/?api-key=${UUID}`, UUID],
    ["the RPC URL with extra parameters", `https://mainnet.helius-rpc.com/?foo=1&api-key=${UUID}&bar=2`, UUID],
    ["the RPC URL, quoted and with a newline", `"https://mainnet.helius-rpc.com/?api-key=${UUID}"\r\n`, UUID],
  ])("%s", (_label, raw, expected) => {
    expect(normalizeHeliusKey(raw)).toBe(expected);
  });

  it.each([undefined, null, "", "   ", '""'])("%j gives an empty key", (raw) => {
    expect(normalizeHeliusKey(raw as string | null | undefined)).toBe("");
  });
});

describe("describeHeliusKey — what is wrong with the value, never the value", () => {
  it.each([
    ["missing", undefined, "missing", false],
    ["a clean UUID", UUID, "uuid", false],
    ["a pasted URL", `https://mainnet.helius-rpc.com/?api-key=${UUID}`, "is-url", true],
    ["a Bearer prefix", `Bearer ${UUID}`, "has-bearer-prefix", true],
    ["quotes", `"${UUID}"`, "has-quotes", true],
    ["a trailing newline", `${UUID}\n`, "has-whitespace", true],
    ["a key of another format", "not-a-uuid-key", "other", false],
  ])("%s", (_label, raw, shape, repaired) => {
    const d = describeHeliusKey(raw as string | undefined);
    expect(d.shape).toBe(shape);
    expect(d.repaired).toBe(repaired);
  });

  it("reports whether the repaired value looks like a UUID, and its length", () => {
    const d = describeHeliusKey(`https://mainnet.helius-rpc.com/?api-key=${UUID}`);
    expect(d.usableLooksLikeUuid).toBe(true);
    expect(d.length).toBe(UUID.length);
  });

  it("never contains any part of the key", () => {
    const raw = `https://mainnet.helius-rpc.com/?api-key=${UUID}`;
    const out = JSON.stringify(describeHeliusKey(raw));
    expect(out).not.toContain(UUID);
    expect(out).not.toContain(UUID.slice(0, 8));
  });
});

describe("heliusRpc — uses the repaired key", () => {
  it("sends only the bare key in the URL, even if the env holds the whole URL", async () => {
    respond(200, { result: 1 });

    await heliusRpc(`https://mainnet.helius-rpc.com/?api-key=${UUID}`, BODY);

    const [url, , , , headers] = callAt(0);
    expect(url).toBe(`${HELIUS_BASE}/?api-key=${encodeURIComponent(UUID)}`);
    expect(headers).toEqual({});
  });

  it("an unusable value (only quotes) makes no request", async () => {
    expect(await heliusRpc('""', BODY)).toBeNull();
    expect(mockFetchJsonPost).not.toHaveBeenCalled();
  });
});

describe("getHeliusDiagnostics — the last call, as statuses only", () => {
  it("is empty before any call", () => {
    expect(getHeliusDiagnostics()).toEqual({ authMode: "query", lastRpc: null });
  });

  it("records a successful call", async () => {
    respond(200, { result: 1 });
    await heliusRpc(KEY, BODY);

    const { lastRpc } = getHeliusDiagnostics();
    expect(lastRpc?.outcome).toBe("ok");
    expect(lastRpc?.query).toBe(200);
    expect(lastRpc?.bearer).toBeUndefined();
  });

  it("records a switch with both statuses", async () => {
    respond(401, null);
    respond(200, { result: 1 });
    await heliusRpc(KEY, BODY);

    const d = getHeliusDiagnostics();
    expect(d.authMode).toBe("bearer");
    expect(d.lastRpc).toMatchObject({ outcome: "switched", query: 401, bearer: 200 });
  });

  it("records a call refused both ways", async () => {
    respond(401, null);
    respond(403, null);
    await heliusRpc(KEY, BODY);

    expect(getHeliusDiagnostics().lastRpc).toMatchObject({ outcome: "rejected", query: 401, bearer: 403 });
  });

  it("records a plain failure (not an auth problem)", async () => {
    respond(500, null);
    await heliusRpc(KEY, BODY);

    expect(getHeliusDiagnostics().lastRpc).toMatchObject({ outcome: "failed", query: 500 });
  });

  it("never contains the key", async () => {
    respond(401, null);
    respond(200, { result: 1 });
    await heliusRpc(KEY, BODY);

    expect(JSON.stringify(getHeliusDiagnostics())).not.toContain(KEY);
  });
});
