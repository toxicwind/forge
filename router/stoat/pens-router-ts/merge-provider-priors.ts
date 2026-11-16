#!/usr/bin/env bun
/**
 * merge-provider-priors.ts — fold provider-bench runs into bench-priors.json.
 *
 * Reads bench-priors.json + bench-runs/*.json (latest run per provider wins)
 * and writes updated provider priors for the newly-benched providers.
 *
 * Elo rules (same as gen-bench-priors.py, no invented scales):
 *   quality_mean (0-2) -> 1000 + (q - 1.0) * 80
 *   latency is DELIBERATELY excluded from priors: the router's live
 *   candidateScore already penalizes latency via latencyEMA/50.
 *
 * Honesty rules:
 *   - providers with no run stay flat 1000 / "unbenched"
 *   - a run where the provider was rate-limited or key-dead does NOT
 *     generate a quality prior — it records the outage as basis text
 *     and keeps 1000
 *   - legacy sources (guidellm/model-max/router-proof) are preserved
 *     verbatim; this script only adds/updates the provider-bench source
 *     and the priors for providers it benched
 *
 * Usage: bun merge-provider-priors.ts [--runs-dir bench-runs] [--priors bench-priors.json]
 */

interface ModelResult {
  model: string;
  liveness: { healthy: boolean; reason: string; latencyMs: number | null };
  quality: { scores: number[]; mean: number; n: number };
  latencyP50Ms: number | null;
  rateLimited: boolean;
  keyDead: boolean;
}

interface RunResult {
  tool: string;
  version: number;
  startedAt: string;
  provider: string;
  config: { reqs: number; concurrency: number; timeoutMs: number };
  models: ModelResult[];
  providerRateLimited: boolean;
  providerKeyDead: boolean;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string): string => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : d;
  };
  const runsDir = opt("runs-dir", "bench-runs");
  const priorsPath = opt("priors", "bench-priors.json");

  const priorsFile = Bun.file(priorsPath);
  if (!(await priorsFile.exists())) {
    process.stderr.write(`no priors file at ${priorsPath}\n`);
    process.exit(1);
  }
  const doc = (await priorsFile.json()) as {
    generated_ts: string;
    sources: Record<string, unknown>;
    priors: Record<string, Record<string, unknown>>;
    elo_rule?: string;
  };

  // latest run per provider
  const glob = new Bun.Glob("*.json");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: runsDir, absolute: true })) files.push(f);
  files.sort();
  const latest = new Map<string, RunResult>();
  for (const f of files) {
    try {
      const r = (await Bun.file(f).json()) as RunResult;
      if (r.tool !== "provider-bench" || !r.provider) continue;
      const prev = latest.get(r.provider);
      if (!prev || r.startedAt > prev.startedAt) latest.set(r.provider, r);
    } catch {
      /* unreadable run file: skip, don't poison priors */
    }
  }
  if (latest.size === 0) {
    process.stderr.write(`no provider-bench runs in ${runsDir}\n`);
    process.exit(1);
  }

  const runFiles: string[] = [];
  for (const [provider, r] of latest) {
    const healthy = r.models.filter((m) => m.liveness.healthy);
    const hf = r.models.length > 0 ? healthy.length / r.models.length : 0;
    // quality mean over HEALTHY models only: an unhealthy model (404/429/5xx)
    // is a liveness/entitlement signal, not a quality signal — penalizing the
    // provider's quality prior for models the router will never route to
    // would be dishonest. healthy_frac already carries the liveness story.
    const qmeans = healthy.map((m) => m.quality.mean);
    const qmean = qmeans.length > 0 ? qmeans.reduce((a, b) => a + b, 0) / qmeans.length : 0;
    const p50s = r.models.map((m) => m.latencyP50Ms).filter((x): x is number => x !== null);
    const latP50 = median(p50s);

    if (r.providerRateLimited || r.providerKeyDead || healthy.length === 0) {
      // outage run: honest flat prior, basis says why
      const firstFail = r.models.find((m) => !m.liveness.healthy)?.liveness.reason;
      const why = r.providerRateLimited
        ? "rate-limited during bench run"
        : r.providerKeyDead
          ? "provider key dead during bench run"
          : firstFail
            ? `no healthy completion (first failure: ${firstFail.slice(0, 120)})`
            : "no model produced a healthy completion";
      doc.priors[provider] = {
        elo: 1000,
        n_models: r.models.length,
        healthy_frac: Math.round(hf * 1000) / 1000,
        basis: `provider-bench (outage: ${why}, ${r.startedAt.slice(0, 10)})`,
      };
    } else {
      const elo = Math.round(1000 + (qmean - 1.0) * 80);
      doc.priors[provider] = {
        elo,
        quality_mean: Math.round(qmean * 1000) / 1000,
        healthy_frac: Math.round(hf * 1000) / 1000,
        healthy_n: healthy.length,
        latency_p50_ms: latP50 !== null ? Math.round(latP50 * 10) / 10 : null,
        n_models: r.models.length,
        models: r.models.map((m) => m.model),
        basis: "provider-bench",
      };
    }
    runFiles.push(`${provider}@${r.startedAt.slice(0, 10)}`);
    const pr = doc.priors[provider]!;
    console.log(`  ${provider}: elo=${pr.elo} basis=${pr.basis}`);
  }

  doc.generated_ts = new Date().toISOString();
  doc.sources["provider_bench"] = {
    runs_dir: runsDir,
    runs: runFiles,
    instrument:
      "liveness: 1 real completion/model (semantic-failure aware); quality: deterministic instruction-following exact=2/contains=1/empty=0, N reqs/model; latency p50; fail-fast, no retries",
  };
  if (doc.elo_rule && !doc.elo_rule.includes("provider-bench")) {
    doc.elo_rule += "; provider-bench quality_mean(0-2)->1000+(q-1)*80; outage runs keep flat 1000 with basis text";
  }

  await Bun.write(priorsPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${priorsPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`merge-provider-priors: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
