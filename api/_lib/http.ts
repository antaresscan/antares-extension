// api/_lib/http.ts — The one place where the API talks HTTP to the upstream data sources (DexScreener, RugCheck, GoPlus,
// Helius, Solscan, GeckoTerminal, the public Solana RPC pool).
//
// fetchJson (GET) and fetchJsonPost (POST JSON) share ONE request core, so every rule below holds for both:
//  - one deadline covers the whole exchange, the headers AND the body. It used to be cleared as soon as the headers arrived, so a
//    provider that sent its headers and then trickled the body held the call until the function's own time limit;
//  - the body is read with a size ceiling (MAX_BODY_BYTES): a runaway answer is cut off, never buffered whole, never parsed;
//  - an AbortSignal passed by the caller is honoured: aborting cancels the call, and a call the CALLER gave up is never counted
//    against the provider (no retry, no circuit-breaker failure, no outage-ledger entry);
//  - a body that will not be read (an error answer, an answer we retry) is cancelled, so its connection goes back to the pool;
//  - only an exchange the provider did not complete is retried (network error, timeout, 429, 503). An answer that arrived but is
//    not JSON is NOT asked again: a second request would be billed again (Helius Enhanced Transactions: 100 credits a call);
//  - each final failure is counted ONCE by the circuit breaker and the outage ledger. A 503 used to be counted twice (once as
//    "429/503 after the retries", once more as a 5xx), which opened the breaker and declared the source down too early;
//  - the circuit breaker has a real half-open state: when its cooldown ends, ONE probe goes out while every other call keeps
//    failing fast, and a probe that fails re-opens it at once. It used to let every call through after the cooldown and needed
//    five more failures, each paying the full timeout, before it opened again.
//
// The public signatures of fetchJson / fetchJsonPost / withTimeout / scrubSensitive are unchanged: no caller changes.
import { logger } from "./logger";
import { recordCall, recordSkipped } from "./usage";
import { noteSourceFailure, _resetOutageForTests } from "./outage";

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Largest upstream body we accept. The largest legitimate answer measured is GoPlus on a token with many accounts (about 2.8 MB,
 * replay capture of 2026-10-11): 16 MiB keeps a wide margin and still stops an answer that would exhaust the function's memory.
 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
/** A call never retries more than this, whatever the caller asks: an unbounded value would loop on a provider stuck at 503. */
const MAX_RETRIES_CAP = 3;
const BACKOFF_BASE_MS = 500;

/** A timer that aborts its signal after `ms`. `clear` must be called once the exchange is over (body included). */
export function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

// ─── Per-host circuit breaker ────────────────────────────────────────────────
//
// When an upstream has a partial outage, each scan that touches it pays the full timeout before moving on, and the upstream gets
// hammered by every scan's retries. The breaker counts consecutive failures per host (the URL's hostname). After
// BREAKER_THRESHOLD failures inside BREAKER_WINDOW_MS it OPENS: calls to that host return null at once, without touching the
// network, for BREAKER_COOLDOWN_MS. Then it is HALF-OPEN: exactly one call (the probe) goes out, the others still fail fast.
// The probe closes the breaker if the host answers, and re-opens it for a full cooldown if it fails.
//
// State is module scope: it lives as long as a warm serverless instance. A cold start resets it, which only costs one round trip.
type BreakerState = {
  failures: number;        // consecutive failures since the last success
  firstFailureAt: number;  // ms timestamp of the failure that started the counting window
  openUntil: number;       // 0 = closed; > now = open; <= now (and not 0) = half-open
  probing: boolean;        // half-open and the single probe is in flight
};
const BREAKER_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 30_000;
const BREAKER_COOLDOWN_MS = 30_000;
const breakers = new Map<string, BreakerState>();

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * True when calls to `host` must not go out right now: the breaker is open, or half-open with its probe already in flight.
 * Exported for tests; production callers go through fetchJson / fetchJsonPost, which gate internally.
 */
export function isCircuitOpen(host: string, now: number = Date.now()): boolean {
  const s = breakers.get(host);
  if (!s || s.openUntil === 0) return false;
  if (s.openUntil > now) return true;
  return s.probing;
}

type Gate = "closed" | "probe" | "open";

/** Decide whether a call may go out, and take the probe slot when the breaker is half-open (atomic: no await in between). */
function enterGate(host: string, now: number): Gate {
  const s = breakers.get(host);
  if (!s || s.openUntil === 0) return "closed";
  if (s.openUntil > now || s.probing) return "open";
  s.probing = true;
  return "probe";
}

