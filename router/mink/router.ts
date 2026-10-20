// Estate AST Router — Bun entry (port of router.py)
// Modular: env.ts (keys) · session.ts (sid/ast) · race.ts (4-way race) · server.ts (Bun.serve)
import { CODING } from "./race.ts";

const PORT = Number(Bun.env.AST_ROUTER_PORT ?? 25104);
console.log(`Estate AST Router on http://127.0.0.1:${PORT}/v1`);
console.log("Parallel race: 4 providers, first AST/code response wins. FIFO queue.");
console.log("Models:", [...Object.keys(CODING), "auto", "fcm"].join(", "));
