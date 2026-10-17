// shared/sentry-scrub.ts
//
// Pure PII and credential scrubbing for Sentry events, and the text redactors the API logger uses — shared between the Node backend
// (api/_lib/sentry.ts via @sentry/node, api/_lib/logger.ts) and the browser-side overlay (background.ts via @sentry/browser).
//
// Why "shared": before this module existed, PII scrubbing only ran on the Node side. The browser Sentry init in background.ts
// initialised with just `{ dsn, tracesSampleRate }`, so a runtime error in the overlay shipped `?ca=<contract>` query strings (via XHR
// breadcrumbs) and any email/JWT attached to the scope straight to Sentry.
//
// What leaves for Sentry, after scrubEvent (privacy.html promises it: "query strings are stripped before an event is sent"):
//   - no value of a sensitive KEY (SCRUB_KEYS) in extra / tags / contexts / request data, headers and cookies;
//   - no query string: neither in request.url nor in request.query_string (the SDK fills that field on its own), nor inside any
//     URL written in a message, an exception, a breadcrumb, a transaction name or a span;
//   - no e-mail address and no whole licence key inside any of those texts;
//   - no user e-mail, no user IP.
// It applies to error events AND to transactions (performance events: api/_lib/sentry.ts wires beforeSendTransaction too).
//
// Keep this module DEPENDENCY-FREE (no @sentry/* imports). It must transpile cleanly in both the Vercel Node runtime and the Plasmo
// content-script bundle.

/**
 * Keys whose values we replace with "[scrubbed]" before any Sentry event leaves the process. Matching is case-insensitive — Object
 * keys are compared via `.toLowerCase()`. Values are kept as "[scrubbed]" (not deleted) so the event shape stays inspectable for
 * triage ("we know an email lived here, just not which").
 *
 * License keys are sensitive because anyone with the key can redeem the licence onto their own install via /api/redeem. Session
 * cookies and JWTs are the obvious account-takeover vectors. A payment `reference` is a credential too: /api/payment-status gives the
 * licence key of a paid checkout to whoever presents its reference ("the reference key itself is the secret").
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
  "x-antares-session",
  "jwt",
  "authorization",
  "cookie",
  "set-cookie",
  // License keys (account takeover vector — anyone with the key can
  // redeem onto a different install via /api/redeem)
  "licensekey",
  "license_key",
  // A checkout reference reveals the licence key of a paid checkout (/api/payment-status), under every name the code gives it
  "reference",
  "orderid",
  "order_id",
  "intentreference",
  // The install id the extension sends as a header: /api/history serves an install's scans to whoever sends it, and
  // "delete my account" erases the data of the install named in it (account-erasure.ts). (A context field `install_id` stays readable
  // for triage: that is a decision pinned by sentry-scrub.test.ts.)
  "x-antares-install",
  // Secrets
  "ipnsecret",
  "ipn_secret",
  "apikey",
  "api_key",
  "session_secret",
]);

const SCRUBBED = "[scrubbed]";
const MAX_DEPTH = 6;

// ─── Text redactors (also used by the API logger) ─────────────────────────────

/** Anything that looks like an e-mail address inside a piece of text. */
export const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** A whole licence key inside a piece of text (the shape generateLicenseKey makes: ANT- and four groups of four). */
export const LICENSE_KEY_IN_TEXT = /\bANT-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}\b/g;

/** Query parameters whose name says "secret" (Helius only accepts its key as `?api-key=`, so a logged URL can carry it). */
const SECRET_QUERY_PARAM_NAMES = ["api-key", "api_key", "apikey", "key", "token", "access_token", "secret", "password", "auth"];
const SECRET_QUERY_PARAM = new RegExp(`([?&](?:${SECRET_QUERY_PARAM_NAMES.join("|")})=)[^&\\s"'#]+`, "gi");

/** The query string of an absolute URL written inside a text (up to a space, a quote, a fragment or the end). */
const URL_QUERY_IN_TEXT = /\b(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi;

/** The same text with every e-mail address replaced by "[email]". */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_IN_TEXT, "[email]");
}

/** The same text with every whole licence key cut to its first 8 characters and an ellipsis ("ANT-7K2M…"). */
export function redactLicenseKeys(text: string): string {
  return text.replace(LICENSE_KEY_IN_TEXT, (key) => `${key.slice(0, 8)}…`);
}

/** The same text with the VALUE of every secret-named query parameter replaced by "[REDACTED]" (the rest of the URL is kept). */
export function redactSecretQueryParams(text: string): string {
  return text.replace(SECRET_QUERY_PARAM, "$1[REDACTED]");
}

/** The same text with the whole query string of every absolute URL in it replaced by "?[scrubbed]". */
export function stripUrlQueries(text: string): string {
  return text.replace(URL_QUERY_IN_TEXT, `$1?${SCRUBBED}`);
}

/** Everything a text bound for Sentry must lose: query strings, e-mail addresses, whole licence keys. */
export function scrubText(text: string): string {
  return redactLicenseKeys(redactEmails(stripUrlQueries(text)));
}

// ─── Structured data ─────────────────────────────────────────────────────────

/**
 * Recursive scrubber for arbitrary structured data (event.extra, event.request.data, etc.). Replaces values whose KEY matches
 * SCRUB_KEYS with "[scrubbed]". Recursion is bounded at depth 6 — enough for extras + nested request bodies + nested exception
 * causes, deep enough to catch real-world Sentry payloads without OOM risk on circular refs or adversarial deep nesting.
 */