function recordFailure(host: string, now: number = Date.now()): void {
  noteSourceFailure(host, now); // the outage ledger (outage.ts): "Limited data" only when a source has failed several times within the minute
  const s = breakers.get(host);
  if (s && s.openUntil !== 0) {
    // Open or half-open: a failed probe (or a late failure after the cooldown) re-opens for a full cooldown from now. A failure
    // that arrives while still open (a call sent before it opened) changes nothing but the count.
    if (s.openUntil <= now) {
      s.openUntil = now + BREAKER_COOLDOWN_MS;
      logger.warn("http", "circuit breaker re-opened", { host, cooldownMs: BREAKER_COOLDOWN_MS });
    }
    s.failures += 1;
    s.probing = false;
    return;
  }
  if (!s || now - s.firstFailureAt > BREAKER_WINDOW_MS) {
    breakers.set(host, { failures: 1, firstFailureAt: now, openUntil: 0, probing: false });
    return;
  }
  s.failures += 1;
  if (s.failures >= BREAKER_THRESHOLD) {
    s.openUntil = now + BREAKER_COOLDOWN_MS;
    logger.warn("http", "circuit breaker opened", { host, failures: s.failures, cooldownMs: BREAKER_COOLDOWN_MS });
  }
}

/** The host answered usefully: forget its failures, close the breaker (this is also how a successful probe closes it). */
function recordSuccess(host: string): void {
  breakers.delete(host);
}

/** Give the probe slot back when the probe ended without telling anything about the host (the caller aborted it). */
function releaseProbe(host: string): void {
  const s = breakers.get(host);
  if (s) s.probing = false;
}

/** Test-only helper to reset all breaker state between tests. */
export function _resetCircuitBreakersForTests(): void {
  breakers.clear();
  _resetOutageForTests(); // the outage ledger is reset with the breakers: both are module memory, and a test that failed a host must not leave it "down" for the next
}

// ─── Log hygiene ─────────────────────────────────────────────────────────────

// Native fetch failures can carry the request URL in their message, and Helius' /v0/* REST surface only accepts the key as a
// query parameter, so a logged URL can leak the key into the runtime logs. Every query parameter whose name says "secret" is
// redacted at the log boundary. One precompiled pattern (the names are literal, no escaping needed).
const SENSITIVE_QS_KEYS = ["api-key", "api_key", "apikey", "key", "token", "access_token", "secret", "password", "auth"];
const SENSITIVE_QS_RE = new RegExp(`([?&](?:${SENSITIVE_QS_KEYS.join("|")})=)[^&\\s"'#]+`, "gi");

export function scrubSensitive(input: string): string {
  return String(input).replace(SENSITIVE_QS_RE, "$1[REDACTED]");
}

/** One log-safe line for an error: its message, scrubbed, plus the network code of its cause (ECONNRESET...), capped in length. */
function describeError(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } } | null | undefined)?.cause;
  const code = cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
  return scrubSensitive(`${String(e)}${code}`).slice(0, 300);
}

// 401/403 from an upstream mean OUR credentials were refused (expired key, plan out of credits, wrong auth form, domain/IP
// restriction). Callers swallow 4xx as a silent null, which hid a month-long Helius outage. Log the host and the status, never the
// URL (it can carry the key), at most once a minute per host and status so a dead key does not flood the runtime logs.
const authLogAt = new Map<string, number>();
const AUTH_LOG_INTERVAL_MS = 60_000;
function logAuthRejected(host: string, status: number, now: number = Date.now()): void {
  if (status !== 401 && status !== 403) return;
  const k = `${host}:${status}`;
  if (now - (authLogAt.get(k) ?? 0) < AUTH_LOG_INTERVAL_MS) return;
  authLogAt.set(k, now);
  logger.warn("http", "upstream rejected our credentials", { host, status });
}

/** Test-only helper to reset the 401/403 log throttle between tests. */
export function _resetAuthLogThrottleForTests(): void {
  authLogAt.clear();
}

// ─── Signals, sleeping, bodies ───────────────────────────────────────────────

