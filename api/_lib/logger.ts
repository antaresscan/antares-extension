// api/_lib/logger.ts — Structured logger for Antares API
// Replaces console.warn/console.error with silenceable, structured logging

type LogLevel = "info" | "warn" | "error";

const IS_PROD = process.env.VERCEL_ENV === "production";
const LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || (IS_PROD ? "warn" : "info");

const LEVELS: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[LOG_LEVEL];
}

function formatMessage(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): string {
  return JSON.stringify({
    level,
    module,
    message,
    ...(data ? { data } : {}),
    ts: new Date().toISOString(),
  });
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
};
