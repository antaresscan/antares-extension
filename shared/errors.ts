/**
 * Centralized error types for the Antares extension.
 * Provides consistent error handling across all modules.
 */

export enum ErrorCode {
  INVALID_ADDRESS = "INVALID_ADDRESS",
  FETCH_TIMEOUT = "FETCH_TIMEOUT",
  FETCH_FAILED = "FETCH_FAILED",
  RATE_LIMITED = "RATE_LIMITED",
  STORAGE_ERROR = "STORAGE_ERROR",
  PARSE_ERROR = "PARSE_ERROR",
  UNKNOWN = "UNKNOWN",
}

export class AntaresError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = "AntaresError"
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      name: this.name,
    }
  }
}

export function isAntaresError(err: unknown): err is AntaresError {
  return err instanceof AntaresError
}

/** Wrap unknown catch values into an AntaresError */
export function toAntaresError(err: unknown, fallbackCode = ErrorCode.UNKNOWN): AntaresError {
  if (isAntaresError(err)) return err
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return new AntaresError(ErrorCode.FETCH_TIMEOUT, "Request timed out", err)
    }
    return new AntaresError(fallbackCode, err.message, err)
  }
  return new AntaresError(fallbackCode, String(err))
}
