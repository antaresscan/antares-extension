// api/_lib/mailer.ts — Sends an e-mail through Resend (audit A-01). No library: one HTTPS call, so nothing to add to the bundle.
//
// Needs RESEND_API_KEY on the deployment (set by the owner in Vercel; never in the code, never in a log). MAIL_FROM is the sender, "Antares
// <contact@antaresscan.com>" by default: the domain antaresscan.com must be verified in Resend (SPF and DKIM) or Resend refuses the send.
//
// What the logs get: the outcome and the HTTP status. NEVER the address, the subject, the text or the key: logger.ts would scrub an address
// but a link carries a secret, and a secret must not be in a log at all.
import { logger } from "./logger";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Antares <contact@antaresscan.com>";
const SEND_TIMEOUT_MS = 8000;

export interface Mail { to: string; subject: string; text: string; html: string }

export type MailResult =
  | { ok: true }
  /** No RESEND_API_KEY on this deployment: nothing was sent. */
  | { ok: false; reason: "not_configured" }
  /** Resend answered with an error (status says which). */
  | { ok: false; reason: "rejected"; status: number }
  /** No answer in time, or the network failed. */
  | { ok: false; reason: "network" };

export const mailConfigured = (): boolean => (process.env.RESEND_API_KEY ?? "").length > 0;

export async function sendMail(mail: Mail): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY ?? "";
  if (!key) return { ok: false, reason: "not_configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM || DEFAULT_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn("mailer", "Resend refused the send", { status: res.status });
      return { ok: false, reason: "rejected", status: res.status };
    }
    return { ok: true };
  } catch (err) {
    logger.warn("mailer", "send failed", { error: err instanceof Error ? err.name : "unknown" });
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}
