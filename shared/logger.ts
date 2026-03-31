/**
 * Centralized logger for the Antares extension.
 * Replaces scattered console.warn/console.log calls with
 * a structured, prefixed logger that can be silenced in production.
 */

type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const PREFIX = "[antares]"

class Logger {
  private level: number

  constructor(level: LogLevel = "warn") {
    this.level = LOG_LEVELS[level]
  }

  setLevel(level: LogLevel) {
    this.level = LOG_LEVELS[level]
  }

  debug(...args: unknown[]) {
    if (this.level <= LOG_LEVELS.debug) {
      console.debug(PREFIX, ...args)
    }
  }

  info(...args: unknown[]) {
    if (this.level <= LOG_LEVELS.info) {
      console.info(PREFIX, ...args)
    }
  }

  warn(...args: unknown[]) {
    if (this.level <= LOG_LEVELS.warn) {
      console.warn(PREFIX, ...args)
    }
  }

  error(...args: unknown[]) {
    if (this.level <= LOG_LEVELS.error) {
      console.error(PREFIX, ...args)
    }
  }
}

/** Singleton logger instance */
export const logger = new Logger(
  process.env.NODE_ENV === "development" ? "debug" : "warn"
)
