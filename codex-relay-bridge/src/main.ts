/**
 * codex-relay-bridge entrypoint — MCP over stdio.
 * All logs go to stderr; stdout is reserved for MCP.
 */

import { runMcpStdio } from "./mcp-adapter/server.js";
import type { RelayCoreOptions } from "./relay-core/index.js";

async function main(): Promise<void> {
  try {
    const opts: RelayCoreOptions = {};
    if (process.env.CODEX_BIN) {
      opts.codexBin = process.env.CODEX_BIN;
    }
    await runMcpStdio(opts);
  } catch (err) {
    console.error("[main] fatal:", err);
    process.exit(1);
  }
}

void main();
