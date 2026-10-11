import { describe, it, expect } from "vitest";
import { formatReport } from "../scripts/usage-report";
import { CREDIT_BASIS, type ProviderUsage, type UsageReport } from "../api/_lib/usage";

const u = (p: Partial<ProviderUsage>): ProviderUsage => ({ calls: 0, ok: 0, refused: 0, denied: 0, failed: 0, skipped: 0, credits: 0, ...p });

function report(days: Array<{ date: string; helius?: Partial<ProviderUsage>; gecko?: Partial<ProviderUsage>; solscan?: Partial<ProviderUsage> }>): UsageReport {
  const totals: UsageReport["totals"] = {};
  const add = (p: "helius" | "geckoterminal" | "solscan", v: Partial<ProviderUsage>) => {
    const t = (totals[p] ??= u({}));
    for (const [k, n] of Object.entries(v)) t[k as keyof ProviderUsage] += n as number;
  };
  return {
    days: days.map((d) => {
      const providers: UsageReport["days"][number]["providers"] = {};
      if (d.helius) { providers.helius = u(d.helius); add("helius", d.helius); }
      if (d.gecko) { providers.geckoterminal = u(d.gecko); add("geckoterminal", d.gecko); }
      if (d.solscan) { providers.solscan = u(d.solscan); add("solscan", d.solscan); }
      return { date: d.date, providers };
    }),
    totals,
    basis: CREDIT_BASIS,
  };
}

describe("formatReport", () => {
  it("lists each API with its requests, refusals and units, and the period", () => {
    const text = formatReport(report([{ date: "2026-10-10", helius: { calls: 100, ok: 100, credits: 5000 } }, { date: "2026-10-11", helius: { calls: 50, ok: 50, credits: 2500 }, gecko: { calls: 10, ok: 8, refused: 2 } }]));
    expect(text).toContain("du 2026-10-10 au 2026-10-11 (2 jours");
    expect(text).toMatch(/helius\s+150\s+150\s+0\s+0\s+0\s+0\s+7 500/);
    expect(text).toMatch(/geckoterminal\s+10\s+8\s+2/);
  });

  it("projects the Helius credits over 30 days from the days that have activity, and compares with the plan", () => {
    const text = formatReport(report([{ date: "2026-10-10", helius: { calls: 1, ok: 1, credits: 200_000 } }, { date: "2026-10-11", helius: { calls: 1, ok: 1, credits: 400_000 } }]), { planCredits: 10_000_000 });
    expect(text).toContain("300 000 crédits par jour");
    expect(text).toContain("9 000 000 sur 30 jours");
    expect(text).toContain("90 % d'un forfait de 10 000 000");
    expect(text).toContain("proche du plafond");
  });

  it("does not warn when the rhythm is far below the plan", () => {
    const text = formatReport(report([{ date: "2026-10-11", helius: { calls: 1, ok: 1, credits: 10_000 } }]), { planCredits: 10_000_000 });
    expect(text).not.toContain("proche du plafond");
    expect(text).not.toContain("À regarder");
  });

  it("flags a refusal rate of 5 % or more, rejected keys, and an opened circuit breaker", () => {
    const text = formatReport(report([{ date: "2026-10-11", gecko: { calls: 100, ok: 90, refused: 10 }, solscan: { calls: 3, denied: 3, skipped: 2 } }]));
    expect(text).toContain("À regarder");
    expect(text).toContain("geckoterminal : 10.0 % des requêtes refusées");
    expect(text).toContain("solscan : 3 requête(s) refusée(s) pour la clé");
    expect(text).toContain("solscan : 2 requête(s) non envoyées");
  });

  it("does not flag a low refusal rate", () => {
    const text = formatReport(report([{ date: "2026-10-11", gecko: { calls: 100, ok: 96, refused: 4 } }]));
    expect(text).not.toContain("des requêtes refusées");
  });

  it("says so when nothing was counted", () => {
    expect(formatReport(report([{ date: "2026-10-11" }]))).toContain("aucune requête comptée");
  });

  it("explains what a unit is for the APIs that appear", () => {
    const text = formatReport(report([{ date: "2026-10-11", helius: { calls: 1, ok: 1, credits: 10 } }]));
    expect(text).toContain("Ce que vaut une « unité »");
    expect(text).toContain("Helius credits");
  });
});
