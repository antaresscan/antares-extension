// api/_lib/log-ref.ts — what a log line says about an e-mail address. Never the address itself.
//
// An address is personal data (GDPR): it must not sit in the logs, which are kept by Vercel and read by whoever debugs. But the logs still
// have to answer "is this the same account as a minute ago?", so each address becomes a reference: 12 hexadecimal characters of an HMAC of the
// address (normalised: trimmed, lower case). Same address, same reference; nobody can go back from the reference to the address, nor test a
// guessed address against it without the key.
//
// The key is LOG_PEPPER when it is set (16 characters or more). Otherwise it is derived from SESSION_SECRET, which is always set in
// production, with a label of its own so that the reference tells nothing about the session key. With neither (tests, a bare dev machine) the
// reference is the word "unkeyed": a plain hash of an address can be tested against a list of addresses, so none is ever written.
//
// Rotating the key changes every reference: logs from before and after cannot be matched any more. That is the price of the protection.
import { createHmac } from "node:crypto";

const REF_LENGTH = 12;
const DERIVATION_LABEL = "antares:log-pepper:v1";

function pepper(): Buffer | null {
  const explicit = process.env.LOG_PEPPER;
  if (typeof explicit === "string" && explicit.length >= 16) return Buffer.from(explicit, "utf8");
  const session = process.env.SESSION_SECRET;
  if (typeof session === "string" && session.length >= 32) return createHmac("sha256", session).update(DERIVATION_LABEL).digest();
  return null;
}

/** The reference of an e-mail address, for a log line. null for anything that is not a non-empty string (an absent address stays absent). */
export function emailRef(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalised = email.trim().toLowerCase();
  if (!normalised) return null;
  const key = pepper();
  if (!key) return "unkeyed";
  return createHmac("sha256", key).update(normalised).digest("hex").slice(0, REF_LENGTH);
}

/** Anything that looks like an e-mail address inside a piece of text. */
export const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** The same text with every address in it replaced by "[email]": the safety net of the logger, for what nobody thought of. */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_IN_TEXT, "[email]");
}
