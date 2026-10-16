// api/_lib/mail-templates.ts — The two e-mails of the e-mail proof (audit A-01). Plain words, no tracking pixel, no image, one link.
//
// The link goes to verify.html on the API host (the same place privacy.html and support.html live) with the token in the FRAGMENT (#t=...):
// a fragment is never sent to a server and never appears in a log or a Referer header.
import type { Mail } from "./mailer";

const linkBase = (): string => (process.env.VERIFY_LINK_BASE || "https://antares-extension.vercel.app").replace(/\/+$/, "");

export const verifyLink = (token: string): string => `${linkBase()}/verify.html#t=${token}`;

const wrap = (inner: string): string =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1d4a43;max-width:520px">${inner}<p style="color:#6f9c93;font-size:12px;margin-top:28px">Antares</p></div>`;

/** "Confirm your account": the link, and what to do with it. */
export function verificationMail(to: string, token: string): Mail {
  const link = verifyLink(token);
  return {
    to,
    subject: "Confirm your Antares account",
    text:
      "Someone, hopefully you, created an Antares account with this e-mail address.\n\n" +
      "To confirm that the address is yours, open this link and type the password you chose:\n\n" +
      `${link}\n\n` +
      "The link works for 24 hours.\n\n" +
      "If you did not create an account, ignore this e-mail: nothing happens, and the request disappears by itself.\n\n" +
      "Antares",
    html: wrap(
      "<p>Someone, hopefully you, created an Antares account with this e-mail address.</p>" +
        "<p>To confirm that the address is yours, open this link and type the password you chose:</p>" +
        `<p><a href="${link}" style="display:inline-block;padding:11px 20px;background:#0ca88c;color:#ffffff;text-decoration:none;border-radius:6px">Confirm my account</a></p>` +
        `<p style="font-size:13px;color:#4d7a72">Or paste this address in your browser:<br><a href="${link}" style="color:#0ca88c;word-break:break-all">${link}</a></p>` +
        "<p>The link works for 24 hours.</p>" +
        "<p>If you did not create an account, ignore this e-mail: nothing happens, and the request disappears by itself.</p>",
    ),
  };
}

/** Somebody tried to sign up with an address that already has an account: tell the owner, change nothing. */
export function alreadyRegisteredMail(to: string): Mail {
  return {
    to,
    subject: "You already have an Antares account",
    text:
      "Someone, hopefully you, tried to create an Antares account with this e-mail address, but an account already exists.\n\n" +
      "You can log in at https://antaresscan.com/auth\n\n" +
      "If this was not you, ignore this e-mail: nothing changed.\n\n" +
      "Antares",
    html: wrap(
      "<p>Someone, hopefully you, tried to create an Antares account with this e-mail address, but an account already exists.</p>" +
        '<p>You can log in at <a href="https://antaresscan.com/auth" style="color:#0ca88c">antaresscan.com/auth</a>.</p>' +
        "<p>If this was not you, ignore this e-mail: nothing changed.</p>",
    ),
  };
}
