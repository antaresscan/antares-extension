// scripts/usage-report.ts — how much each upstream API was used, refused, and (estimated) billed.
//
//   CRON_SECRET=... npx tsx scripts/usage-report.ts [days=7] [--plan-credits 10000000] [--url https://antares-extension.vercel.app]
//
// It reads /api/health?usage=<days> (api/health.ts), which is reserved to the owner (CRON_SECRET, the same secret as the cron job).
// --plan-credits is the monthly Helius allowance of your plan (Developer: 10 million): the report then says what share of it the
// current rhythm would use in a month.
import type { UsageReport, ProviderUsage, Provider } from "../api/_lib/usage";

const ORDER: Provider[] = ["helius", "goplus", "rugcheck", "dexscreener", "geckoterminal", "solscan", "gemini", "publicrpc", "other"];
const pad = (v: string | number, n: number, left = false): string => (left ? String(v).padStart(n) : String(v).padEnd(n));
const num = (n: number): string => n.toLocaleString("fr-FR").split(String.fromCharCode(0x202f)).join(" ").split(String.fromCharCode(0xa0)).join(" ");

export interface FormatOptions { planCredits?: number }

/** A readable report: one line per API, the share of requests refused, and a monthly projection of the Helius credits. */
export function formatReport(report: UsageReport, opts: FormatOptions = {}): string {
  const out: string[] = [];
  const first = report.days[0]?.date;
  const last = report.days[report.days.length - 1]?.date;
  out.push(`Usage des API amont, du ${first} au ${last} (${report.days.length} jour${report.days.length > 1 ? "s" : ""}, UTC)`, "");
  out.push([pad("API", 14), pad("requêtes", 10, true), pad("répondues", 10, true), pad("429/503", 9, true), pad("401/403", 9, true), pad("échecs", 8, true), pad("non envoyées", 13, true), pad("unités (est.)", 14, true), "  refus"].join(" "));

  const warnings: string[] = [];
  const totals = report.totals;
  for (const p of ORDER) {
    const u: ProviderUsage | undefined = totals[p];
    if (!u || (u.calls === 0 && u.skipped === 0)) continue;
    const refusedPct = u.calls > 0 ? (u.refused / u.calls) * 100 : 0;
    out.push([pad(p, 14), pad(num(u.calls), 10, true), pad(num(u.ok), 10, true), pad(num(u.refused), 9, true), pad(num(u.denied), 9, true), pad(num(u.failed), 8, true), pad(num(u.skipped), 13, true), pad(num(u.credits), 14, true), `  ${refusedPct.toFixed(1)} %`].join(" "));
    if (refusedPct >= 5) warnings.push(`${p} : ${refusedPct.toFixed(1)} % des requêtes refusées (429/503) : la limite gratuite est atteinte, ou le forfait est trop petit.`);
    if (u.denied > 0) warnings.push(`${p} : ${num(u.denied)} requête(s) refusée(s) pour la clé ou le forfait (401/403).`);
    if (u.skipped > 0) warnings.push(`${p} : ${num(u.skipped)} requête(s) non envoyées, le disjoncteur s'était ouvert (panne ou refus répétés).`);
  }
  if (out.length === 3) out.push("(aucune requête comptée sur cette période : rien n'a encore été écrit, ou Redis n'est pas configuré)");

  const helius = totals.helius;
  const daysWithHelius = report.days.filter((d) => (d.providers.helius?.credits ?? 0) > 0);
  if (helius && helius.credits > 0 && daysWithHelius.length > 0) {
    const perDay = helius.credits / daysWithHelius.length;
    const month = perDay * 30;
    out.push("", `Helius : ${num(Math.round(perDay))} crédits par jour en moyenne (${daysWithHelius.length} jour(s) avec activité), soit environ ${num(Math.round(month))} sur 30 jours.`);
    if (opts.planCredits && opts.planCredits > 0) {
      const share = (month / opts.planCredits) * 100;
      out.push(`  = ${share.toFixed(0)} % d'un forfait de ${num(opts.planCredits)} crédits par mois.${share >= 80 ? " ⚠ proche du plafond." : ""}`);
      if (share >= 80) warnings.push(`helius : le rythme actuel consommerait ${share.toFixed(0)} % du forfait mensuel.`);
    }
  }

  out.push("", "Ce que vaut une « unité » :");
  for (const p of ORDER) if (totals[p] && (totals[p]!.calls > 0)) out.push(`  ${pad(p, 14)} ${report.basis[p]}`);
  if (warnings.length > 0) out.push("", "À regarder :", ...warnings.map((w) => `  ⚠ ${w}`));
  return out.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const days = Number(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--plan-credits" && args[i - 1] !== "--url") ?? 7);
  const base = (flag("--url") ?? process.env.ANTARES_URL ?? "https://antares-extension.vercel.app").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) { console.error("CRON_SECRET is required (the value set in the Vercel project)."); process.exit(2); }
  const res = await fetch(`${base}/api/health?usage=${days}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (res.status === 401) { console.error("Refused (401): CRON_SECRET does not match the one of the deployment."); process.exit(1); }
  if (!res.ok) { console.error(`Unexpected answer: HTTP ${res.status}`); process.exit(1); }
  console.log(formatReport((await res.json()) as UsageReport, { planCredits: Number(flag("--plan-credits")) || undefined }));
}

if (process.argv[1] && /usage-report\.[cm]?[jt]s$/.test(process.argv[1])) void main();
