/**
 * Centralized configuration for the Antares extension.
 * All environment variables and magic numbers are defined here
 * as a single source of truth.
 */

export const config = {
  /** Base URL for the Antares API */
  apiBase: process.env.PLASMO_PUBLIC_API_BASE || "https://antares-extension.vercel.app",

  /** Sentry DSN for error reporting */
  sentryDsn: process.env.PLASMO_PUBLIC_SENTRY_DSN || "",

  /** Sentry traces sample rate */
  sentryTracesSampleRate: 0.1,

  /** Timeout for fetch requests in milliseconds */
  fetchTimeoutMs: 10_000,

  /** Maximum number of scan history entries */
  maxHistoryEntries: 10,

  /** Storage key for scan history */
  historyStorageKey: "antares_scan_history",

  /** Prefix for risk storage keys */
  riskStoragePrefix: "antares_last_risk_",

  /** Chrome alarm name for keepalive */
  keepaliveAlarmName: "keepalive",

  /** Keepalive interval in minutes */
  keepaliveIntervalMinutes: 1,

  /**
   * Rate limiting: max scans per window (client-side).
   *
   * Power users opening 15-20 token tabs in rapid succession (typical
   * "scan-the-trending-page" workflow) need to fit comfortably under
   * this cap. The earlier 10/60s blocked them at scan #11 with a
   * silent retry chain that read as "scans are randomly broken".
   *
   * Set just below the server-side sustained cap (60/60s, see
   * api/_lib/middleware.ts) so a runaway loop in the extension fails
   * fast client-side instead of burning server quota.
   *
   * The limiter is persisted to chrome.storage.local under a single
   * key, so all host-script tabs share one window per browser profile
   * (not per-tab).
   */
  rateLimitMaxScans: 50,

  /** Rate limiting: window duration in ms */
  rateLimitWindowMs: 60_000,
} as const

export type Config = typeof config
