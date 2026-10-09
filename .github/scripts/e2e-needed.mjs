// Decide whether a CI run needs the end-to-end tests.
//
// The e2e job tests the Vercel DEPLOYMENT of a commit (see resolve-deployment.sh).
// That only tells us something when the commit changes what gets deployed or the
// e2e itself. A bump of typescript-eslint, a change to the extension overlay or
// to the docs cannot alter a single HTTP response, so the e2e adds minutes and a
// chance of a red unrelated to the change. This script looks at the files the
// run changes and answers.
//
// It runs, in this order:
//   1. a push to a branch that has an open pull request → NO (the pull_request
//      run of the same commit does the work; testing it twice is waste);
//   2. any changed file under DEPLOYED or E2E_INFRA → YES;
//   3. a change to package.json / package-lock.json → YES only if a package that
//      is part of the PRODUCTION install changed (dependencies, not devDependencies),
//      or if the e2e tooling (@playwright/test) changed;
//   4. otherwise → NO.
// Anything it cannot determine (API error, huge diff, unparsable lockfile) → YES:
// a wrongly skipped e2e is worse than an unneeded one.
//
// Environment (set by the workflow): REPO, EVENT_NAME, PR_NUMBER, BASE_SHA,
// HEAD_SHA, BEFORE_SHA, REF_NAME, DEFAULT_BRANCH, GH_TOKEN, and the standard
// GITHUB_OUTPUT / GITHUB_STEP_SUMMARY. For local use with a pull request only
// REPO, EVENT_NAME=pull_request and PR_NUMBER are needed.
//
// Output: `needed=true|false` and `reasons=<text>` in $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Files that end up in the deployment and shape what the e2e checks. */
export const DEPLOYED = [
  /^api\//, // serverless functions
  /^shared\//, // imported by the functions (and by the extension)
  /^js\//, // scripts of the pages served by Vercel
  /^[^/]+\.html$/, // pages served from the repo root (token, privacy, ...)
  /^vercel\.json$/, // headers, routes, function limits
  /^tsconfig\.json$/, // how the functions are compiled
];

/** The e2e itself, and the way CI runs it: a change to these must be tested. */
export const E2E_INFRA = [
  /^e2e\//,
  /^playwright\.config\.ts$/,
  /^\.github\/scripts\//,
  /^\.github\/workflows\/ci\.yml$/,
];

const E2E_TOOLING = ["@playwright/test", "playwright", "playwright-core"];

/** Split changed files into the ones that matter and the ones that do not. */
export function classifyFiles(files) {
  const deployed = [];
  const infra = [];
  for (const f of files) {
    if (DEPLOYED.some((re) => re.test(f))) deployed.push(f);
    else if (E2E_INFRA.some((re) => re.test(f))) infra.push(f);
  }
  return { deployed, infra };
}

/** Sorted "path@version" of every package that is part of the production install. */
function productionPackages(lock) {
  const out = [];
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (path === "" || entry?.dev === true) continue;
    out.push(`${path}@${entry?.version ?? "?"}`);
  }
  return out.sort();
}

/**
 * What of package.json + lockfile ends up in production. Two commits with the
 * same fingerprint install the same production code and build it the same way.
 * Returns null when it cannot be computed.
 */
export function productionFingerprint(pkg, lock) {
  if (!pkg || !lock || typeof lock !== "object" || !lock.packages) return null;
  return JSON.stringify({
    dependencies: pkg.dependencies ?? {},
    engines: pkg.engines ?? {},
    build: [pkg.scripts?.build ?? null, pkg.scripts?.["vercel-build"] ?? null, pkg.scripts?.postinstall ?? null],
    installed: productionPackages(lock),
  });
}

/** Versions of the e2e runner, which live in devDependencies but decide how the e2e behaves. */
export function toolingFingerprint(pkg, lock) {
  if (!pkg || !lock || typeof lock !== "object" || !lock.packages) return null;
  return JSON.stringify(
    E2E_TOOLING.map((name) => [
      name,
      pkg.devDependencies?.[name] ?? pkg.dependencies?.[name] ?? null,
      lock.packages[`node_modules/${name}`]?.version ?? null,
    ]),
  );
}

/**
 * The decision. Pure: everything it needs is passed in.
 * @param {{files: string[]|null, base?: {pkg: any, lock: any}, head?: {pkg: any, lock: any}}} input
 *   `files` null = the file list could not be obtained.
 * @returns {{needed: boolean, reasons: string[]}}
 */
