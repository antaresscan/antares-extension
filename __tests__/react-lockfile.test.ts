// __tests__/react-lockfile.test.ts — react and react-dom must always be
// the same version in package.json AND in package-lock.json.
//
// Why: react-dom's bundle compares its own version with the one reported
// by `react` and throws "Minified React error #527" at load time when they
// differ. On 2026-10-09 Dependabot #782 bumped react to 19.3.0 but left
// react-dom at 19.2.7 in the lockfile, and the Options page of the built
// extension crashed on load. Nothing in CI noticed. This test fails the
// moment the two drift apart again (the Dependabot "react" group in
// .github/dependabot.yml is the first line of defence, this is the second).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
interface PackageJson {
  dependencies: Record<string, string>;
}
interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
interface PackageLock {
  packages: Record<string, LockEntry>;
}

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageJson;
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as PackageLock;

const lockedVersion = (name: string): string | undefined =>
  lock.packages[`node_modules/${name}`]?.version;

describe("react / react-dom versions", () => {
  it("are locked to the same version in package-lock.json", () => {
    const react = lockedVersion("react");
    const reactDom = lockedVersion("react-dom");
    expect(react, "react missing from package-lock.json").toBeTruthy();
    expect(reactDom, "react-dom missing from package-lock.json").toBeTruthy();
    expect(reactDom).toBe(react);
  });

  it("are pinned to that exact version in package.json (no range)", () => {
    const locked = lockedVersion("react");
    expect(pkg.dependencies.react).toBe(locked);
    expect(pkg.dependencies["react-dom"]).toBe(locked);
  });

  it("are the same version in the lockfile root entry as in package.json", () => {
    const rootDeps = lock.packages[""]?.dependencies ?? {};
    expect(rootDeps.react).toBe(pkg.dependencies.react);
    expect(rootDeps["react-dom"]).toBe(pkg.dependencies["react-dom"]);
  });

  it("react-dom's own peer range accepts the locked react", () => {
    const peer = lock.packages["node_modules/react-dom"]?.peerDependencies?.react;
    expect(peer, "react-dom peerDependencies.react missing").toBeTruthy();
    // ^19.3.0 → minimum 19.3.0 must not exceed the locked react version.
    const min = peer!.replace(/^[\^~>=\s]+/, "").split(".").map(Number);
    const have = lockedVersion("react")!.split(".").map(Number);
    const ok =
      have[0] === min[0] &&
      (have[1] > min[1] || (have[1] === min[1] && have[2] >= min[2]));
    expect(ok, `locked react ${have.join(".")} does not satisfy react-dom's peer ${peer}`).toBe(true);
  });
});
