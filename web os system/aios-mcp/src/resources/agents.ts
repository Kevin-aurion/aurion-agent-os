// Resources: aios-agents://list (static) and aios-agent://{agentId} (template).
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import type { Agent } from '../types.js';
import { jsonResource, variable } from './util.js';

export function registerAgentResources(server: McpServer, client: HttpClient): void {
  server.registerResource(
    'agents-list',
    'aios-agents://list',
    {
      title: 'AIOS agent roster',
      description:
        'Mirrors GET /api/agents — the full current agent roster as JSON, for a client to attach as background context without an explicit tool call.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await client.get<Agent[]>('/api/agents')),
  );

  server.registerResource(
    'agent',
    new ResourceTemplate('aios-agent://{agentId}', { list: undefined }),
    {
      title: 'AIOS agent profile',
      description:
        "Mirrors GET /api/agents/:id — one agent's full profile including its skills and workflows, addressable by id for context injection.",
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const agentId = variable(variables, 'agentId');
      return jsonResource(uri, await client.get<Agent>(`/api/agents/${encodeURIComponent(agentId)}`));
    },
  );
}