export function decide({ files, base, head }) {
  if (!Array.isArray(files)) return { needed: true, reasons: ["could not list the changed files: running the e2e to be safe"] };

  const { deployed, infra } = classifyFiles(files);
  const reasons = [];
  for (const f of deployed) reasons.push(`deployed file changed: ${f}`);
  for (const f of infra) reasons.push(`e2e or its CI wiring changed: ${f}`);

  if (files.some((f) => f === "package.json" || f === "package-lock.json")) {
    const bp = productionFingerprint(base?.pkg, base?.lock);
    const hp = productionFingerprint(head?.pkg, head?.lock);
    if (bp === null || hp === null) reasons.push("package files changed and could not be compared: running the e2e to be safe");
    else if (bp !== hp) reasons.push("a production dependency, engine or build script changed");

    const bt = toolingFingerprint(base?.pkg, base?.lock);
    const ht = toolingFingerprint(head?.pkg, head?.lock);
    if (bt !== null && ht !== null && bt !== ht) reasons.push("the e2e runner (@playwright/test) changed");
  }

  return { needed: reasons.length > 0, reasons };
}

// ── GitHub access (only used when run as a script) ────────────────────────────

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function rawFile(repo, path, ref) {
  try {
    return JSON.parse(gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}?ref=${ref}`]));
  } catch {
    return null;
  }
}

function listFiles(env) {
  const { REPO, EVENT_NAME, PR_NUMBER, HEAD_SHA, BEFORE_SHA, DEFAULT_BRANCH } = env;
  if (EVENT_NAME === "pull_request") {
    const out = gh(["api", "--paginate", `repos/${REPO}/pulls/${PR_NUMBER}/files`, "--jq", ".[].filename"]);
    return out.split("\n").filter(Boolean);
  }
  // push: compare against the previous tip, or against the default branch for a new branch
  const from = !BEFORE_SHA || /^0+$/.test(BEFORE_SHA) ? DEFAULT_BRANCH : BEFORE_SHA;
  const res = JSON.parse(gh(["api", `repos/${REPO}/compare/${from}...${HEAD_SHA}`]));
  // The compare endpoint truncates at 300 files: treat a truncated list as unknown.
  if (!Array.isArray(res.files) || res.files.length >= 300) return null;
  return { files: res.files.map((f) => f.filename), baseRef: res.merge_base_commit?.sha ?? from };
}

function emit(needed, reasons) {
  const text = reasons.length ? reasons.slice(0, 10).join("; ") + (reasons.length > 10 ? `; … (+${reasons.length - 10})` : "") : "no deployed file and no production dependency changed";
  console.log(`e2e needed: ${needed}\n  ${text}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\nreasons=${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = reasons.length ? reasons.slice(0, 10).map((r) => `- ${r}`).join("\n") : "- no deployed file and no production dependency changed";
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### E2E: ${needed ? "running" : "skipped"}\n${lines}\n`);
  }
}

function main() {
  const env = { ...process.env };
  try {
    // A push to a branch with an open pull request is covered by the pull_request run.
    if (env.EVENT_NAME === "push" && env.REF_NAME && env.REF_NAME !== env.DEFAULT_BRANCH) {
      const owner = env.REPO.split("/")[0];
      const open = JSON.parse(gh(["api", `repos/${env.REPO}/pulls?head=${owner}:${encodeURIComponent(env.REF_NAME)}&state=open`]));
      if (open.length > 0) return emit(false, [`covered by the pull_request run of #${open[0].number} for the same commit`]);
    }

    // Local convenience: derive the commits of a pull request from its number.
    if (env.EVENT_NAME === "pull_request" && (!env.BASE_SHA || !env.HEAD_SHA)) {
      const pr = JSON.parse(gh(["api", `repos/${env.REPO}/pulls/${env.PR_NUMBER}`]));
      env.BASE_SHA = pr.base.sha;
      env.HEAD_SHA = pr.head.sha;
    }

    const listed = listFiles(env);
    const files = Array.isArray(listed) ? listed : listed?.files ?? null;
    const baseRef = env.EVENT_NAME === "pull_request" ? env.BASE_SHA : listed?.baseRef;

    let base;
    let head;
    if (Array.isArray(files) && files.some((f) => f === "package.json" || f === "package-lock.json")) {
      base = { pkg: rawFile(env.REPO, "package.json", baseRef), lock: rawFile(env.REPO, "package-lock.json", baseRef) };
      head = { pkg: rawFile(env.REPO, "package.json", env.HEAD_SHA), lock: rawFile(env.REPO, "package-lock.json", env.HEAD_SHA) };
    }

    const { needed, reasons } = decide({ files, base, head });
    return emit(needed, reasons);
  } catch (e) {
    return emit(true, [`could not decide (${String(e.message ?? e).split("\n")[0].slice(0, 120)}): running the e2e to be safe`]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
