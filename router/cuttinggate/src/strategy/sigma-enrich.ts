/**
 * sigma-enrich.ts — Sigma catalog backfill for live model metadata.
 *
 * Borrows wintermi/sigma's generated model catalog (sigma-catalog.json,
 * snapshot 2026-09-23, MIT-licensed upstream) as a LOWEST-PRECEDENCE
 * metadata layer: live provider discovery always wins; sigma fills only
 * fields the live /models payload lacks (context_window, pricing hints,
 * tool support). This makes the 2M-context pin and /v1/models context
 * advertising work for providers whose /models carry no context metadata.
 *
 * Attribution: https://github.com/wintermi/sigma — catalog.json is
 * generated upstream; we re-snapshot it here on a refresh cadence.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(HERE, "sigma-catalog.json");

export interface SigmaModel {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsThinking: boolean;
  cost: { inputPerMillion: number; outputPerMillion: number } | null;
}

let index: Map<string, SigmaModel> | null = null;
let snapshotDate = "";

function normalize(id: string): string {
  return id.toLowerCase().replace(/^[^/a-z0-9]*\/\//, "");
}

function variants(id: string): string[] {
  const n = normalize(id);
  const out = new Set<string>([n]);
  // strip one provider-ish prefix segment: "x-ai/grok-4.7" -> "grok-4.7"
  const slash = n.indexOf("/");
  if (slash > 0) out.add(n.slice(slash + 1));
  // strip dot-prefix: "xai.grok-4.3" -> "grok-4.3"
  const dot = n.indexOf(".");
  if (dot > 0 && dot < 8) out.add(n.slice(dot + 1));
  return [...out];
}

function loadIndex(): Map<string, SigmaModel> {
  if (index) return index;
  index = new Map();
  try {
    if (!existsSync(CATALOG_PATH)) return index;
    const d = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    snapshotDate = String(d.snapshotDate || "");
    const rows: any[] = [...(d.textModels || []), ...(d.imageModels || [])];
    for (const m of rows) {
      const rec: SigmaModel = {
        id: String(m.id || ""),
        provider: String(m.provider || ""),
        contextWindow: Number(m.contextWindow || 0),
        maxOutputTokens: Number(m.maxOutputTokens || 0),
        supportsTools: !!m.supportsTools,
        supportsThinking: !!m.supportsThinking,
        cost: m.cost
          ? {
              inputPerMillion: Number(m.cost.inputPerMillion || 0),
              outputPerMillion: Number(m.cost.outputPerMillion || 0),
            }
          : null,
      };
      for (const v of variants(rec.id)) {
        // prefer the row with the largest context window on collision
        const cur = index.get(v);
        if (!cur || rec.contextWindow > cur.contextWindow) index.set(v, rec);
      }
    }
  } catch {
    // catalog missing/unparseable: enrichment is best-effort, never fatal
  }
  return index;
}

/** Look up sigma metadata for an estate (provider, modelId) pair. */
export function sigmaLookup(
  _provider: string,
  modelId: string,
): SigmaModel | null {
  const idx = loadIndex();
  for (const v of variants(modelId)) {
    const hit = idx.get(v);
    if (hit) return hit;
  }
  return null;
}

/**
 * applySigmaBackfill — walk LIVE_MODEL_META and fill missing
 * context_window / max_output_tokens from the sigma catalog. Live
 * discovery metadata always wins: only absent fields are filled.
 * Returns the number of models enriched.
 */
export function applySigmaBackfill(
  liveMeta: Record<string, Record<string, unknown>>,
): number {
  const idx = loadIndex();
  if (idx.size === 0) return 0;
  let enriched = 0;
  for (const meta of Object.values(liveMeta)) {
    for (const [id, raw] of Object.entries(meta)) {
      const m = raw as Record<string, unknown>;
      if (typeof m !== "object" || !m) continue;
      const hasCtx =
        typeof m["context_window"] === "number" ||
        typeof m["context_length"] === "number";
      if (hasCtx) continue;
      const hit = sigmaLookup("", id);
      if (hit && hit.contextWindow > 0) {
        m["context_window"] = hit.contextWindow;
        if (hit.maxOutputTokens > 0 && !m["max_output_tokens"])
          m["max_output_tokens"] = hit.maxOutputTokens;
        if (hit.cost && !m["pricing"]) {
          m["pricing"] = {
            prompt: String(hit.cost.inputPerMillion / 1e6),
            completion: String(hit.cost.outputPerMillion / 1e6),
          };
        }
        m["sigma_snapshot"] = snapshotDate;
        enriched++;
      }
    }
  }
  return enriched;
}

export function sigmaCatalogInfo(): { rows: number; snapshot: string } {
  const idx = loadIndex();
  return { rows: idx.size, snapshot: snapshotDate };
}
