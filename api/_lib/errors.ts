// api/_lib/errors.ts — Custom error class for Antares
import { logger } from "./logger";

export class AntaresError extends Error {
  public readonly module: string;
  public readonly context?: Record<string, unknown>;

  constructor(module: string, message: string, context?: Record<string, unknown>) {
    super(`[${module}] ${message}`);
    this.name = "AntaresError";
    this.module = module;
    this.context = context;
    logger.error(module, message, context);
  }
}

/**
 * Wrap a catch block — logs the error via AntaresError and returns a fallback.
 * Usage: `} catch (e) { return catchWithLog("fetchers", "resolve owners failed", e, []); }`
 */
export function catchWithLog<T>(
  module: string,
  message: string,
  error: unknown,
  fallback: T,
): T {
  logger.error(module, message, { error: String(error) });
  return fallback;
}
