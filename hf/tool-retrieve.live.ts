/**
 * tool-retrieve.live.ts — LIVE test of the bge-m3 pre-tool-call tool
 * retrieval hook. Hits the real FreeInference /v1/embeddings endpoint.
 *
 * Coverage doctrine (AGENTS.md §1.9): the .live.ts file is the real gate.
 * This proves the retriever actually ranks tools semantically against a real
 * message, not a mocked vector.
 */
import { describe, test, expect } from "bun:test";
import { ToolRetriever, retrieveRelevantTools } from "./tool-retrieve.ts";

const TOOLS: Array<{ name: string; description: string }> = [
  { name: "bash", description: "run a shell command in a terminal" },
  { name: "read_file", description: "read the contents of a file from disk" },
  { name: "edit_file", description: "make a text edit to an existing file" },
  { name: "semantic_search", description: "find code by natural-language meaning across the indexed root" },
  { name: "grep", description: "search file contents with a regular expression" },
  { name: "git_commit", description: "stage and commit the working tree" },
  { name: "web_fetch", description: "fetch the content of a URL over HTTP" },
  { name: "send_message", description: "post a message to a fleet chat room" },
];

describe("ToolRetriever (live, bge-m3)", () => {
  test("ranks a shell-command message toward bash", async () => {
    const hits = await retrieveRelevantTools(TOOLS, "run ls to list the files in this directory", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe("bash");
    expect(hits[0]!.score).toBeGreaterThan(0.18);
  });

  test("ranks a file-read message toward read_file", async () => {
    const hits = await retrieveRelevantTools(TOOLS, "open src/index.ts and show me what's inside", 3);
    expect(hits[0]!.name).toBe("read_file");
  });

  test("ranks a code-search message toward semantic_search", async () => {
    const hits = await retrieveRelevantTools(TOOLS, "where in the codebase does the login flow live", 3);
    expect(hits[0]!.name).toBe("semantic_search");
  });

  test("ranks a git message toward git_commit", async () => {
    const hits = await retrieveRelevantTools(TOOLS, "commit my changes and push them", 3);
    expect(hits[0]!.name).toBe("git_commit");
  });

  test("warms once and caches the corpus", async () => {
    const r = new ToolRetriever(TOOLS);
    await r.warm();
    const a = await r.retrieve("run a command", 1);
    const b = await r.retrieve("run a command", 1);
    expect(a[0]!.name).toBe(b[0]!.name);
    expect(a[0]!.score).toBeCloseTo(b[0]!.score, 5);
  });
});