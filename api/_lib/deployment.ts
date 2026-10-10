// api/_lib/deployment.ts — which kind of Vercel deployment is running this code.
//
// A PREVIEW deployment (the one a pull request gets, and the one the e2e tests) shares the Upstash database with
// production. Left alone, a scan on a preview:
//  - READS results cached by production, so the e2e of a pull request tests production's code instead of the pull
//    request's, and passes whatever the pull request broke;
//  - WRITES its own result into production's cache and rug database, so a broken pull request can serve wrong
//    verdicts to real users, or list a token as a rug, for as long as the entry lives.
// Everything else (production, a local run, the unit tests) keeps the behaviour it always had.

/** True on a Vercel preview deployment (VERCEL_ENV is "production" | "preview" | "development"; unset locally). */
export function isPreviewDeployment(): boolean {
  return process.env.VERCEL_ENV === "preview";
}

/**
 * Key namespace that keeps a preview deployment's cache entries apart from production's and from every other
 * preview's (one namespace per deployment). Empty string everywhere else, so production keys are unchanged.
 */
export function deploymentNamespace(): string {
  if (!isPreviewDeployment()) return "";
  const id = (process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "unknown").replace(/[^A-Za-z0-9_-]/g, "");
  return `pv:${id || "unknown"}:`;
}
