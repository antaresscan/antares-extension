// scripts/issuer-assets/lib.mjs
//
// What the two scripts of the registry share. build.mjs writes api/_lib/issuer-assets.data.ts from Jupiter's verified list; watch.mjs (run
// every Monday by .github/workflows/issuer-registry-watch.yml) says when that list no longer matches what is committed. Pure functions
// apart from loadList, tested in __tests__/issuer-registry-watch.test.ts.
import fs from "node:fs";

export const SOURCE_URL = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";

/** The kinds, in the order of the data file, with the name each array is exported under. */
export const KINDS = [
  { kind: "stable", name: "STABLE_MINTS" },
  { kind: "tokenized", name: "TOKENIZED_MINTS" },
  { kind: "lst", name: "LST_MINTS" },
  { kind: "wrapped", name: "WRAPPED_MINTS" },
  { kind: "yield", name: "YIELD_MINTS" },
  { kind: "vault", name: "VAULT_MINTS" },
];

const STABLE_TAGS = ["stable"];
const TOKENIZED_TAGS = ["rwa", "stocks", "xstocks", "ondo", "prestocks", "equities", "commodities", "pre-ipo"];
const LST_TAGS = ["lst"];
// Wrapped majors: Jupiter's own `major` tag (a short, curated list: SOL itself, ETH, WBTC, xBTC, LBTC, zenBTC...), plus the ones it does not tag
// `major` and that were checked by hand against their issuer (the address must be in the verified list, or the build stops):
const WRAPPED_TAGS = ["major"];
export const WRAPPED_EXTRA = [
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", // cbBTC, Coinbase Wrapped BTC
  "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU", // tBTC, Threshold Bitcoin
];
// Vault shares: Jupiter's `jup-lend-earn` tag (the Jupiter Lend receipts), plus JLP. A Lend receipt is also tagged `yb`: the vault wins.
const VAULT_TAGS = ["jup-lend-earn"];
export const VAULT_EXTRA = [
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", // JLP, Jupiter Perps liquidity pool share (tags defi / strict, no issuer tag)
];
// Yield-bearing dollar tokens: Jupiter's `yb` (yield-bearing) tag, what is left once the vault shares are taken out.
const YIELD_TAGS = ["yb"];
// Wrapped SOL itself carries the lst tag in some lists: it is the asset the LSTs are priced in, not one of them.
const NEVER = new Set(["So11111111111111111111111111111111111111112"]);
const EXCLUDED_TAGS = ["meme", "launchpad", "deprecated", "duplicate", "internal"];

export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const has = (t, names) => (t.tags ?? []).some((x) => names.includes(x));
const uniq = (a) => [...new Set(a)].sort();

/** Jupiter's verified list: downloaded (5 MB), or read from a file saved earlier. */
export async function loadList(fromFile) {
  if (fromFile) return JSON.parse(fs.readFileSync(fromFile, "utf8"));
  const r = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Jupiter answered ${r.status}`);
  return r.json();
}

/** The registry that Jupiter's list gives: { stable: [mint...], tokenized: [...], ... }, each sorted, none twice, a mint in one kind only. */
export function classify(list) {
  const out = Object.fromEntries(KINDS.map(({ kind }) => [kind, []]));
  for (const t of list) {
    if (!BASE58.test(t.id ?? "") || NEVER.has(t.id) || !has(t, ["verified"]) || has(t, EXCLUDED_TAGS)) continue;
    if (has(t, STABLE_TAGS)) out.stable.push(t.id);
    else if (has(t, TOKENIZED_TAGS)) out.tokenized.push(t.id);
    else if (has(t, LST_TAGS)) out.lst.push(t.id);
    else if (has(t, WRAPPED_TAGS) || WRAPPED_EXTRA.includes(t.id)) out.wrapped.push(t.id);
    else if (has(t, VAULT_TAGS) || VAULT_EXTRA.includes(t.id)) out.vault.push(t.id);
    else if (has(t, YIELD_TAGS)) out.yield.push(t.id);
  }
  for (const { kind } of KINDS) out[kind] = uniq(out[kind]);
  return out;
}

/** The sanity checks that stop a build (or a weekly run) on a list that looks broken: too short, a hand-checked address gone, a kind nearly empty. */
export function assertPlausible(list, registry) {
  if (!Array.isArray(list) || list.length < 1000) throw new Error(`unexpected list (${Array.isArray(list) ? list.length : typeof list} entries)`);
  for (const m of WRAPPED_EXTRA) if (!registry.wrapped.includes(m)) throw new Error(`${m} (checked by hand) is no longer a verified token of the list, or is now in another kind`);
  for (const m of VAULT_EXTRA) if (!registry.vault.includes(m)) throw new Error(`${m} (checked by hand) is no longer a verified token of the list, or is now in another kind`);
  const n = (k) => registry[k].length;
  if (n("stable") < 10 || n("tokenized") < 100 || n("lst") < 50 || n("wrapped") < 5 || n("yield") < 5 || n("vault") < 5) {
    throw new Error(`suspiciously small result: ${KINDS.map(({ kind }) => `${n(kind)} ${kind}`).join(", ")}`);
  }
}

/** Reads the committed data file back: the date and size of the list it was built from, and the mints of each kind. Throws if its shape is not the one build.mjs writes. */
export function parseRegistry(text) {
  const head = /read by tags on (\d{4}-\d{2}-\d{2}) \((\d+) verified tokens\)/.exec(text);
  if (!head) throw new Error("issuer-assets.data.ts: the header (date and size of the list) was not found");
  const registry = { date: head[1], verified: Number(head[2]) };
  for (const { kind, name } of KINDS) {
    const block = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`).exec(text);
    if (!block) throw new Error(`issuer-assets.data.ts: ${name} was not found`);
    registry[kind] = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!registry[kind].every((m) => BASE58.test(m))) throw new Error(`issuer-assets.data.ts: ${name} holds something that is not a mint address`);
  }
  return registry;
}

