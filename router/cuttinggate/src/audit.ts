/**
 * cuttinggate — live catalog audit implementation.
 *
 * Backs bin/catalog-audit.ts: probes both gateways (herd, flock), diffs the
 * live catalog against what each gateway actually serves, and names every id
 * the estate believes it can serve that no live gateway accepts.
 */
import { loadLiveCatalog, servingIds, type Probe, type LiveCatalog } from "./catalog";

export const DEFAULT_REPORT_PATH = "/home/toxic/estate/.state/provider-catalog-audit.json";

export type AuditReport = {
  readonly probes: readonly Probe[];
  readonly contractMatched: boolean;
  readonly staleMs: number;
  readonly unservable: readonly string[];
  readonly generatedAt: string;
  readonly liveCatalog: LiveCatalog;
};

export type AuditInput = {
  readonly herd: string;
  readonly herdToken: string;
  readonly flock: string;
  readonly flockToken: string;
};

export type AuditResult = { readonly ok: true; readonly report: AuditReport } | { readonly ok: false; readonly reason: string };

async function probeGateway(gateway: "herd" | "flock", root: string, token: string): Promise<Probe> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${root}/v1/models`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { gateway, ok: false, models: [], ms: Date.now() - t0, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: ReadonlyArray<{ id?: string } | string> };
    const models = (body.data ?? [])
      .map((m) => (typeof m === "string" ? m : m.id ?? ""))
      .filter((id) => id.length > 0);
    return { gateway, ok: true, models, ms: Date.now() - t0, error: null };
  } catch (e) {
    return { gateway, ok: false, models: [], ms: Date.now() - t0, error: (e as Error).message };
  }
}

export async function audit(input: AuditInput): Promise<AuditResult> {
  const loaded = loadLiveCatalog();
  if (loaded.status !== "ok") {
    const why = loaded.status === "unknown-contract"
      ? `unknown contract ${loaded.contract.saw} (expected ${loaded.contract.expected.join(" | ")})`
      : loaded.reason;
    return { ok: false, reason: `catalog load: ${loaded.status}: ${why}` };
  }

  const [herd, flock] = await Promise.all([
    probeGateway("herd", input.herd, input.herdToken),
    probeGateway("flock", input.flock, input.flockToken),
  ]);
  const probes = [herd, flock];
  const live = new Set<string>();
  for (const p of probes) {
    if (!p.ok) continue;
    for (const id of p.models) live.add(id.toLowerCase());
  }
  const unservable = [...servingIds(loaded.catalog)]
    .map((s) => s.id)
    .filter((id) => !live.has(id.toLowerCase()) && !live.has(id.toLowerCase().split("/").at(-1) ?? ""));

  const report: AuditReport = {
    probes,
    contractMatched: loaded.contract.canonical,
    staleMs: loaded.ageMs,
    unservable,
    generatedAt: loaded.catalog.generatedAt,
    liveCatalog: loaded.catalog,
  };
  return { ok: true, report };
}

export function renderReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`catalog generatedAt: ${report.generatedAt}  age: ${(report.staleMs / 1000).toFixed(0)}s  contract canonical: ${report.contractMatched}`);
  for (const p of report.probes) {
    lines.push(`probe ${p.gateway}: ${p.ok ? `ok ${p.models.length} models` : `FAILED ${p.error ?? ""}`} (${p.ms}ms)`);
  }
  lines.push(`catalog serving ids with no live gateway backing: ${report.unservable.length}`);
  for (const id of report.unservable.slice(0, 25)) {
    lines.push(`  - ${id}`);
  }
  if (report.unservable.length > 25) lines.push(`  … +${report.unservable.length - 25} more`);
  return lines.join("\n");
}