/** A signal that aborts when either input aborts. `dispose` removes the listeners put on the caller's signal (no leak). */
function combineSignals(caller: AbortSignal, timer: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return { signal: any.call(AbortSignal, [caller, timer]), dispose: () => undefined };
  const c = new AbortController();
  const onCaller = () => c.abort(caller.reason);
  const onTimer = () => c.abort(timer.reason);
  if (caller.aborted) c.abort(caller.reason); else caller.addEventListener("abort", onCaller, { once: true });
  if (timer.aborted) c.abort(timer.reason); else timer.addEventListener("abort", onTimer, { once: true });
  return {
    signal: c.signal,
    dispose: () => {
      caller.removeEventListener("abort", onCaller);
      timer.removeEventListener("abort", onTimer);
    },
  };
}

/** Wait `ms` before a retry. Resolves false at once if the caller aborts meanwhile (no point retrying for nobody). */
function backoff(ms: number, caller: AbortSignal | null): Promise<boolean> {
  return new Promise((resolve) => {
    if (caller?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      caller?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    caller?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The error an aborted signal stands for (its reason, or a standard AbortError when it has none). */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * `p`, or a rejection as soon as `signal` aborts, whichever comes first. The platform fetch already honours its signal; this also
 * holds for a fetch implementation or a body that does not (a polyfill, a test double), so the deadline can never be outlived.
 * A late settlement of `p` is still observed, so it never becomes an unhandled rejection.
 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

type BodyStream = { getReader?: () => ReadableStreamDefaultReader<Uint8Array>; cancel?: () => Promise<void>; locked?: boolean };

/** Throw the body away so the connection can be reused. Never throws. */
async function discardBody(r: Response): Promise<void> {
  try {
    const body = r.body as BodyStream | null | undefined;
    if (body && typeof body.cancel === "function" && !body.locked) await body.cancel();
  } catch {
    /* the connection is gone either way */
  }
}

const OVERSIZED: unique symbol = Symbol("oversized");

/**
 * Read the body as JSON, never holding more than `maxBytes`. A declared Content-Length above the ceiling is refused without reading;
 * otherwise the stream is read chunk by chunk and cancelled as soon as it crosses the ceiling. The bytes are decoded once, after the
 * last chunk, so a character split across two chunks is decoded right, and a UTF-8 byte-order mark is dropped (as Response.json does).
 * A response without a readable stream (a test double, a polyfill) goes through its own .json().
 * Throws SyntaxError when the body is not JSON, and an abort error when `signal` aborts (the deadline or the caller), even if the
 * stream itself ignores the abort.
 */
async function readJsonCapped(r: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = Number(r.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(r);
    return OVERSIZED;
  }
  const body = r.body as BodyStream | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    return await abortable((r as unknown as { json: () => Promise<unknown> }).json(), signal);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return OVERSIZED;
      }
      chunks.push(value);
    }
  } catch (e: unknown) {
    await reader.cancel().catch(() => undefined); // free the connection: nobody will read the rest
    throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* a read still pending (aborted above) keeps the lock: the cancel already freed the stream */
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

// ─── The request core ────────────────────────────────────────────────────────

interface RequestOptions {
  init: RequestInit;
  /** The JSON body of a POST, given to the usage counters (a JSON-RPC method decides the Helius credits). */
  usageBody: unknown;
  ms: number;
  maxRetries: number;
  onStatus?: (status: number) => void;
  label: "fetchJson" | "fetchJsonPost";
}

/** What one attempt ended with. */
type Attempt =
  | { kind: "ok"; value: unknown }          // a 2xx answer, parsed
  | { kind: "answered" }                     // a 4xx (other than 429): the host is alive, the request was refused
  | { kind: "aborted" }                      // the caller gave up
  | { kind: "retry"; error?: string }        // not completed: network error, timeout, 429, 503
  | { kind: "fail"; error?: string };        // completed but unusable: other 5xx, not JSON, too large

function clampTimeout(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function clampRetries(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_RETRIES_CAP) : 0;
}

async function attemptOnce(url: string, host: string, o: RequestOptions, caller: AbortSignal | null): Promise<Attempt> {
  const timer = withTimeout(o.ms);
  const combined = caller ? combineSignals(caller, timer.signal) : { signal: timer.signal, dispose: () => undefined };
  let answered = false;
  try {
    const r = await abortable(fetch(url, { ...o.init, signal: combined.signal }), combined.signal);
    answered = true;
    logAuthRejected(host, r.status);
    o.onStatus?.(r.status);
    recordCall(url, r.status, o.usageBody);
    if (r.status === 429 || r.status === 503) {
      await discardBody(r);
      return { kind: "retry" };
    }
    if (!r.ok) {
      await discardBody(r);
      // A 5xx is a health signal; any other refusal (400, 401, 403, 404...) is the request's problem, not the host's.
      return r.status >= 500 ? { kind: "fail" } : { kind: "answered" };
    }
    const parsed = await readJsonCapped(r, MAX_BODY_BYTES, combined.signal);
    if (parsed === OVERSIZED) return { kind: "fail", error: `answer larger than ${MAX_BODY_BYTES} bytes` };
    return { kind: "ok", value: parsed };
  } catch (e: unknown) {
    if (caller?.aborted) return { kind: "aborted" };
    if (!answered) recordCall(url, 0, o.usageBody);
    // An answer that arrived complete but is not JSON is not retried (a second request is billed again). Anything else, including
    // the deadline aborting a slow body, did not complete and is retried.
    if (answered && e instanceof SyntaxError) return { kind: "fail", error: describeError(e) };
    return { kind: "retry", error: describeError(e) };
  } finally {
    timer.clear();
    combined.dispose();
  }
}

async function requestJson<T>(url: string, o: RequestOptions): Promise<T | null> {
  const host = hostnameOf(url);
  if (!host) {
    logger.warn("http", `${o.label} failed`, { error: "invalid URL" }); // never the URL itself: it can carry a key
    return null;
  }
  const caller = o.init.signal ?? null;
  if (caller?.aborted) return null;
  const gate = enterGate(host, Date.now());
  if (gate === "open") {
    // Breaker open: answer null at once, the caller's null path runs as if the upstream had failed.
    recordSkipped(url);
    noteSourceFailure(host);
    return null;
  }
  let probeSettled = gate !== "probe";
  try {
    for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
      const a = await attemptOnce(url, host, o, caller);
      switch (a.kind) {
        case "ok":
          recordSuccess(host);
          probeSettled = true;
          return a.value as T;
        case "answered":
          if (!probeSettled) {
            recordSuccess(host); // a probe that got any answer proves the host is back
            probeSettled = true;
          }
          return null;
        case "aborted":
          return null;
        case "fail":
          recordFailure(host);
          probeSettled = true;
          if (a.error) logger.warn("http", `${o.label} failed`, { host, error: a.error });
          return null;
        case "retry":
          if (attempt < o.maxRetries) {
            if (!(await backoff(BACKOFF_BASE_MS * 2 ** attempt, caller))) return null;
            continue;
          }
          recordFailure(host);
          probeSettled = true;
          if (a.error) logger.warn("http", `${o.label} failed`, { host, error: a.error });
          return null;
      }
    }
    return null;
  } finally {
    if (!probeSettled) releaseProbe(host);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * GET `url` and parse the JSON answer, or null on any failure (refused, not found, down, timed out, not JSON, too large, aborted).
 * `ms` bounds one attempt, headers and body included. `maxRetries` (0 to 3) applies to 429, 503, network errors and timeouts,
 * with a 500 ms then 1 s backoff. `onStatus` receives the HTTP status of every answer, so a caller can tell "refused" (401/403)
 * from "unknown token" (404) although both return null. An AbortSignal in `init` cancels the call (never counted against the host).
 */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  ms = DEFAULT_TIMEOUT_MS,
  maxRetries = 1,
  onStatus?: (status: number) => void,
): Promise<T | null> {
  return requestJson<T>(url, {
    init,
    usageBody: undefined,
    ms: clampTimeout(ms),
    maxRetries: clampRetries(maxRetries),
    onStatus,
    label: "fetchJson",
  });
}

/**
 * POST `body` as JSON and parse the answer, or null on any failure. Same rules as fetchJson. A body that cannot be serialised
 * (a cycle, a BigInt) is a bug of the caller: it is logged and returns null without any request, and is not counted against the host.
 */
export async function fetchJsonPost<T = unknown>(
  url: string,
  body: object,
  ms = DEFAULT_TIMEOUT_MS,
  maxRetries = 1,
  extraHeaders: Record<string, string> = {},
  onStatus?: (status: number) => void,
): Promise<T | null> {
  let payload: string;
  try {
    payload = JSON.stringify(body);
  } catch (e: unknown) {
    logger.warn("http", "fetchJsonPost failed", { error: `body not serialisable: ${describeError(e)}` });
    return null;
  }
  return requestJson<T>(url, {
    init: { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: payload },
    usageBody: body,
    ms: clampTimeout(ms),
    maxRetries: clampRetries(maxRetries),
    onStatus,
    label: "fetchJsonPost",
  });
}