export function scrubObject(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubObject(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SCRUB_KEYS.has(k.toLowerCase())) {
      out[k] = SCRUBBED;
    } else {
      out[k] = scrubObject(v, depth + 1);
    }
  }
  return out;
}

/**
 * scrubObject, plus scrubText on every string value: for extras, tags, contexts, span attributes and trace data, where URLs and
 * messages sit under arbitrary keys. Beyond the depth bound a value is replaced, never sent as is (it could hold anything).
 */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return SCRUBBED;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SCRUB_KEYS.has(k.toLowerCase()) ? SCRUBBED : scrubDeep(v, depth + 1);
  }
  return out;
}

/**
 * Strip the query string off a URL while keeping the path, so Sentry event grouping by route still works but `?ca=<contract>`
 * (and any other query param) doesn't leak. Returns the original string if no "?" is present.
 *
 * Note: we replace with "?[scrubbed]" rather than dropping the "?" entirely so it's obvious in Sentry that scrubbing happened (vs.
 * the URL genuinely having no query).
 */
export function scrubUrlQuery(url: string): string {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return url;
  return url.slice(0, qIdx) + "?" + SCRUBBED;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = any;

/**
 * Apply every scrub to a single Sentry event (an error OR a transaction) in place. Mutates and returns the event so it can be used
 * as a `beforeSend` / `beforeSendTransaction` callback for @sentry/node and @sentry/browser identically. A failure to scrub never
 * drops the event: each part is scrubbed on its own, so one malformed part cannot leave the others unscrubbed.
 *
 * `any` typing on the event is intentional: @sentry/node and @sentry/browser ship slightly different Event types and we don't want
 * this module to depend on either SDK package.
 */
export function scrubEvent(event: AnyEvent): AnyEvent {
  if (!event || typeof event !== "object") return event;
  const step = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* this part stays as it was; the other parts are still scrubbed */
    }
  };
  step(() => { if (event.extra) event.extra = scrubDeep(event.extra); });
  step(() => { if (event.tags) event.tags = scrubDeep(event.tags); });
  step(() => { if (event.contexts) event.contexts = scrubDeep(event.contexts); });
  step(() => {
    const r = event.request as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== "object") return;
    if (r.data) r.data = scrubObject(r.data);
    if (r.headers) r.headers = scrubObject(r.headers);
    if (r.cookies) r.cookies = scrubObject(r.cookies);
    if (typeof r.url === "string") r.url = scrubUrlQuery(r.url);
    // The SDK fills request.query_string on its own (string, object or array): it is the query string, so it goes.
    if (r.query_string !== undefined && r.query_string !== null && r.query_string !== "") r.query_string = SCRUBBED;
  });
  step(() => {
    if (event.user?.email) event.user.email = SCRUBBED;
    if (event.user?.ip_address) event.user.ip_address = SCRUBBED;
  });
  step(() => {
    if (typeof event.message === "string") event.message = scrubText(event.message);
    else if (event.message && typeof event.message === "object") {
      if (typeof event.message.message === "string") event.message.message = scrubText(event.message.message);
      if (typeof event.message.formatted === "string") event.message.formatted = scrubText(event.message.formatted);
    }
  });
  step(() => {
    for (const ex of event.exception?.values ?? []) {
      if (ex && typeof ex.value === "string") ex.value = scrubText(ex.value);
    }
  });
  step(() => { if (typeof event.transaction === "string") event.transaction = scrubText(event.transaction); });
  step(() => {
    for (const span of Array.isArray(event.spans) ? event.spans : []) {
      if (!span || typeof span !== "object") continue;
      if (typeof span.description === "string") span.description = scrubText(span.description);
      if (span.data) span.data = scrubDeep(span.data);
    }
  });
  step(() => {
    const crumbs: unknown = Array.isArray(event.breadcrumbs) ? event.breadcrumbs : event.breadcrumbs?.values;
    if (Array.isArray(crumbs)) for (const b of crumbs) scrubBreadcrumb(b);
  });
  return event;
}

/**
 * Strip query strings off breadcrumb URLs (xhr/fetch/navigation categories) and secrets off its message and data. Sentry's default
 * HTTP breadcrumb integration captures `?ca=<contract>` whenever the overlay calls /api/scan — without this, every error in the
 * extension ships the contract address even if `beforeSend` strips event.request.url.
 *
 * Returns the breadcrumb in place (mutates). We never drop one, only scrub.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scrubBreadcrumb(breadcrumb: any): any {
  try {
    if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
    if (breadcrumb.data && typeof breadcrumb.data === "object") {
      if (typeof breadcrumb.data.url === "string") breadcrumb.data.url = scrubUrlQuery(breadcrumb.data.url);
      if (typeof breadcrumb.data.to === "string") breadcrumb.data.to = scrubUrlQuery(breadcrumb.data.to);
      if (typeof breadcrumb.data.from === "string") breadcrumb.data.from = scrubUrlQuery(breadcrumb.data.from);
      breadcrumb.data = scrubDeep(breadcrumb.data);
    }
    // For 'navigation' breadcrumbs the URL also lives on `message`, often as a relative path ("/api/scan?ca=..."): any "?" goes.
    const message: unknown = breadcrumb.message;
    if (typeof message === "string") {
      breadcrumb.message = scrubText(message.includes("?") ? scrubUrlQuery(message) : message);
    }
  } catch {
    // Same defensive posture as scrubEvent.
  }
  return breadcrumb;
}
