// __tests__/api-health.test.ts
//
// /api/health tells the owner why holder data may be missing without exposing
// the key: the shape of the HELIUS_API_KEY value and, with ?probe=1, the
// statuses of a real Helius call made from this very function. Production lost
// its holders and nothing could say why.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mockFetchJsonPost = vi.fn();
vi.mock("../api/_lib/http", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/http")>("../api/_lib/http");
  return { ...actual, fetchJsonPost: (...args: unknown[]) => mockFetchJsonPost(...args) };
});
vi.mock("../api/_lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from "../api/health";
import { _resetHeliusAuthForTests } from "../api/_lib/helius";

const UUID = "8c739183-1a2b-4c3d-8e4f-0123456789ab";

type Helius = {
  key: Record<string, unknown>;
  probed: boolean;
  authMode: string;
  lastRpc: Record<string, unknown> | null;
};

async function call(query: Record<string, string> = {}): Promise<{
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> {
  const headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (b: Record<string, unknown>) => {
      body = b;
    },
  } as unknown as VercelResponse;
  await handler({ query } as unknown as VercelRequest, res);
  return { body, headers };
}

/** Queue one Helius answer for the probe: HTTP status and parsed body. */
function respond(status: number, json: unknown) {
  mockFetchJsonPost.mockImplementationOnce(async (...args: unknown[]) => {
    (args[5] as ((s: number) => void) | undefined)?.(status);
    return json;
  });
}

const saved = process.env.HELIUS_API_KEY;

beforeEach(() => {
  mockFetchJsonPost.mockReset();
  _resetHeliusAuthForTests();
});

afterEach(() => {
  if (saved === undefined) delete process.env.HELIUS_API_KEY;
  else process.env.HELIUS_API_KEY = saved;
});

describe("GET /api/health", () => {
  it("keeps the fields the e2e suite relies on", async () => {
    delete process.env.HELIUS_API_KEY;
    const { body, headers } = await call();

    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.timestamp).toBe("number");
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("is never cached", async () => {
    expect((await call()).headers["Cache-Control"]).toBe("no-store");
  });

  it("works when the request carries no query object", async () => {
    const res = { setHeader: () => undefined, json: () => undefined } as unknown as VercelResponse;
    await expect(handler({} as VercelRequest, res)).resolves.toBeUndefined();
  });

  it("says the Helius key is missing when it is not set", async () => {
    delete process.env.HELIUS_API_KEY;

    expect(((await call()).body.helius as Helius).key.shape).toBe("missing");
  });

  it("reports a clean UUID", async () => {
    process.env.HELIUS_API_KEY = UUID;

    const h = (await call()).body.helius as Helius;
    expect(h.key).toMatchObject({ shape: "uuid", repaired: false, usableLooksLikeUuid: true, length: 36 });
    expect(h.authMode).toBe("query");
    expect(h.lastRpc).toBeNull();
  });

  it("tells the owner when the whole RPC URL was pasted", async () => {
    process.env.HELIUS_API_KEY = `https://mainnet.helius-rpc.com/?api-key=${UUID}`;

    const h = (await call()).body.helius as Helius;
    expect(h.key).toMatchObject({ shape: "is-url", repaired: true, usableLooksLikeUuid: true });
  });

  it("never exposes any part of the key", async () => {
    process.env.HELIUS_API_KEY = `https://mainnet.helius-rpc.com/?api-key=${UUID}`;
    respond(200, { result: 123 });

    const out = JSON.stringify((await call({ probe: "1" })).body);
    expect(out).not.toContain(UUID);
    expect(out).not.toContain(UUID.slice(0, 8));
    expect(out).not.toContain("api-key");
  });
});

describe("GET /api/health?probe=1", () => {
  beforeEach(() => {
    process.env.HELIUS_API_KEY = UUID;
  });

  it("makes no Helius call without the probe parameter", async () => {
    await call();
    expect(mockFetchJsonPost).not.toHaveBeenCalled();
  });

  it("makes one real Helius call and reports its status", async () => {
    respond(200, { result: 123 });

    const h = (await call({ probe: "1" })).body.helius as Helius;

    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
    expect(h.probed).toBe(true);
    expect(h.lastRpc).toMatchObject({ outcome: "ok", query: 200 });
  });

  it("shows that Helius refused the key in both forms", async () => {
    respond(401, null);
    respond(401, null);

    const h = (await call({ probe: "1" })).body.helius as Helius;

    expect(h.lastRpc).toMatchObject({ outcome: "rejected", query: 401, bearer: 401 });
  });

  it("shows when the Bearer fallback was needed", async () => {
    respond(401, null);
    respond(200, { result: 123 });

    const h = (await call({ probe: "1" })).body.helius as Helius;

    expect(h.authMode).toBe("bearer");
    expect(h.lastRpc).toMatchObject({ outcome: "switched", query: 401, bearer: 200 });
  });

  it("probes at most once a minute, so a public URL cannot burn the Helius quota", async () => {
    respond(200, { result: 1 });
    await call({ probe: "1" });
    const second = (await call({ probe: "1" })).body.helius as Helius;

    expect(mockFetchJsonPost).toHaveBeenCalledTimes(1);
    expect(second.probed).toBe(false);
  });

  it("makes no call when no key is configured", async () => {
    delete process.env.HELIUS_API_KEY;

    const h = (await call({ probe: "1" })).body.helius as Helius;

    expect(mockFetchJsonPost).not.toHaveBeenCalled();
    expect(h.probed).toBe(false);
  });

  it("ignores any other probe value", async () => {
    await call({ probe: "yes" });
    expect(mockFetchJsonPost).not.toHaveBeenCalled();
  });
});
