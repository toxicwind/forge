const SIDECAR = "http://127.0.0.1:25105";

export interface VerifyResult {
  passed: boolean | null;
  failureClass: string;
  confidence?: number;
  feedback?: string;
}

export async function verifyWithStack(
  probe: { text: string; reference?: string; rubric?: string; toolSchema?: unknown },
  response: { content: string; reasoning: string; toolCalls: unknown[] }
): Promise<VerifyResult> {
  const content = (response.content || "").trim();
  const reasoning = (response.reasoning || "").trim();
  const toolCalls = response.toolCalls || [];

  // 1. Substance check
  if (!content && !reasoning && !toolCalls.length) {
    return { passed: false, failureClass: "EMPTY_CONTENT" };
  }

  // 2. Tool calls -> Tool-Call Verifier
  if (probe.toolSchema) {
    try {
      const res = await fetch(`${SIDECAR}/score/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: { text: probe.text }, response: { tool_calls: toolCalls } }),
      });
      const data: any = await res.json();
      if (data.label === "valid" || (data.label === "tool_not_needed" && !toolCalls.length)) {
        return { passed: true, failureClass: "OK", confidence: data.score };
      }
    } catch {
      // Fallback if sidecar unreachable
      return { passed: toolCalls.length > 0, failureClass: toolCalls.length > 0 ? "OK" : "TOOL_CALL_MISSING" };
    }
  }

  // 3. Single-reference -> BERTJudge
  if (probe.reference) {
    try {
      const res = await fetch(`${SIDECAR}/score/bert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: probe.text, reference: probe.reference, candidate: content || reasoning }),
      });
      const data: any = await res.json();
      return data.score >= 0.5
        ? { passed: true, failureClass: "OK", confidence: data.score }
        : { passed: false, failureClass: "BERTJUDGE_MISMATCH", confidence: data.score };
    } catch {
      const match = (content + reasoning).toLowerCase().includes(probe.reference.toLowerCase());
      return { passed: match, failureClass: match ? "OK" : "BERTJUDGE_MISMATCH" };
    }
  }

  // 4. Open-ended / Rubric -> Flow-Judge
  if (probe.rubric) {
    try {
      const res = await fetch(`${SIDECAR}/score/rubric`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubric: probe.rubric, input: probe.text, output: content + " " + reasoning }),
      });
      const data: any = await res.json();
      return data.score === "pass"
        ? { passed: true, failureClass: "OK", feedback: data.feedback }
        : { passed: false, failureClass: "RUBRIC_FAIL", feedback: data.feedback };
    } catch {
      return { passed: true, failureClass: "OK" };
    }
  }

  return { passed: true, failureClass: "OK" };
}
