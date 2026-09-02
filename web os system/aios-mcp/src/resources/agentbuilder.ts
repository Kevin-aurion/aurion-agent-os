import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import type { AgentBuildSession } from '../types.js';
import { jsonResource, variable } from './util.js';

export function registerAgentBuilderResources(server: McpServer, client: HttpClient): void {
  server.registerResource(
    'agent-builds-list',
    'aios-builds://list',
    {
      title: 'AIOS Agent Builder sessions',
      description: 'Owned external and web Agent training sessions, including current activation state and Agent id.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await client.get<AgentBuildSession[]>('/api/agent-builder/sessions')),
  );

  server.registerResource(
    'agent-build',
    new ResourceTemplate('aios-build://{sessionId}', { list: undefined }),
    {
      title: 'AIOS Agent Builder session',
      description: 'One durable build transcript with every shadow Harness iteration and governance status.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const sessionId = variable(variables, 'sessionId');
      return jsonResource(
        uri,
        await client.get<AgentBuildSession>(
          `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}`,
        ),
      );
    },
  );
}