/** What differs between the committed registry and the one Jupiter's list gives now: null when nothing, else { kinds: { kind: { added, removed } }, added, removed }. */
export function diffRegistry(committed, fresh) {
  const kinds = {};
  let added = 0, removed = 0;
  for (const { kind } of KINDS) {
    const before = new Set(committed[kind]), after = new Set(fresh[kind]);
    const a = fresh[kind].filter((m) => !before.has(m)), r = committed[kind].filter((m) => !after.has(m));
    kinds[kind] = { added: a, removed: r };
    added += a.length;
    removed += r.length;
  }
  return added + removed === 0 ? null : { kinds, added, removed };
}

/** mint -> symbol, from Jupiter's list (the committed file holds addresses only). */
export function symbolsOf(list) {
  return new Map(list.filter((t) => BASE58.test(t?.id ?? "")).map((t) => [t.id, t.symbol]));
}

/**
 * A symbol is text from a third-party list that ends up in a GitHub issue: letters, digits and a few signs only, 16 characters at most,
 * and always inside backticks, so it can neither mention anybody nor open a link or a heading.
 */
export function safeSymbol(s) {
  return String(s ?? "").replace(/[^A-Za-z0-9._$*+ -]/g, "").trim().slice(0, 16) || "?";
}

const LIST_CAP = 20;

/** The body of the GitHub issue (markdown). */
export function renderReport(diff, { symbols = new Map(), committedDate, committedVerified, freshVerified, today }) {
  const rows = KINDS.map(({ kind }) => `| ${kind} | ${diff.kinds[kind].added.length} | ${diff.kinds[kind].removed.length} |`).join("\n");
  const listOf = (title, mints, showSymbol) => {
    if (!mints.length) return "";
    const shown = mints.slice(0, LIST_CAP).map((m) => (showSymbol ? `- \`${safeSymbol(symbols.get(m))}\` \`${m}\`` : `- \`${m}\``)).join("\n");
    return `\n**${title}** (${mints.length})\n${shown}${mints.length > LIST_CAP ? `\n- … and ${mints.length - LIST_CAP} more` : ""}\n`;
  };
  const detail = KINDS.map(({ kind }) => {
    const { added, removed } = diff.kinds[kind];
    return added.length + removed.length === 0 ? "" : `\n### ${kind}\n${listOf("Added", added, true)}${listOf("Removed", removed, false)}`;
  }).join("");
  return `Jupiter's verified list no longer matches the registry of issuer-backed tokens (\`api/_lib/issuer-assets.data.ts\`): **${diff.added} added, ${diff.removed} removed** since it was built on ${committedDate} (${committedVerified} verified tokens then, ${freshVerified} on ${today}).

This is not an emergency. A token that is not in the registry is judged like any other token: an honest stablecoin, stock or staking token that is new to the list can come out RUG or DANGER (a false alarm), never SAFE by mistake. A token removed from the list is judged the strict way again.

| Kind | Added | Removed |
|---|---|---|
${rows}
${detail}
### To refresh

1. \`node scripts/issuer-assets/build.mjs\` and read the diff of \`api/_lib/issuer-assets.data.ts\`.
2. \`REPLAY_UPDATE=1 npx vitest run __tests__/replay\`, then list the verdicts that move.
3. If any moves: bump \`ENGINE_VERSION_MANUAL\` (\`api/_lib/constants.ts\`), and show the moved verdicts in the pull request.
4. One pull request. This issue closes itself on the first Monday after the registry matches the list again.

_Opened by .github/workflows/issuer-registry-watch.yml. The list is third-party data: the names above are shown for reading only, the registry is by address._
`;
}
