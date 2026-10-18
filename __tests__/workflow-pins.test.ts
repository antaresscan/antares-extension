import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Every action a workflow uses runs with the permissions and the secrets of the job. A tag (`@v4`) can be moved by whoever controls the action's repository (or by whoever
// takes it over): the job would then run THEIR code, in `submit.yml` with the keys of the Chrome Web Store. A commit SHA cannot be moved. Dependabot (github-actions ecosystem,
// .github/dependabot.yml) proposes the update of a pinned action from its `# vX` comment, so pinning costs nothing in upkeep.

/** The `uses:` values of a workflow or composite-action file that are not a local action (`./...`) and are not pinned to a full 40-character commit SHA. */
export function unpinnedUses(yaml: string): string[] {
  const bad: string[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
    if (!m) continue;
    const ref = m[1];
    if (ref.startsWith("./")) continue;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-/]+@[0-9a-f]{40}$/.test(ref)) bad.push(ref);
  }
  return bad;
}

function filesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (/\.ya?ml$/.test(name)) out.push(p);
  }
  return out;
}

describe("GitHub Actions are pinned to a commit", () => {
  const sha = "11d5960a326750d5838078e36cf38b85af677262";

  it("a tag, a branch or a short SHA is refused; a full SHA (with or without a comment) and a local action are accepted", () => {
    expect(unpinnedUses("      - uses: actions/checkout@v4")).toEqual(["actions/checkout@v4"]);
    expect(unpinnedUses("        uses: PlasmoHQ/bpp@main")).toEqual(["PlasmoHQ/bpp@main"]);
    expect(unpinnedUses("      - uses: actions/checkout@11d5960")).toEqual(["actions/checkout@11d5960"]);
    expect(unpinnedUses(`      - uses: actions/checkout@${sha}`)).toEqual([]);
    expect(unpinnedUses(`      - uses: actions/checkout@${sha} # v4`)).toEqual([]);
    expect(unpinnedUses(`      - uses: github/codeql-action/analyze@${sha}`)).toEqual([]);
    expect(unpinnedUses("      - uses: ./.github/actions/install-deps")).toEqual([]);
    expect(unpinnedUses("      - run: echo uses: nothing")).toEqual([]);
  });

  it("every external action of every workflow and composite action is pinned", () => {
    const files = [...filesUnder(".github/workflows"), ...filesUnder(".github/actions")];
    expect(files.length).toBeGreaterThan(0);
    const all: Record<string, string[]> = {};
    for (const f of files) {
      const bad = unpinnedUses(readFileSync(f, "utf8"));
      if (bad.length) all[f.split(String.fromCharCode(92)).join("/")] = bad;
    }
    expect(all).toEqual({});
  });

  it("the pinned actions say which version they are (the comment Dependabot reads to propose the update)", () => {
    for (const f of filesUnder(".github/workflows")) {
      for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
        if (/^\s*-?\s*uses:\s*[^.\s]\S*@[0-9a-f]{40}/.test(line)) expect(line, f).toMatch(/@[0-9a-f]{40}\s+#\s*v\d/);
      }
    }
  });
});
