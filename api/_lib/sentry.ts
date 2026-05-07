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
  });
  initialized = true;
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
