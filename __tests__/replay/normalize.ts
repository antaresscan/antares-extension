// __tests__/replay/normalize.ts
//
// What a replay compares: the verdict and everything that explains it, without what changes from one run to the next
// (request id, timestamps, the AI summary text, the candles).
export interface NormalizedScan {
  risk: string;
  score: number;
  confidence: number | null;
  /** "severity:label", sorted: the order flags are emitted in is not part of the contract. */
  flags: string[];
  sources_used: string[];
  layers: Record<string, { available: boolean; trust: number }>;
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  honeypot: boolean | null;
  lpBurned: boolean | null;
  lpLocked: boolean | null;
  holders: number | null;
  top10HolderPct: number | null;
  topHolderPct: number | null;
  safeBlocked: boolean | null;
  safeBlockedReasons: string[];
}

interface RawScan {
  risk?: string; score?: number; confidence?: number;
  flags?: Array<{ label?: string; severity?: string }>;
  sources_used?: string[];
  layers?: Record<string, { available?: boolean; trust?: number }>;
  mintAuthority?: boolean | null; freezeAuthority?: boolean | null; honeypot?: boolean | null;
  lpBurned?: boolean | null; lpLocked?: boolean | null;
  holders?: number | null; top10HolderPct?: number | null; topHolderPct?: number | null;
  safeBlocked?: boolean; safeBlockedReasons?: string[];
}

const round = (n: number | null | undefined, digits = 2): number | null =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null;
const tri = (v: boolean | null | undefined): boolean | null => (typeof v === "boolean" ? v : null);

export function normalizeScan(raw: unknown): NormalizedScan {
  const b = (raw ?? {}) as RawScan;
  const layers: NormalizedScan["layers"] = {};
  for (const [name, l] of Object.entries(b.layers ?? {}).sort(([x], [y]) => x.localeCompare(y))) {
    layers[name] = { available: l?.available === true, trust: round(l?.trust, 3) ?? 0 };
  }
  return {
    risk: String(b.risk ?? "?"),
    score: typeof b.score === "number" ? b.score : -1,
    confidence: typeof b.confidence === "number" ? b.confidence : null,
    flags: (b.flags ?? []).map((f) => `${f.severity ?? "?"}:${f.label ?? "?"}`).sort(),
    sources_used: [...(b.sources_used ?? [])].sort(),
    layers,
    mintAuthority: tri(b.mintAuthority),
    freezeAuthority: tri(b.freezeAuthority),
    honeypot: tri(b.honeypot),
    lpBurned: tri(b.lpBurned),
    lpLocked: tri(b.lpLocked),
    holders: typeof b.holders === "number" ? b.holders : null,
    top10HolderPct: round(b.top10HolderPct),
    topHolderPct: round(b.topHolderPct),
    safeBlocked: tri(b.safeBlocked),
    safeBlockedReasons: [...(b.safeBlockedReasons ?? [])].sort(),
  };
}
