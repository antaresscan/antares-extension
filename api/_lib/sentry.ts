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

/**
 * Apply every PII scrub to a single Sentry event in place. Extracted
 * out of `beforeSend` so the behaviour is unit-testable without
 * spinning up `@sentry/node`. Mutates and returns the event.
 *
 * Operations:
 *  - SCRUB_KEYS values inside extra/tags/contexts/request.data/headers/cookies → "[scrubbed]"
 *  - `event.request.url` query string → "?[scrubbed]" (path preserved for grouping)
 *  - `event.user.email`, `event.user.ip_address` → "[scrubbed]"
 *
 * Any thrown error during scrubbing is swallowed (we'd rather Sentry
 * see a raw event than lose signal entirely).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubEvent(event: any): any {
  try {
    if (event.extra)
      event.extra = scrubObject(event.extra);
    if (event.tags)
      event.tags = scrubObject(event.tags);
    if (event.contexts)
      event.contexts = scrubObject(event.contexts);
    if (event.request) {
      if (event.request.data)
        event.request.data = scrubObject(event.request.data);
      if (event.request.headers)
        event.request.headers = scrubObject(event.request.headers);
      if (event.request.cookies)
        event.request.cookies = scrubObject(event.request.cookies);
      // Drop the URL query string — `?ca=<contract>` would leak the
      // very identifier privacy.html promises never to send. Path is
      // kept so error grouping by route still works.
      if (typeof event.request.url === "string") {
        const qIdx = event.request.url.indexOf("?");
        if (qIdx >= 0)
          event.request.url = event.request.url.slice(0, qIdx) + "?[scrubbed]";
      }
    }
    // Strip user.email even if Sentry's user-context integration ever
    // lands on us. We don't currently call setUser, but the protection
    // costs nothing and prevents a future regression.
    if (event.user?.email) event.user.email = "[scrubbed]";
    // sendDefaultPii=false already prevents IP capture upstream, but
    // if a future integration or manual setUser puts one back, strip
    // it here as the last line of defence.
    if (event.user?.ip_address) event.user.ip_address = "[scrubbed]";
  } catch {
    // Scrubbing failure shouldn't drop the whole event.
  }
  return event;
}

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    // Disable Sentry's default PII enrichment — the SDK normally
    // auto-attaches the client IP and the full request URL (incl.
    // query string with `?ca=<contract>`) to every event. That
    // contradicts privacy.html's claim "Sentry: never the contract
    // address or your IP". sendDefaultPii=false stops the IP capture
    // upstream of beforeSend; the query-string + user.ip_address
    // scrubs in scrubEvent below are belt-and-braces against any
    // auto-enrichment we didn't anticipate.
    sendDefaultPii: false,
    // Don't auto-capture console — we already log structured events
    // via api/_lib/logger.ts and don't want duplicates in Sentry.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== "Console"),
    beforeSend(event) {
      return scrubEvent(event);
    },
  });
  initialized = true;
}

/**
 * Test-only helper. Exposes the full event scrubber (URL query strip,
 * user.email + user.ip_address strip, and recursive key scrub) so
 * tests can pin its behaviour without spinning up Sentry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _scrubEventForTests(event: any): any {
  return scrubEvent(event);
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
