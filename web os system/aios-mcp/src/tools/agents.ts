// Tools: list_agents, get_agent.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { Agent } from '../types.js';
import { runTool } from './util.js';

export function registerAgentTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description:
        'List all active (non-deleted) AI employee agents with their skill/workflow counts.',
      inputSchema: {},
    },
    async () => runTool(() => client.get<Agent[]>('/api/agents')),
  );

  server.registerTool(
    'get_agent',
    {
      title: 'Get agent',
      description:
        "Get one agent's full profile: role prompt, engines, restrictions, plus its capabilities — attached skills (with each skill's content) and workflows (id/name/enabled).",
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) =>
      runTool(() => client.get<Agent>(`/api/agents/${encodeURIComponent(agentId)}`)),
  );
}
