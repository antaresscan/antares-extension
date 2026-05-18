// api/_lib/sentry.ts — Centralised Sentry init + capture helper.
//
// Why this exists: prior to this module, only `api/scan.ts` called
// `Sentry.init`. Every other endpoint (payment-intent, redeem, the
// NOWPayments IPN webhook, account/*) caught errors with `logger.error`
// and nothing else — meaning a buyer hitting an internal 500 during
// checkout would surface as a single Vercel log line nobody is
// watching. Errors in the IPN webhook were the worst case: a payment
// confirmed by NOWPayments but failing on our side would leave the
// user paid-but-not-Pro with zero observability.
//
// Usage:
//   import { initSentry, captureError } from "./_lib/sentry";
//   initSentry();   // module-level — idempotent, no-op without DSN
//   try { ... } catch (err) {
//     captureError(err, { endpoint: "payment-intent", reference });
//     return apiError(res, 500, "...");
//   }
//
// `initSentry` is safe to call multiple times across modules — Sentry
// SDK guards against double-init internally, but we still gate on
// DSN to avoid noisy "no DSN configured" warnings during tests.
//
// Free Sentry tier covers 5K events/month. With a 10% trace sample
// and only error captures elsewhere, we have 50× headroom for normal
// traffic.
import * as Sentry from "@sentry/node";

let initialized = false;

// PII keys we strip from every Sentry event before send. `email` is the
// big one — privacy.html promises no PII reaches Sentry, but
// `captureError(err, { email })` callers exist in account.ts /
// auth/[action].ts. Scrubbing here means the existing call sites are
// safe by default; we no longer rely on every operator remembering to
// hash before logging.
//
// Matching is case-insensitive on the key. Values are replaced with
// the string "[scrubbed]" rather than deleted so the event shape stays
// inspectable (operator can see "an email was here, not what it was")
// when debugging.
const SCRUB_KEYS = new Set([
  "email",
  "emails",
  "emaillc",
  "password",
  "passwordhash",
  "password_hash",
  "token",
  "session_token",
  "sessiontoken",
  "jwt",
  "authorization",
  "cookie",
  "set-cookie",
  "ipnsecret",
  "ipn_secret",
  "apikey",
  "api_key",
  "session_secret",
]);

function scrubObject(value: unknown, depth = 0): unknown {
  // Defensive recursion limit — circular refs and huge nested errors
  // shouldn't OOM the function. 6 layers covers extras + nested
  // request bodies + nested exception causes.
  if (depth > 6) return value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubObject(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SCRUB_KEYS.has(k.toLowerCase())) {
      out[k] = "[scrubbed]";
    } else {
      out[k] = scrubObject(v, depth + 1);
    }
  }
  return out;
}

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    // Don't auto-capture console — we already log structured events
    // via api/_lib/logger.ts and don't want duplicates in Sentry.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== "Console"),
    // PII scrubbing — runs on every event before it leaves the
    // process. Walks `extra`, `tags`, `contexts`, request.data /
    // request.headers / request.cookies, and user.email. Keys
    // matching SCRUB_KEYS (case-insensitive) have their value
    // replaced with "[scrubbed]". Needed to make privacy.html's
    // "no PII to error telemetry" claim actually hold.
    beforeSend(event) {
      try {
        if (event.extra)
          event.extra = scrubObject(event.extra) as typeof event.extra;
        if (event.tags)
          event.tags = scrubObject(event.tags) as typeof event.tags;
        if (event.contexts)
          event.contexts = scrubObject(event.contexts) as typeof event.contexts;
        if (event.request) {
          if (event.request.data)
            event.request.data = scrubObject(event.request.data) as typeof event.request.data;
          if (event.request.headers)
            event.request.headers = scrubObject(event.request.headers) as typeof event.request.headers;
          if (event.request.cookies)
            event.request.cookies = scrubObject(event.request.cookies) as typeof event.request.cookies;
        }
        // Strip user.email even if Sentry's user-context integration
        // ever lands on us. We don't currently call setUser, but the
        // protection costs nothing and prevents a future regression.
        if (event.user?.email) event.user.email = "[scrubbed]";
      } catch {
        // Scrubbing failure shouldn't drop the whole event — let
        // Sentry see the raw (PII-bearing) version rather than lose
        // signal on a malformed event shape.
      }
      return event;
    },
  });
  initialized = true;
}

/**
 * Test-only helper. Exposes the scrubber so unit tests can pin its
 * behaviour without spinning up a Sentry process.
 */
export function _scrubObjectForTests(value: unknown): unknown {
  return scrubObject(value);
}

/**
 * Capture an error to Sentry with optional structured context. Falls
 * back to a no-op when Sentry isn't configured (DSN missing in env)
 * so callers can use this unconditionally without polluting logs.
 *
 * @param err     The thrown error or unknown value.
 * @param context Free-form context object — endpoint name, reference,
 *                user id, etc. Goes into `extra` on the Sentry event.
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    if (context) {
      Sentry.withScope((scope) => {
        scope.setExtras(context);
        Sentry.captureException(err);
      });
    } else {
      Sentry.captureException(err);
    }
  } catch {
    // Capture itself failed — nothing useful to do, swallow rather
    // than crash the caller. The original error has already been
    // logged via the structured logger.
  }
}
