// __tests__/public-texts.test.ts
//
// The texts people read before they install or pay (the Chrome Web Store listing in docs/cws, the README, privacy.html) promised things the
// code does not do: "seven layers" when five sources feed the score, "blacklists", a scan history and a CSV/JSON export for Pro (neither exists),
// Critical Actors "in the overlay" (it is on the Full Analysis page). The privacy policy did not name the second content script (the website
// bridge), the typefaces asked from Google, nor the sign-up counters. Each sentence below was checked against the code, and is tied to it here:
// change the code and this test fails until the text says the same.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { priceUsd } from "../api/_lib/payments";

const root = process.cwd();
const read = (file: string): string => readFileSync(resolve(root, file), "utf8").split(String.fromCharCode(13)).join("");
/** What a reader of an HTML page sees: no tags, one space between words. */
const visible = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

const listings = { EN: read("docs/cws/store-listing-en.md"), FR: read("docs/cws/store-listing-fr.md") };
/** The dated correction notes quote the old sentences on purpose: they are blockquotes, and are left out of the checks. */
const body = (md: string): string => md.split("\n").filter((l) => !l.startsWith(">")).join("\n");
const privacy = visible(read("privacy.html"));
const section = (from: string, to: string): string => privacy.slice(privacy.indexOf(from), privacy.indexOf(to));

describe("the Chrome Web Store listing is within the dashboard's limits", () => {
  it.each(Object.entries(listings))("%s: the short description fits in 132 characters", (_lang, md) => {
    const short = md.split("## ")[2].match(/```\n([\s\S]*?)\n```/)?.[1] ?? "";
    expect(short.length, "the short description was not found").toBeGreaterThan(40);
    expect(short.length).toBeLessThanOrEqual(132);
  });
});

describe("the prices in the texts are the prices of the code", () => {
  it("Pro and Yearly default prices", () => {
    expect(priceUsd("monthly")).toBe(24.99);
    expect(priceUsd("yearly")).toBe(149.99);
    expect(listings.EN).toContain("$24.99/30d");
    expect(listings.EN).toContain("$149.99/yr");
    expect(listings.FR).toContain("24,99 $/30j");
    expect(listings.FR).toContain("149,99 $/an");
    const readme = read("README.md");
    expect(readme).toContain("$24.99 / 30 days");
  });
});

describe("the sentences that were false do not come back", () => {
  const FALSE_CLAIMS: Array<[string, RegExp]> = [
    ["seven layers / sources (five sources feed the score)", /7[- ]layer|7 couches|seven (independent )?(layers|sources)|sept (couches|sources)/i],
    ["blacklists (nothing reads one)", /blacklist/i],
    ["a CSV/JSON export (there is none)", /CSV ?\/ ?JSON/i],
    ["a Pro scan history (no screen shows it)", /scan history \+|historique de scans \+/i],
    ["sell tax (the engine reads Token-2022 transfer fees)", /sell-tax|taxe de vente/i],
    ["a honeypot check (the Sell cell says whether the token itself can block a sale)", /honeypot risk|risque honeypot/i],
    ["a heatmap in Insider Watch (it is a feed of the 10 biggest wallets)", /heatmap/i],
  ];
  it.each(FALSE_CLAIMS)("%s", (_name, re) => {
    for (const [lang, md] of Object.entries(listings)) expect(body(md), `${lang} listing`).not.toMatch(re);
    expect(read("README.md")).not.toMatch(/scan history, CSV/i);
  });

  it("the Safe Gate does not list a honeypot among what blocks a SAFE", () => {
    expect(body(listings.EN)).not.toMatch(/open LP, honeypot/i);
    expect(body(listings.FR)).not.toMatch(/LP ouvert, honeypot/i);
  });
});

