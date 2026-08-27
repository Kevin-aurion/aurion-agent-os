// stdio transport: what Claude Desktop / Claude Code / Codex CLI use when spawning this process.
// IMPORTANT: never write logs to stdout in this mode — stdout is the JSON-RPC channel.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export async function runStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('aios-mcp: stdio transport connected');
}
