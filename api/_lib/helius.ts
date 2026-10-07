// api/_lib/helius.ts — how the Helius key is sent, with auto-detection.
//
// Why this exists: production lost its holder data (Helius layer unavailable on
// every scan) and the cause was invisible. The key is sent as an
// `Authorization: Bearer` header, which Helius's documentation does not
// describe (it documents `?api-key=` only), and every non-2xx answer was
// swallowed without a log. So "key rejected", "auth method no longer accepted"
// and "plan out of credits" all looked the same: a silent null.
//
// What this does:
//   - Tries the way that last worked first (Bearer by default, as used since
//     March 2026), then, ONLY if Helius answers 401/403 (or a JSON-RPC error
//     that names the key), retries once with the documented `?api-key=` form.
//   - Remembers the form that worked for the life of the warm instance, so the
//     extra request is paid once, not on every scan.
//   - Logs which form was rejected (status codes only, never the key or the
//     URL), once per minute, so Vercel's runtime logs say what is wrong.
//
// Not covered here: the Enhanced Transactions REST API (/v0/*), which only ever
// accepted `?api-key=` (see heliusRestUrl).

import { HELIUS_BASE, HELIUS_REST_BASE } from "./constants";
import { fetchJsonPost } from "./http";
import { logger } from "./logger";

export type HeliusAuthMode = "bearer" | "query";

// ─── The key itself ──────────────────────────────────────────────────────────
// HELIUS_API_KEY is pasted by hand into Vercel. The Helius dashboard's "Connect"
// panel shows a full RPC URL (https://mainnet.helius-rpc.com/?api-key=...), not
// the bare key, so the usual slips are: the whole URL, a "Bearer " prefix,
// wrapping quotes, and a stray space or newline. Each makes every request fail
// with a 401 that used to be swallowed. Repair the value instead of failing, and
// report what was found (its shape, never a character of it) so /api/health can
// tell the owner what to fix.

