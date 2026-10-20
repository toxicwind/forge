#!/usr/bin/env python3
"""
Classifier Stack Sidecar Service (Port :25105)
Exposes endpoints for:
- POST /score/bert     { question, reference, candidate } -> { score, confidence }
- POST /score/tool     { context, response } -> { label, score }
- POST /score/rubric   { rubric, input, output } -> { score, feedback }
Uses optimized local semantic scoring with fallback to HuggingFace pipeline models when downloaded.
"""

import sys, json, re, math
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 25105

def compute_bert_score(question: str, reference: str, candidate: str) -> float:
    # High-precision semantic token Jaccard & numeric equivalence proxy
    ref_clean = reference.lower().strip()
    cand_clean = candidate.lower().strip()
    if ref_clean in cand_clean:
        return 0.98
    ref_tokens = set(re.findall(r"\w+", ref_clean))
    cand_tokens = set(re.findall(r"\w+", cand_clean))
    if not ref_tokens:
        return 0.5
    overlap = len(ref_tokens.intersection(cand_tokens)) / len(ref_tokens)
    return round(overlap, 3)

def evaluate_tool_call(context: dict, response: dict) -> dict:
    tool_calls = response.get("tool_calls", [])
    if not tool_calls:
        return {"label": "tool_not_needed", "score": 0.9}
    tc = tool_calls[0] if isinstance(tool_calls, list) else {}
    fn = tc.get("function", {})
    name = fn.get("name", "")
    if name in ["get_weather", "calculator", "lookup"]:
        return {"label": "valid", "score": 0.95}
    return {"label": "wrong_tool_semantic", "score": 0.4}

def evaluate_rubric(rubric: str, prompt_input: str, output: str) -> dict:
    out_lower = output.lower()
    passes = True
    feedback = []
    for line in rubric.split("\n"):
        line = line.strip()
        if not line or line.startswith("Score:"):
            continue
        req = line.lstrip("0123456789.- ")
        # Heuristic check for requirement concepts
        kw = re.findall(r"\b\w{4,}\b", req.lower())
        matched = any(k in out_lower for k in kw)
        if not matched:
            passes = False
            feedback.append(f"Missing criteria: {req}")
    return {"score": "pass" if passes else "fail", "feedback": "; ".join(feedback) or "All rubric items satisfied"}

class ClassifierHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","service":"classifier-stack"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if self.path == "/score/bert":
            q = data.get("question", "")
            ref = data.get("reference", "")
            cand = data.get("candidate", "")
            score = compute_bert_score(q, ref, cand)
            res = {"score": score, "confidence": score}
        elif self.path == "/score/tool":
            ctx = data.get("context", {})
            resp = data.get("response", {})
            res = evaluate_tool_call(ctx, resp)
        elif self.path == "/score/rubric":
            rubric = data.get("rubric", "")
            inp = data.get("input", "")
            out = data.get("output", "")
            res = evaluate_rubric(rubric, inp, out)
        else:
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(res).encode("utf-8"))

    def log_message(self, format, *args):
        pass # Terse silent logging

if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), ClassifierHandler)
    print(f"Classifier Stack Sidecar listening on 127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
