// NO HARDCODED ARM LISTS. Ever.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CORPUS_V2 } from "./corpus-v2.ts";
import { TOOL_SCENARIOS } from "./tools.ts";
import { LONGCTX_SCENARIOS } from "./longctx.ts";
import { isChatCapable } from "../router_config.ts";
import { verifyWithStack } from "./verifier_client.ts";

const ROUTER = "http://127.0.0.1:25104";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    verbose: { type: "boolean", default: false },
    single: { type: "string" },
    providers: { type: "string" },
    capability: { type: "string" },
    dry: { type: "boolean", default: false },
  },
  strict: false,
});

export interface Arm {
  provider: string;
  model: string;
}

async function discoverArms(): Promise<Arm[]> {
  const res = await fetch(`${ROUTER}/v1/models`);
  const json: any = await res.json();

  const arms: Arm[] = [];
  for (const m of json.data ?? []) {
    const provider = m.flock?.provider ?? m.x_estate?.provider ?? m.owned_by;
    if (!provider) continue;
    if (provider === "llama-swap" || provider === "alias") continue;
    if (!isChatCapable(m.id)) continue;
    arms.push({ provider, model: m.id });
  }

  const seen = new Set<string>();
  return arms.filter((a) => {
    const k = `${a.provider}/${a.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildProbes() {
  const all = [...CORPUS_V2, ...TOOL_SCENARIOS, ...LONGCTX_SCENARIOS];
  if (values.capability) {
    return all.filter((p) => p.capability === values.capability || p.id === values.capability);
  }
  return all;
}

async function fireProbe(arm: Arm, probe: any) {
  const armKey = `${arm.provider}/${arm.model}`;

  if (probe.suitableFor && !probe.suitableFor(armKey)) {
    return {
      arm: armKey,
      probe,
      status: 0,
      content: "",
      tokens: 0,
      latencyMs: 0,
      failureClass: "NOT_SUITABLE_FOR_TASK",
      passed: false,
      skipped: true,
    };
  }

  const start = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);

  let status = 0;
  let content = "";
  let reasoning = "";
  let toolCalls: unknown[] = [];
  let tokens = 0;
  let error = "";

  try {
    const res = await fetch(`${ROUTER}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${arm.provider}/${arm.model}`,
        messages: [{ role: "user", content: probe.text }],
        max_tokens: probe.maxTokens,
        tools: probe.tools,
        stream: true,
      }),
      signal: ac.signal,
    });
    status = res.status;

    if (!res.ok) {
      error = await res.text();
    } else if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const j = JSON.parse(line.slice(6));
            const d = j.choices?.[0]?.delta;
            if (d?.content) { content += d.content; tokens++; }
            if (d?.reasoning_content) { reasoning += d.reasoning_content; }
            if (d?.tool_calls) { toolCalls.push(...d.tool_calls); }
          } catch {}
        }
      }
    }
  } catch (e: any) {
    error = e.name === "AbortError" ? "TIMEOUT" : String(e.message || e);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Math.round(performance.now() - start);

  // Evaluate with Classifier Stack (BERTJudge, ToolVerifier, Flow-Judge)
  const vRes = await verifyWithStack(
    {
      text: probe.text,
      reference: probe.reference || (probe.id === "general-qa" ? "Paris" : probe.id === "reasoning-puzzle" ? "0.05" : undefined),
      rubric: probe.rubric || (probe.id === "security-code-audit" ? "Identify integer overflow and bounds validation" : undefined),
      toolSchema: probe.tools ? true : undefined,
    },
    { content, reasoning, toolCalls }
  );

  let failureClass = vRes.failureClass;
  let passed = vRes.passed === true;

  if (error.includes("ECONNRESET") || error.includes("aborted")) {
    failureClass = "STREAM_INTERRUPTED";
    passed = false;
  } else if (error === "TIMEOUT") {
    failureClass = "TIMEOUT";
    passed = false;
  } else if (status >= 400) {
    failureClass = `UPSTREAM_${status}`;
    passed = false;
  }

  return {
    arm: armKey,
    probe,
    status,
    content,
    tokens,
    latencyMs,
    error,
    failureClass,
    passed,
    confidence: vRes.confidence,
    skipped: false,
  };
}

async function main() {
  const discovered = await discoverArms();
  console.log(`[seed] discovered ${discovered.length} arms`);

  if (values.dry) return;

  let armList = discovered;
  if (values.single) {
    const [p, ...m] = (values.single as string).split("/");
    armList = [{ provider: p, model: m.join("/") }];
  } else if (values.providers) {
    const provs = new Set((values.providers as string).split(","));
    armList = discovered.filter((a) => provs.has(a.provider));
  }

  console.log(`[seed] executing across ${armList.length} arms`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = `seed/runs/${stamp}`;
  mkdirSync(runDir, { recursive: true });

  const transcriptLines: string[] = [];
  const failureLines: string[] = [];

  function out(line = "") {
    if (values.verbose || values.single) console.log(line);
    transcriptLines.push(line);
  }

  const probes = buildProbes();
  for (const arm of armList) {
    const armKey = `${arm.provider}/${arm.model}`;
    for (const probe of probes) {
      out(`┌─ [${armKey}] ${probe.capability}/${probe.id}`);
      out(`│ REQUEST: prompt="${probe.text.slice(0, 80).replace(/\n/g, " ")}..."`);

      const res = await fireProbe(arm, probe);
      if (res.skipped) {
        out(`│ VERDICT:      ? N/A (NOT_SUITABLE_FOR_TASK)`);
      } else {
        out(`│ RESPONSE (${res.latencyMs}ms, status=${res.status})`);
        out(`│   content:    ${JSON.stringify(res.content.slice(0, 100))}`);
        if (res.error) out(`│   error:      ${res.error.slice(0, 100)}`);
        out(`│ VERDICT:      ${res.passed ? `✓ PASS (classifier: ${res.failureClass})` : `✗ FAIL (${res.failureClass})`}`);

        if (!res.passed) {
          failureLines.push(`[${armKey}] ${probe.capability}/${probe.id} -> ${res.failureClass}`);
          if (res.error) failureLines.push(`   Error: ${res.error}`);
        }
      }
      out(`└────────────────────────────────────────────────────────────────────────\n`);
    }
  }

  writeFileSync(`${runDir}/transcript.log`, transcriptLines.join("\n"), "utf8");
  writeFileSync(`${runDir}/failures.txt`, failureLines.join("\n"), "utf8");
  console.log(`[seed] complete. Output logged to ${runDir}/transcript.log`);
}

main().catch(console.error);
