// __tests__/goplus-auth.test.ts
//
// GoPlus access-token exchange. The signature is checked against the vector published in the official SDK
// (goplus-sdk-node, GetAccessTokenRequest): any change to how it is computed makes GoPlus refuse every call.
// The contract that matters to a scan: credentials only ADD headroom; no credentials or a failed exchange
// means the same anonymous call as before, never a missing GoPlus answer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchJsonMock = vi.fn();
vi.mock("../api/_lib/http", () => ({ fetchJson: (...a: unknown[]) => fetchJsonMock(...a) }));
vi.mock("../api/_lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

const { goPlusSign, authorizationValue, getGoPlusToken, fetchGoPlusSecurity, _resetGoPlusAuthForTests } = await import("../api/_lib/goplus-auth");

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const TOKEN_URL = "https://api.gopluslabs.io/api/v1/token";
const tokenOk = (expires_in = 7200) => ({ code: 1, message: "OK", result: { access_token: "tok-1", expires_in } });
const dataOk = { code: 1, result: { [MINT]: { holder_count: "10" } } };

beforeEach(() => {
  fetchJsonMock.mockReset();
  _resetGoPlusAuthForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  delete process.env.GOPLUS_APP_KEY;
  delete process.env.GOPLUS_APP_SECRET;
});
afterEach(() => { vi.useRealTimers(); delete process.env.GOPLUS_APP_KEY; delete process.env.GOPLUS_APP_SECRET; });

describe("goPlusSign", () => {
  it("matches the official SDK vector: sha1(app_key + time + app_secret)", () => {
    expect(goPlusSign("mBOMg20QW11BbtyH4Zh0", 1647847498, "V6aRfxlPJwN3ViJSIFSCdxPvneajuJsh"))
      .toBe("7293d385b9225b3c3f232b76ba97255d0e21063e");
  });
});

describe("authorizationValue", () => {
  it("uses the token as GoPlus returns it when it already starts with Bearer (a second prefix = code 4012 live)", () => {
    expect(authorizationValue("Bearer 81|abcDEF")).toBe("Bearer 81|abcDEF");
    expect(authorizationValue("bearer 81|abcDEF")).toBe("bearer 81|abcDEF");
  });
  it("prefixes a bare token", () => { expect(authorizationValue("81|abcDEF")).toBe("Bearer 81|abcDEF"); });
});

describe("without credentials", () => {
  it("makes no token request and calls GoPlus anonymously, exactly as before", async () => {
    fetchJsonMock.mockResolvedValueOnce(dataOk);
    expect(await getGoPlusToken()).toBeNull();
    const out = await fetchGoPlusSecurity(MINT);
    expect(out).toBe(dataOk);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    expect(fetchJsonMock.mock.calls[0][0]).toContain(`/solana/token_security?contract_addresses=${MINT}`);
    expect(fetchJsonMock.mock.calls[0][1]).toEqual({});
  });

  it("needs BOTH values: a key alone is not enough", async () => {
    process.env.GOPLUS_APP_KEY = "only-a-key";
    expect(await getGoPlusToken()).toBeNull();
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
});

describe("with credentials", () => {
  beforeEach(() => { process.env.GOPLUS_APP_KEY = " mBOMg20QW11BbtyH4Zh0 "; process.env.GOPLUS_APP_SECRET = "V6aRfxlPJwN3ViJSIFSCdxPvneajuJsh\n"; });

  it("exchanges key+secret for a token (POST, signed, whitespace trimmed) and sends it as a Bearer header", async () => {
    fetchJsonMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk);
    const out = await fetchGoPlusSecurity(MINT);
    expect(out).toBe(dataOk);
    const [url, init] = fetchJsonMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body) as { app_key: string; sign: string; time: number };
    expect(body.app_key).toBe("mBOMg20QW11BbtyH4Zh0");
    expect(body.time).toBe(Math.floor(Date.now() / 1000));
    expect(body.sign).toBe(goPlusSign(body.app_key, body.time, "V6aRfxlPJwN3ViJSIFSCdxPvneajuJsh"));
    expect(fetchJsonMock.mock.calls[1][1]).toEqual({ headers: { Authorization: "Bearer tok-1" } });
  });

  it("sends a token that GoPlus already prefixed with Bearer WITHOUT adding a second prefix", async () => {
    fetchJsonMock.mockResolvedValueOnce({ code: 1, result: { access_token: "Bearer 81|real", expires_in: 7200 } }).mockResolvedValueOnce(dataOk);
    await fetchGoPlusSecurity(MINT);
    expect(fetchJsonMock.mock.calls[1][1]).toEqual({ headers: { Authorization: "Bearer 81|real" } });
  });

  it("reuses the token until a minute before it expires, then renews it", async () => {
    fetchJsonMock.mockResolvedValue(tokenOk(3600));
    await getGoPlusToken();
    await getGoPlusToken();
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 3600_000 - 30_000); // inside the renewal margin
    await getGoPlusToken();
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent scans share ONE token request", async () => {
    let release!: (v: unknown) => void;
    fetchJsonMock.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const calls = Promise.all([getGoPlusToken(), getGoPlusToken(), getGoPlusToken()]);
    release(tokenOk());
    expect(await calls).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });

  it("a failed exchange falls back to the anonymous call and is not retried for a minute", async () => {
    fetchJsonMock.mockResolvedValueOnce(null).mockResolvedValueOnce(dataOk).mockResolvedValueOnce(dataOk);
    expect(await fetchGoPlusSecurity(MINT)).toBe(dataOk);
    expect(fetchJsonMock.mock.calls[1][1]).toEqual({});               // anonymous
    expect(await fetchGoPlusSecurity(MINT)).toBe(dataOk);
    expect(fetchJsonMock).toHaveBeenCalledTimes(3);                   // 1 token attempt, NOT a second one
    vi.setSystemTime(Date.now() + 61_000);
    fetchJsonMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk);
    await fetchGoPlusSecurity(MINT);
    expect(fetchJsonMock.mock.calls[3][0]).toBe(TOKEN_URL);           // retried after the back-off
  });

  it("a rejected authenticated call drops the token and answers from the anonymous tier", async () => {
    fetchJsonMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce({ code: 4012, message: "bad token" }).mockResolvedValueOnce(dataOk);
    expect(await fetchGoPlusSecurity(MINT)).toBe(dataOk);
    expect(fetchJsonMock.mock.calls[2][1]).toEqual({});
    fetchJsonMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(dataOk);
    await fetchGoPlusSecurity(MINT);
    expect(fetchJsonMock.mock.calls[3][0]).toBe(TOKEN_URL);           // renewed, not stuck on the bad token
  });

  it("rate limited (code 4029, seen live: 20 of 30 simultaneous calls): answers anonymously but KEEPS the token", async () => {
    fetchJsonMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce({ code: 4029, message: "too many requests" }).mockResolvedValueOnce(dataOk);
    expect(await fetchGoPlusSecurity(MINT)).toBe(dataOk);
    expect(fetchJsonMock.mock.calls[2][1]).toEqual({});               // this scan is answered from the anonymous tier
    fetchJsonMock.mockResolvedValueOnce(dataOk);
    await fetchGoPlusSecurity(MINT);
    // no new token request: the token was fine, only the plan's rate limit was hit
    expect(fetchJsonMock.mock.calls.filter((c) => c[0] === TOKEN_URL)).toHaveLength(1);
    expect(fetchJsonMock.mock.calls[3][1]).toEqual({ headers: { Authorization: "Bearer tok-1" } });
  });

  it("clamps an absurd lifetime so a bad expires_in cannot pin a dead token", async () => {
    fetchJsonMock.mockResolvedValue(tokenOk(10 ** 9));
    await getGoPlusToken();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1000);
    await getGoPlusToken();
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });
});
