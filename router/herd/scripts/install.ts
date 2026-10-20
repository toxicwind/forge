#!/usr/bin/env bun
import { $ } from "bun";

console.log(">>> Running Herd Installation (Bun)...");

// Example of how a bun script handles install tasks
async function main() {
    // Instead of bash commands, use Bun.shell or standard bun APIs
    // e.g. await `sudo useradd ...`;
    console.log("System configuration steps...");
    // Keep it minimal as per ponytail
}

await main();
