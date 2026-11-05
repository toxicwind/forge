/**
 * todo-enrich.ts — bge per-todo code correlation (squawk 20261103T181502Z).
 *
 * Embeds every fleet todo (pens/ranch/squawk/todo/*.md) with bge-m3 and attaches
 * its top code-surface matches as a `touches:` footer line, so any agent reading
 * a task sees the files it most likely concerns. No daemon, no webhook: one
 * enricher script, run on-demand.
 *
 * Canonical lane: @forge/hf (embedMany/cosine). Deterministic cache: sha256 of
 * the todo text → the embedded vector is recomputed only when the text changes.
 *
 * Usage:
 *   bun pens/barn/products/forge/hf/todo-enrich.ts [--root pens/ranch/squawk/todo] [--corpus pens] [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import { embedMany, cosine } from "./hf.ts";

const DEFAULT_TODO_DIR = "/home/toxic/pens/ranch/squawk/todo";
const DEFAULT_CORPUS_ROOT = "/home/toxic/pens";
const CACHE_FILE = "/home/toxic/.cache/fleet_todo_vectors.json";
const TOP_N = 3;

interface TodoDoc {
  file: string;
  text: string;
  hash: string;
  touches: Array<{ path: string; score: number }>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Load the deterministic embed cache {sha256 -> vector}. */
function loadCache(): Record<string, number[]> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, number[]>) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

/** Read all todo .md files (skip TODO.md index). */
function readTodos(dir: string): TodoDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "TODO.md")
    .map((f) => {
      const file = join(dir, f);
      const text = readFileSync(file, "utf-8");
      return { file, text, hash: sha256(text), touches: [] };
    });
}

/** Build a bounded code-surface corpus: walk root, collect .ts/.go/.py/.md/.sh paths. */
function buildCorpus(root: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e.startsWith(".")) continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if ([".ts", ".go", ".py", ".md", ".sh"].includes(extname(p))) out.push(p);
      if (out.length >= maxFiles) return;
    }
  };
  walk(root, 0);
  return out;
}

/** Strip the existing touches footer so re-runs don't accumulate. */
function stripTouches(text: string): string {
  return text.replace(/\n---\n### bge-xref[\s\S]*$/, "").trimEnd();
}

function formatTouches(touches: Array<{ path: string; score: number }>): string {
  if (!touches.length) return "";
  const rel = touches.map((t) => `${t.path} (${t.score.toFixed(2)})`).join(", ");
  return `\n---\n### bge-xref (${new Date().toISOString().slice(0, 16)}Z)\ntouches: ${rel}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const todoDir = args.find((a, i) => args[i - 1] === "--root") ?? DEFAULT_TODO_DIR;
  const corpusRoot = args.find((a, i) => args[i - 1] === "--corpus") ?? DEFAULT_CORPUS_ROOT;
  const dryRun = args.includes("--dry-run");

  const todos = readTodos(todoDir);
  if (!todos.length) {
    console.error("no todos found in " + todoDir);
    process.exit(64);
  }

  console.log(`embedding ${todos.length} todos against corpus root ${corpusRoot}...`);
  const corpus = buildCorpus(corpusRoot);
  console.log(`corpus: ${corpus.length} code surfaces`);

  const cache = loadCache();

  // Embed only todos whose text changed since last run (deterministic cache).
  const toEmbed = todos.filter((t) => !cache[t.hash]);
  if (toEmbed.length) {
    const texts = toEmbed.map((t) => t.text.slice(0, 2000));
    const vecs = await embedMany(texts);
    toEmbed.forEach((t, i) => (cache[t.hash] = vecs[i]));
    saveCache(cache);
    console.log(`embedded ${toEmbed.length} changed todos (${todos.length - toEmbed.length} cached)`);
  }

  // Embed corpus in batches; cache by path+size.
  const corpusVecs: number[][] = [];
  for (let i = 0; i < corpus.length; i += 64) {
    const slice = corpus.slice(i, i + 64);
    const key = slice.map((p) => sha256(p)).join("|");
    const cached = cache["corpus:" + key];
    if (cached) {
      corpusVecs.push(...(cache["corpus:" + key] as number[][]));
    } else {
      const vecs = await embedMany(slice.map((p) => relative(corpusRoot, p)));
      cache["corpus:" + key] = vecs;
      corpusVecs.push(...vecs);
    }
  }
  saveCache(cache);

  // For each todo, find top-N corpus surfaces by cosine.
  for (const t of todos) {
    const tv = cache[t.hash];
    if (!tv) continue;
    const scored = corpus.map((path, i) => ({ path, score: cosine(tv, corpusVecs[i]) }));
    scored.sort((a, b) => b.score - a.score);
    t.touches = scored.slice(0, TOP_N);
  }

  // Write back the touches footer.
  let changed = 0;
  for (const t of todos) {
    const clean = stripTouches(t.text);
    const updated = clean + formatTouches(t.touches);
    if (updated !== t.text) {
      if (!dryRun) writeFileSync(t.file, updated);
      changed++;
      console.log(`  ${relative(todoDir, t.file)} → ${t.touches.map((x) => x.path.split("/").pop()).join(", ")}`);
    }
  }
  console.log(`\ndone: ${changed} todos updated${dryRun ? " (dry-run, no writes)" : ""}`);
}

if (import.meta.main) await main();