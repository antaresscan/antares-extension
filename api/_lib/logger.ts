// api/_lib/logger.ts — Structured logger for Antares API
// Replaces console.warn/console.error with silenceable, structured logging
import { redactEmails, redactLicenseKeys } from "./log-ref";

type LogLevel = "info" | "warn" | "error";

const IS_PROD = process.env.VERCEL_ENV === "production";
const LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || (IS_PROD ? "warn" : "info");

const LEVELS: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[LOG_LEVEL];
}

// Whatever is logged, an e-mail address in it is replaced by "[email]" and a licence key is cut to its first 8 characters before the line is
// written. The call sites already log a reference (emailRef, maskLicenseKey) and never the value; this is for the one nobody thought of (an
// error message that quotes it, a field added later).
function clean(line: string): string {
  return redactLicenseKeys(redactEmails(line));
}

function formatMessage(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): string {
  return clean(JSON.stringify({
    level,
    module,
    message,
    ...(data ? { data } : {}),
    ts: new Date().toISOString(),
  }));
}

function formatMetric(event: string, data: Record<string, unknown>): string {
  return clean(JSON.stringify({
    level: "metric",
    event,
    ...data,
    ts: new Date().toISOString(),
  }));
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
