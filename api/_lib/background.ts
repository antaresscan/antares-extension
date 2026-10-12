// api/_lib/background.ts — work that must finish after the answer has been sent.
import { waitUntil } from "@vercel/functions";
import { logger } from "./logger";

/**
 * Keep the function alive until `work` has settled, without making the response wait for it.
 *
 * A Vercel function is frozen as soon as it has answered: a Redis write that was started but not finished is suspended with it, and
 * may never complete. For the scan cache that is an entry lost, i.e. one more cold scan (and its upstream bill) for the next visitor
 * of the token. waitUntil() tells the platform to hold the function until the promise settles.
 *
 * Outside a Vercel request (unit tests, a local run) there is no context to hand the promise to and waitUntil does nothing: the work
 * simply runs as it always did. A failure of the work is logged and never reaches the user, who already has an answer.
 * `work` may be anything a caller could have forgotten to await, including nothing (a mocked writer returns undefined).
 */
export function keepAlive(work: unknown, label: string): void {
  const settled = Promise.resolve(work).then(
    () => undefined,
    (e: unknown) => {
      logger.warn("background", `${label} failed after the answer`, { error: String(e) });
    },
  );
  try {
    waitUntil(settled);
  } catch (e: unknown) {
    logger.warn("background", "waitUntil unavailable", { label, error: String(e) });
  }
}
