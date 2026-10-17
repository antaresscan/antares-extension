// api/_lib/logger.ts — Structured logger for Antares API
// Replaces console.warn/console.error with silenceable, structured logging.
//
// Two guarantees a logger must give, because it is called from catch blocks:
//  - it NEVER throws. A line that cannot be serialised (a cycle, a BigInt, a getter that throws) is still written, with the parts
//    that could not be serialised replaced, instead of turning a handled error into a crash;
//  - a typo in LOG_LEVEL never silences it. An unknown value used to make every comparison false, so not even an error was written.
import { paymentRef, redactEmails, redactLicenseKeys, redactSecretQueryParams } from "./log-ref";

type LogLevel = "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

function isLogLevel(v: unknown): v is LogLevel {
  return v === "info" || v === "warn" || v === "error";
}

const IS_PROD = process.env.VERCEL_ENV === "production";
const RAW_LEVEL = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
const LOG_LEVEL: LogLevel = isLogLevel(RAW_LEVEL) ? RAW_LEVEL : IS_PROD ? "warn" : "info";
if (RAW_LEVEL && !isLogLevel(RAW_LEVEL)) {
  // Said once, at load, and through console directly (the logger is being built).
  console.warn(JSON.stringify({ level: "warn", module: "logger", message: `LOG_LEVEL "${RAW_LEVEL.slice(0, 20)}" is not info|warn|error: using "${LOG_LEVEL}"` }));
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[LOG_LEVEL];
}

// Whatever is logged, an e-mail address in it is replaced by "[email]", a licence key is cut to its first 8 characters and the value
// of a secret query parameter (?api-key=...) is replaced, before the line is written. The call sites already log a reference (emailRef,
// maskLicenseKey) and never the value; this is for the one nobody thought of (an error message that quotes it, a field added later).
function clean(line: string): string {
  return redactSecretQueryParams(redactLicenseKeys(redactEmails(line)));
}

/**
 * JSON.stringify that does not throw on what log data usually holds: Errors keep their name and message (they serialise as {}
 * otherwise), BigInts become strings, and a reference back to an object still being serialised (a cycle) becomes "[Circular]".
 * The same object met twice in different branches is NOT a cycle and is written twice (only the chain of ancestors is checked).
 * Returns null when serialisation still fails (a getter that throws): the caller then writes the line without its data.
 */
function safeStringify(value: unknown): string | null {
  const ancestors: object[] = [];
  try {
    return JSON.stringify(value, function (this: unknown, _key: string, v: unknown) {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) return { name: v.name, message: v.message };
      // A checkout reference is written as its fingerprint (see referenceAsFingerprint), whatever it is nested in.
      if (v === null || typeof v !== "object") return referenceAsFingerprint(_key, v);
      // `this` is the object that holds `v`: drop the ancestors that are not on its chain any more.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(v)) return "[Circular]";
      ancestors.push(v);
      return v;
    });
  } catch {
    return null;
  }
}

function formatLine(head: Record<string, unknown>, body: Record<string, unknown> | undefined, ts: string): string {
  const full = safeStringify({ ...head, ...(body ?? {}), ts });
  if (full !== null) return clean(full);
  // The data could not be serialised: keep the line (level, module, message, event), say so, never throw.
  return clean(safeStringify({ ...head, dataUnserializable: true, ts }) ?? `{"level":"error","message":"log line unserializable","ts":"${ts}"}`);
}

// The fields in which the code logs a checkout reference. Its value is written as its fingerprint (log-ref.ts paymentRef): the reference
// hands out the licence key of a paid checkout, and it was written whole by the IPN webhook, payment-confirm, the cron and payment-status.
// Only a value of the reference's shape is replaced: a readable reference such as "dev-grant-yearly" stays as it is.
const PAYMENT_REFERENCE_FIELDS = new Set(["reference", "orderId", "order_id", "intentReference"]);
function referenceAsFingerprint(key: string, value: unknown): unknown {
  return typeof value === "string" && PAYMENT_REFERENCE_FIELDS.has(key) ? (paymentRef(value) ?? value) : value;
}

function formatMessage(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): string {
  return formatLine({ level, module, message }, data ? { data } : undefined, new Date().toISOString());
}

function formatMetric(event: string, data: Record<string, unknown>): string {
  let fields: Record<string, unknown> | undefined;
  try {
    fields = { ...data };
  } catch {
    fields = { dataUnserializable: true };
  }
  return formatLine({ level: "metric", event }, fields, new Date().toISOString());
}

export const logger = {
  info(module: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog("info")) console.log(formatMessage("info", module, message, data));
  },
  warn(module: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog("warn")) console.warn(formatMessage("warn", module, message, data));
  },
  error(module: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog("error")) console.error(formatMessage("error", module, message, data));
  },
  // Always-on structured event emitter for telemetry (scan outcomes, layer
  // availability, verdict distribution). Intentionally bypasses LOG_LEVEL so
  // production logs remain queryable even when general info logs are
  // silenced. Downstream aggregators (Vercel Logs, Sentry Logs, OTel) can
  // filter on `level: "metric"` or on the specific event name.
  metric(event: string, data: Record<string, unknown>): void {
    console.log(formatMetric(event, data));
  },
};
