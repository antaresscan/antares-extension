// shared/sentry-scrub.ts
//
// Pure PII scrubbing for Sentry events — shared between the Node backend
// (api/_lib/sentry.ts via @sentry/node) and the browser-side overlay
// (background.ts + contents/antares-inject.ts via @sentry/browser).
//
// Why "shared": before this module existed, PII scrubbing only ran on
// the Node side. The browser Sentry init in background.ts and
// antares-inject.ts initialised with just `{ dsn, tracesSampleRate }`,
// so a runtime error in the overlay shipped `?ca=<contract>` query
// strings (via XHR breadcrumbs) and any email/JWT attached to the
// scope straight to Sentry — silently violating the privacy.html
// claim "Sentry: never the contract address or your IP".
//
// Keep this module DEPENDENCY-FREE (no @sentry/* imports). It must
// transpile cleanly in both the Vercel Node runtime and the Plasmo
// content-script bundle.

/**
 * Keys whose values we replace with "[scrubbed]" before any Sentry
 * event leaves the process. Matching is case-insensitive — Object
 * keys are compared via `.toLowerCase()`. Values are kept as
 * "[scrubbed]" (not deleted) so the event shape stays inspectable for
 * triage ("we know an email lived here, just not which").
 *
 * License keys are sensitive because anyone with the key can redeem
 * the licence onto their own install via /api/redeem. Session cookies
 * and JWTs are the obvious account-takeover vectors.
 */
export const SCRUB_KEYS = new Set<string>([
  // Identity
  "email",
  "emails",
  "emaillc",
  // Passwords
  "password",
  "passwordhash",
  "password_hash",
  // Session / auth
  "token",
  "session_token",
  "sessiontoken",
  "antares_session",
  "antares_session_token",
  "jwt",
  "authorization",
  "cookie",
  "set-cookie",
  // License keys (account takeover vector — anyone with the key can
  // redeem onto a different install via /api/redeem)
  "licensekey",
  "license_key",
  // Secrets
  "ipnsecret",
  "ipn_secret",
  "apikey",
  "api_key",
  "session_secret",
]);

/**
 * Recursive scrubber for arbitrary structured data (event.extra,
 * event.request.data, etc.). Replaces values whose KEY matches
 * SCRUB_KEYS with "[scrubbed]". Recursion is bounded at depth 6 —
 * enough for extras + nested request bodies + nested exception
 * causes, deep enough to catch real-world Sentry payloads without
 * OOM risk on circular refs or adversarial deep nesting.
 */
export function scrubObject(value: unknown, depth = 0): unknown {
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
 * Strip the query string off a URL while keeping the path, so Sentry
 * event grouping by route still works but `?ca=<contract>` (and any
 * other query param) doesn't leak. Returns the original string if no
 * "?" is present.
 *
 * Note: we replace with "?[scrubbed]" rather than dropping the "?"
 * entirely so it's obvious in Sentry that scrubbing happened (vs.
 * the URL genuinely having no query).
 */
export function scrubUrlQuery(url: string): string {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return url;
  return url.slice(0, qIdx) + "?[scrubbed]";
}

/**
 * Apply every scrub to a single Sentry event in place. Mutates and
 * returns the event so it can be used as a `beforeSend` callback for
 * @sentry/node and @sentry/browser identically. Any thrown error is
 * swallowed (we prefer Sentry seeing a raw event than losing signal).
 *
 * Operations:
 *  - SCRUB_KEYS values inside extra/tags/contexts/request.data/headers/cookies → "[scrubbed]"
 *  - `event.request.url` query → "?[scrubbed]"
 *  - `event.user.email`, `event.user.ip_address` → "[scrubbed]"
 *
 * `any` typing on the event is intentional: @sentry/node and
 * @sentry/browser ship slightly different Event types and we don't
 * want this module to depend on either SDK package.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scrubEvent(event: any): any {
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
      if (typeof event.request.url === "string") {
        event.request.url = scrubUrlQuery(event.request.url);
      }
    }
    if (event.user?.email) event.user.email = "[scrubbed]";
    if (event.user?.ip_address) event.user.ip_address = "[scrubbed]";
  } catch {
    // Scrubbing failure shouldn't drop the whole event.
  }
  return event;
}

/**
 * Strip query strings off breadcrumb data URLs (xhr/fetch/navigation
 * categories). Sentry's default HTTP breadcrumb integration captures
 * `?ca=<contract>` whenever the overlay calls /api/scan — without
 * this, every error in the extension ships the contract address even
 * if `beforeSend` strips event.request.url.
 *
 * Returns the breadcrumb in place (mutates) or null if the breadcrumb
 * should be dropped entirely. Currently we never drop, only scrub.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scrubBreadcrumb(breadcrumb: any): any {
  try {
    if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
    if (breadcrumb.data && typeof breadcrumb.data === "object") {
      if (typeof breadcrumb.data.url === "string") {
        breadcrumb.data.url = scrubUrlQuery(breadcrumb.data.url);
      }
      if (typeof breadcrumb.data.to === "string") {
        breadcrumb.data.to = scrubUrlQuery(breadcrumb.data.to);
      }
      if (typeof breadcrumb.data.from === "string") {
        breadcrumb.data.from = scrubUrlQuery(breadcrumb.data.from);
      }
    }
    // For 'navigation' breadcrumbs the URL also lives on `message`.
    if (typeof breadcrumb.message === "string" && breadcrumb.message.includes("?")) {
      breadcrumb.message = scrubUrlQuery(breadcrumb.message);
    }
  } catch {
    // Same defensive posture as scrubEvent.
  }
  return breadcrumb;
}
