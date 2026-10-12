// shared/session-probe.ts — what a failed /api/auth/me probe says about the stored session token.

/**
 * Only a 401 says the token itself is dead (expired, revoked, signed with a rotated secret): then it is dropped.
 * Any other failure (a 5xx while the API restarts, a 429, a 403 from a proxy) says nothing about the token. Dropping it on those
 * signed the user out of the extension, with no way back except logging in again on the website.
 */
export function isSessionRejected(status: number): boolean {
  return status === 401;
}
