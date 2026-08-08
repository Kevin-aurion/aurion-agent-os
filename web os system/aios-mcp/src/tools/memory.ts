// Tools: list_memory_files, read_memory_file, search_memory, reindex_memory.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { MemoryHit } from '../types.js';
import { runTool } from './util.js';

export function registerMemoryTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'list_memory_files',
    {
      title: 'List memory files',
      description:
        "List the markdown wiki files that make up one agent's long-term memory (materialized on disk under MyAgent/).",
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) =>
      runTool(() =>
        client.get<{ files: unknown }>(`/api/agents/${encodeURIComponent(agentId)}/memory/files`),
      ),
  );

  server.registerTool(
    'read_memory_file',
    {
      title: 'Read memory file',
      description: 'Read the raw markdown content of one memory/wiki file by its relative path.',
      inputSchema: {
        agentId: z.string().min(1),
        path: z.string().min(1),
      },
    },
    async ({ agentId, path }) =>
      runTool(() =>
        client.get<{ path: string; content: string }>(
          `/api/agents/${encodeURIComponent(agentId)}/memory/file`,
          { query: { path } },
        ),
      ),
  );

  server.registerTool(
    'search_memory',
    {
      title: 'Search memory',
      description:
        "Semantic top-K search over an agent's memory (falls back to empty hits if no embedding key is configured).",
      inputSchema: {
        agentId: z.string().min(1),
        query: z.string().min(1),
        topK: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ agentId, query, topK }) =>
      runTool(() =>
        client.post<{ query: string; hits: MemoryHit[] }>(
          `/api/agents/${encodeURIComponent(agentId)}/memory/search`,
          { body: topK !== undefined ? { query, topK } : { query } },
        ),
      ),
  );

  server.registerTool(
    'reindex_memory',
    {
      title: 'Reindex memory',
      description:
        "Re-scan and re-embed an agent's memory wiki into the vector index (incremental).",
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) =>
      runTool(() =>
        client.post<unknown>(`/api/agents/${encodeURIComponent(agentId)}/memory/reindex`),
      ),
  );
}
