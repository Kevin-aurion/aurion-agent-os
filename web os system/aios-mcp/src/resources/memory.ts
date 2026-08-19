// Resource: aios-memory://{agentId}/{+path} — one memory/wiki markdown file by relative path.
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import { textResource, variable } from './util.js';

export function registerMemoryResources(server: McpServer, client: HttpClient): void {
  server.registerResource(
    'memory-file',
    // {+path} (RFC 6570 reserved expansion) so nested paths like 'wiki/notes.md' match.
    new ResourceTemplate('aios-memory://{agentId}/{+path}', { list: undefined }),
    {
      title: 'AIOS agent memory file',
      description:
        'Mirrors GET /api/agents/:agentId/memory/file?path= — lets a client pull one memory/wiki markdown file directly into context by path.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const agentId = variable(variables, 'agentId');
      const path = variable(variables, 'path');
      const result = await client.get<{ path: string; content: string }>(
        `/api/agents/${encodeURIComponent(agentId)}/memory/file`,
        { query: { path } },
      );
      return textResource(uri, result.content);
    },
  );
}
