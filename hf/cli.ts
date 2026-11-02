#!/usr/bin/env bun
// hf/cli.ts — `forge hf` CLI: classify / embed from the command line.
// Canonical lane: imports @forge/hf (hf.ts). Usage:
//   forge hf classify <text> --labels "Sports:sports channel,Movies:movie channel"
//   forge hf embed <text>...
import { embedClassify, embedMany } from "./hf.ts";
import { w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, firewallClassify } from "./oracle.ts";

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
        "forge hf oracle    w1..w8|all — bge-m3 black-box experiments (live)",
        "forge hf firewall  <text> — W2 stream-leak detector (prose vs markup)",
      ].join("\n"),
    );
    process.exit(cmd === "--help" ? 0 : 64);
  }
  if (cmd === "firewall") {
    const text = rest.find((a) => !a.startsWith("--"));
    if (!text) {
      console.error("firewall needs <text> — a stream chunk to classify");
      process.exit(64);
    }
    const r = await firewallClassify(text);
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === "oracle") {
    const which = rest.find((a) => !a.startsWith("--"));
    const WORKSTREAMS: Record<string, () => Promise<unknown>> = {
      w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11,
    };
    if (!which || which === "help") {
      console.log("forge hf oracle w1..w8|all — bge-m3 black-box experiments");
      process.exit(which === "help" ? 0 : 64);
    }
    if (which === "all") {
      console.log("=== bge-m3 oracle: W1..W8 ===\n");
      for (const fn of Object.values(WORKSTREAMS)) await fn();
      return;
    }
    const fn = WORKSTREAMS[which];
    if (!fn) {
      console.error(`unknown oracle workstream: ${which} (w1..w11 or all)`);
      process.exit(64);
    }
    await fn();
    return;
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