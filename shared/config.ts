/**
 * Centralized configuration for the Antares extension.
 * All environment variables and magic numbers are defined here
 * as a single source of truth.
 */

export const config = {
  /** Base URL for the Antares API */
  apiBase: process.env.PLASMO_PUBLIC_API_BASE || "https://antares-extension.vercel.app",

    /** API key for authenticating extension requests */
  antaresApiKey: process.env.PLASMO_PUBLIC_ANTARES_API_KEY || "",

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

  /** Rate limiting: max scans per window */
  rateLimitMaxScans: 10,

  /** Rate limiting: window duration in ms */
  rateLimitWindowMs: 60_000,
} as const

export type Config = typeof config
