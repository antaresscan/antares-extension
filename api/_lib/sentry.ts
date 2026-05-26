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
import { scrubEvent, scrubObject } from "../../shared/sentry-scrub";

let initialized = false;

// PII scrubbing now lives in `shared/sentry-scrub.ts` so the browser
// init in background.ts + contents/antares-inject.ts shares the same
// SCRUB_KEYS list and the same scrubEvent logic. Before this split,
// the browser Sentry init bypassed all scrubbing — silently violating
// privacy.html's "no PII / no contract address" promise on the entire
// extension overlay.

// scrubEvent + scrubObject now live in `shared/sentry-scrub.ts` —
// imported at the top of this file. The earlier local copy was
// re-introduced here by the merge of master (which still carried the
// pre-refactor version from PR #508 squash). Removed again to avoid
// the TS2440 "Import declaration conflicts with local declaration"
// build error.

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