describe("what the listing says the overlay and the Full Analysis page show", () => {
  it("Critical Actors is on the Full Analysis page, and the overlay code has none", () => {
    for (const file of readdirSync(resolve(root, "contents"), { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      expect(read(`contents/${file}`), `contents/${file}`).not.toMatch(/critical ?actors/i);
    }
    const en = body(listings.EN);
    expect(en.indexOf("Critical Actors")).toBeGreaterThan(en.indexOf("In the Full Analysis page"));
    const fr = body(listings.FR);
    expect(fr.indexOf("Critical Actors")).toBeGreaterThan(fr.indexOf("Dans la page Full Analysis"));
  });

  it("the five tabs it names exist in the page's code", () => {
    const pageCode = (readdirSync(resolve(root, "js")) as string[]).filter((f) => f.endsWith(".js")).map((f) => read(`js/${f}`)).join("\n");
    for (const tab of ["Insider Watch", "Buy/Sell Flow", "Wash Volume", "Sniper Map", "Exit Liquidity"]) {
      expect(pageCode, tab).toContain(tab);
      expect(listings.EN, tab).toContain(tab);
      expect(listings.FR, tab).toContain(tab);
    }
  });

  it("the sell sizes of Exit Liquidity are the ones of the code", () => {
    expect(read("js/compute.js")).toContain("[100, 1000, 5000, 10000, 20000]");
    expect(listings.EN).toContain("$100 / $1K / $5K / $10K / $20K");
    expect(listings.FR).toContain("100 $ / 1 K$ / 5 K$ / 10 K$ / 20 K$");
  });

  it("the Safe Gate blocks on every kind of flag the listing names", () => {
    const hard = read("api/_lib/constants.ts").match(/HARD_BLOCK_REASONS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    for (const reason of ["lp", "mint", "freeze", "deceptive_name", "concentration"]) expect(hard, reason).toContain(`"${reason}"`);
  });
});

describe("privacy.html names what the code does", () => {
  it("section 4 names every site the website bridge runs on", () => {
    const matches = read("contents/antares-website-bridge.ts").match(/matches: \[([\s\S]*?)\]/)?.[1] ?? "";
    const hosts = [...matches.matchAll(/"https:\/\/([a-z0-9.-]+)\/\*"/g)].map((m) => m[1]);
    expect(hosts.length, "the bridge's sites were not found").toBeGreaterThanOrEqual(3);
    const where = section("4. Where the Extension injects", "5. Third-party processors");
    for (const host of hosts) expect(where, host).toContain(host);
    expect(where).toMatch(/second content script/i);
  });

  it("section 5 declares Google Fonts, and the overlay's own request only while the overlay makes it", () => {
    const table = section("5. Third-party processors", "6. International transfers");
    const pages = (readdirSync(root) as string[]).filter((f) => f.endsWith(".html") && /fonts\.(googleapis|gstatic)\.com/.test(read(f)));
    expect(pages, "no page loads Google Fonts any more: take the row out of the policy").not.toEqual([]);
    const start = table.indexOf("Google (Fonts)");
    expect(start, "the Google Fonts row is missing").toBeGreaterThan(-1);
    const fontsRow = table.slice(start, table.indexOf("policy", start));
    const overlayAsksGoogle = /fonts\.googleapis\.com/.test(read("contents/modules/components.ts"));
    if (overlayAsksGoogle) expect(fontsRow, "the overlay asks Google for fonts: the row must say so").toMatch(/overlay on the trading sites/i);
    else expect(fontsRow, "the overlay no longer asks Google for fonts: take it out of the row").not.toMatch(/overlay on the trading sites/i);
  });

  it("section 5 does not credit a source with what the engine does not use from it", () => {
    const table = section("5. Third-party processors", "6. International transfers");
    expect(table).not.toMatch(/GoPlus Security\s*\|?\s*Honeypot/i);
    expect(read("api/_lib/constants.ts")).toMatch(/SOLSCAN_AGE_AND_HOLDERS_ONLY = true/);
    expect(table, "Solscan is read for the age, the holder count and the price history only").not.toMatch(/Solscan[^|]*\|?\s*Token metadata, age, transfers/i);
  });

  it("sections 3.5 and 7 give the sign-up limits of the code", () => {
    const router = read("api/auth/[action].ts");
    const perAddress = router.match(/SIGNUP_MAILS_PER_ADDRESS_PER_DAY = (\d+)/)?.[1];
    const perNetwork = router.match(/SIGNUPS_PER_NETWORK_PER_HOUR = (\d+)/)?.[1];
    expect(perAddress && perNetwork, "the limits were not found in the router").toBeTruthy();
    expect(privacy).toContain(`at most ${perAddress}, kept 24 hours`);
    expect(privacy).toContain(`at most ${perNetwork}, kept 1 hour`);
    expect(section("7. Data retention", "8. Chrome permissions")).toMatch(/Sign-up counters/);
  });

  it("section 7: the rug database keeps RUG on evidence for the TTL of the code, and never a DANGER alone", () => {
    const code = read("api/_lib/rugdb.ts");
    const days = code.match(/RUG_TTL_SECONDS = (\d+) \* 24 \* 3600/)?.[1];
    expect(days).toBeTruthy();
    const retention = section("7. Data retention", "8. Chrome permissions");
    expect(retention).toContain(`kept for ${days} days`);
    expect(retention).not.toMatch(/flagged as RUG or DANGER/);
    expect(code).toMatch(/data\.risk !== "RUG"/);
  });
});
