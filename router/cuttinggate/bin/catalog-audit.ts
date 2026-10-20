#!/usr/bin/env bun
/**
 * catalog-audit — is the model catalog true?
 *
 * Reads the live catalog, probes both gateways, and names every id the estate
 * believes it can serve that no live gateway will accept. This is the check
 * that would have caught `estate/free`, `local-fast`, and the nemotron
 * cloud model on the day they were declared.
 *
 *   cuttinggate/bin/catalog-audit.ts              # audit, exit 1 on findings
 *   cuttinggate/bin/catalog-audit.ts --find <id>  # resolve one model id
 *   cuttinggate/bin/catalog-audit.ts --rewrite    # emit the canonical contract
 *   cuttinggate/bin/catalog-audit.ts --json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadLiveCatalog, resolve, writeLiveCatalog, DEFAULT_CATALOG_PATH, gatewayRoot } from "../src/catalog";
import { audit, renderReport, DEFAULT_REPORT_PATH } from "../src/audit";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

/** Ports come from the estate SSOT; fall back to the documented defaults. */
const PORTS_ENV = process.env.ESTATE_PORTS_ENV ?? "/home/toxic/estate/config/ports.env";
function portFromEnv(name: string, fallback: string): string {
  try {
    const text = readFileSync(PORTS_ENV, "utf8");
    const m = text.match(new RegExp(`^${name}=\\s*["']?([^"'\\s#]+)`, "m"));
    return m?.[1] ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Read a credential without printing it. Values never reach stdout or a log.
 *
 * The client-facing flock key is NOT in the secretsmith vault — it lives in
 * its own 36-byte file at ~/.tau/flock.key. Looking only in .secrets produced
 * a 401 that then inflated the unservable count by ~200 ids, which is how an
 * audit starts lying about the thing it is auditing.
 */
function secretFrom(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const home = process.env.HOME ?? "";
  try {
    const m = readFileSync(`${home}/.secrets`, "utf8").match(
      new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\n#]+)["']?`, "m"),
    );
    if (m?.[1]) return m[1].trim();
  } catch {
    /* no vault */
  }
  // Standalone key files, for credentials kept out of the vault on purpose.
  for (const file of [`${home}/.tau/flock.key`, `${home}/.tau/herd.key`]) {
    try {
      const v = readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      /* absent */
    }
  }
  return "";
}

const flockToken = secretFrom("FLOCK_KEY");
const auditResult = await audit({
  herd: gatewayRoot(`http://127.0.0.1:${portFromEnv("HERD_PORT", "25100")}`),
  herdToken: secretFrom("HERD_KEY") || "herd",
  flock: gatewayRoot(`http://127.0.0.1:${portFromEnv("FLOCK_ROUTER_PORT", "25193")}`),
  flockToken,
});

if (flags.has("--find")) {
  const want = positional[0] ?? "";
  const loaded = loadLiveCatalog();
  if (loaded.status !== "ok") {
    process.stderr.write(`catalog unreadable: ${loaded.reason}\n`);
    process.exit(1);
  }
  const hits = resolve(loaded.catalog, want);
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify({ query: want, matches: hits }, null, 2)}\n`);
  } else if (!hits.length) {
    process.stdout.write(`${want}: NO RESOLUTION — not in the live catalog under any provider\n`);
  } else {
    process.stdout.write(`${want}:\n`);
    for (const h of hits.slice(0, 10)) {
      process.stdout.write(`  ${h.id}  @${h.provider}  ${h.exact ? "exact" : "fuzzy"}  ${h.live ? "live" : "QUARANTINED"}  (${h.reason})\n`);
    }
  }
  process.exit(0);
}

if (!auditResult.ok) {
  process.stderr.write(`catalog audit failed: ${auditResult.reason}\n`);
  process.exit(1);
}

if (flags.has("--rewrite")) {
  const loaded = loadLiveCatalog();
  if (loaded.status !== "ok") {
    process.stderr.write(`catalog unreadable: ${loaded.reason}\n`);
    process.exit(1);
  }
  writeLiveCatalog(DEFAULT_CATALOG_PATH, {
    deadIds: loaded.catalog.deadIds,
    providers: loaded.catalog.providers,
  });
  process.stderr.write(`rewrote ${DEFAULT_CATALOG_PATH} with the canonical contract\n`);
}

const report = auditResult.report;
if (flags.has("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${renderReport(report)}\n`);
  mkdirSync(dirname(DEFAULT_REPORT_PATH), { recursive: true });
  writeFileSync(DEFAULT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

// Exit 1 when the catalog lies: a contract we had to tolerate, a stale file, a
// gateway that did not answer, or an id we advertise but cannot serve.
const stale = report.staleMs > 15 * 60_000;
const probesFailed = report.probes.some((p) => !p.ok);
const lying = report.unservable.length > 0;
if (!report.contractMatched || stale || probesFailed || lying) {
  process.stderr.write("\nVERDICT: catalog does not match reality — fix before trusting a route\n");
  process.exit(1);
}
process.exit(0);
