#!/usr/bin/env bun
// hf/cli.ts — `forge hf` CLI: classify / embed from the command line.
// Canonical lane: imports @forge/hf (hf.ts). Usage:
//   forge hf classify <text> --labels "Sports:sports channel,Movies:movie channel"
//   forge hf embed <text>...
import { embedClassify, embedMany } from "./hf.ts";

function parseLabels(raw: string): Array<{ label: string; prompt: string }> {
  return raw.split(",").map((pair) => {
    const [label, ...rest] = pair.split(":");
    return { label: label.trim(), prompt: rest.join(":").trim() };
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "forge hf classify  <text> --labels 'Sports:sports chan,Movies:movie chan'",
        "forge hf embed     <text>...",
      ].join("\n"),
    );
    process.exit(cmd === "--help" ? 0 : 64);
  }
  if (cmd === "classify") {
    const text = rest.find((a) => !a.startsWith("--"));
    const li = rest.indexOf("--labels");
    if (!text || li < 0 || !rest[li + 1]) {
      console.error("classify needs <text> --labels 'Label:prompt,...'");
      process.exit(64);
    }
    const labels = parseLabels(rest[li + 1]);
    const [r] = await embedClassify([text], labels, { minScore: 0.18, fallback: "Other" });
    console.log(JSON.stringify({ input: text, label: r.label, score: Number(r.score.toFixed(3)) }));
    return;
  }
  if (cmd === "embed") {
    const texts = rest.filter((a) => !a.startsWith("--"));
    const vecs = await embedMany(texts);
    console.log(JSON.stringify({ dims: vecs[0]?.length ?? 0, count: vecs.length, vectors: vecs }));
    return;
  }
  console.error(`unknown hf command: ${cmd}`);
  process.exit(64);
}

await main();