export function normalizeHeliusKey(raw: string | null | undefined): string {
  if (!raw) return "";
  let k = String(raw).trim();
  const fromUrl = k.match(/[?&]api-key=([^&\s"']+)/i);
  if (fromUrl) k = fromUrl[1];
  k = k.replace(/^bearer\s+/i, "");
  k = k.replace(/^["'`]+|["'`]+$/g, "").trim();
  return k;
}

/** The key as the environment holds it, repaired. Empty when unset. */
export function readHeliusKey(): string {
  return normalizeHeliusKey(process.env.HELIUS_API_KEY);
}

export type HeliusKeyShape =
  | "missing"
  | "uuid"
  | "is-url"
  | "has-bearer-prefix"
  | "has-quotes"
  | "has-whitespace"
  | "other";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What is wrong with the raw value, without revealing any of it. */
export function describeHeliusKey(raw: string | null | undefined): {
  shape: HeliusKeyShape;
  repaired: boolean;
  usableLooksLikeUuid: boolean;
  length: number;
} {
  const usable = normalizeHeliusKey(raw);
  if (!raw || !usable) {
    return { shape: "missing", repaired: false, usableLooksLikeUuid: false, length: 0 };
  }
  const value = String(raw);
  let shape: HeliusKeyShape = "other";
  if (/:\/\/|api-key=/i.test(value)) shape = "is-url";
  else if (/^\s*bearer\s/i.test(value)) shape = "has-bearer-prefix";
  else if (/^["'`]|["'`]$/.test(value.trim())) shape = "has-quotes";
  else if (value !== value.trim()) shape = "has-whitespace";
  else if (UUID_RE.test(value)) shape = "uuid";
  return {
    shape,
    repaired: usable !== value,
    usableLooksLikeUuid: UUID_RE.test(usable),
    length: usable.length,
  };
}

// Module scope: lives as long as the warm serverless instance.
let rpcAuthMode: HeliusAuthMode = "bearer";
let lastRejectedLogAt = 0;
const REJECTED_LOG_INTERVAL_MS = 60_000;

// What the last Helius RPC call looked like (HTTP statuses only, never the key),
// so /api/health can show it. Per warm instance: null until it made a call.
export interface HeliusRpcOutcome {
  at: number;
  outcome: "ok" | "switched" | "rejected" | "failed";
  bearer?: number;
  query?: number;
}
let lastRpc: HeliusRpcOutcome | null = null;

function record(
  outcome: HeliusRpcOutcome["outcome"],
  first: HeliusAuthMode,
  firstStatus: number,
  second?: HeliusAuthMode,
  secondStatus?: number,
): void {
  const o: HeliusRpcOutcome = { at: Date.now(), outcome };
  if (firstStatus) o[first] = firstStatus;
  if (second && secondStatus) o[second] = secondStatus;
  lastRpc = o;
}

export function getHeliusDiagnostics(): {
  authMode: HeliusAuthMode;
  lastRpc: HeliusRpcOutcome | null;
} {
  return { authMode: rpcAuthMode, lastRpc };
}

/** Test hook: restore the default mode, the log throttle and the last outcome. */
export function _resetHeliusAuthForTests(): void {
  rpcAuthMode = "bearer";
  lastRejectedLogAt = 0;
  lastRpc = null;
}

export function getHeliusRpcAuthMode(): HeliusAuthMode {
  return rpcAuthMode;
}

/** URL of an Enhanced Transactions (REST) call: the key goes in the query. */
export function heliusRestUrl(path: string, key: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${HELIUS_REST_BASE}${path}${sep}api-key=${encodeURIComponent(normalizeHeliusKey(key))}`;
}

interface Attempt<T> {
  res: T | null;
  status: number;
}

async function attempt<T>(
  key: string,
  body: object,
  ms: number,
  maxRetries: number,
  mode: HeliusAuthMode,
): Promise<Attempt<T>> {
  let status = 0;
  const res = await fetchJsonPost<T>(
    mode === "query" ? `${HELIUS_BASE}/?api-key=${encodeURIComponent(key)}` : HELIUS_BASE,
    body,
    ms,
    maxRetries,
    mode === "bearer" ? { Authorization: "Bearer " + key } : {},
    (s) => {
      status = s;
    },
  );
  return { res, status };
}

/**
 * A JSON-RPC answer that carries an `error` naming the key or access, with no
 * `result`. Helius can answer these with HTTP 200, so the status alone is not
 * enough. Ordinary RPC errors (bad params, unknown mint) do not match.
 */
function looksLikeAuthError(res: unknown): boolean {
  if (!res || typeof res !== "object") return false;
  const r = res as { result?: unknown; error?: unknown };
  if (r.result !== undefined || r.error === undefined) return false;
  const text = JSON.stringify(r.error).toLowerCase();
  return /api.?key|unauthori[sz]ed|forbidden|not authenticated|invalid key|access denied/.test(text);
}

function rejected<T>(a: Attempt<T>): boolean {
  if (a.res === null) return a.status === 401 || a.status === 403;
  return looksLikeAuthError(a.res);
}

/** POST a JSON-RPC body to Helius, negotiating how the key is sent. */
export async function heliusRpc<T = unknown>(
  key: string,
  body: object,
  ms = 6000,
  maxRetries = 1,
): Promise<T | null> {
  const k = normalizeHeliusKey(key);
  if (!k) return null;

  const first = rpcAuthMode;
  const a = await attempt<T>(k, body, ms, maxRetries, first);
  if (!rejected(a)) {
    record(a.res !== null ? "ok" : "failed", first, a.status);
    return a.res;
  }

  const second: HeliusAuthMode = first === "bearer" ? "query" : "bearer";
  const b = await attempt<T>(k, body, ms, maxRetries, second);
  if (b.res !== null && !rejected(b)) {
    record("switched", first, a.status, second, b.status);
    rpcAuthMode = second;
    logger.warn("helius", "RPC auth mode switched: the previous form was rejected", {
      from: first,
      to: second,
      status: a.status,
    });
    return b.res;
  }

  record("rejected", first, a.status, second, b.status);
  const now = Date.now();
  if (now - lastRejectedLogAt >= REJECTED_LOG_INTERVAL_MS) {
    lastRejectedLogAt = now;
    logger.warn(
      "helius",
      "RPC rejected both ways of sending the key: check HELIUS_API_KEY (value, Production scope, domain/IP restrictions, plan)",
      { [first]: a.status || "no status", [second]: b.status || "no status" },
    );
  }
  return a.res;
}
