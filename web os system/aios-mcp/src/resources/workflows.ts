// Resource: aios-workflow://{workflowId}.
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import type { Workflow } from '../types.js';
import { jsonResource, variable } from './util.js';

export function registerWorkflowResources(server: McpServer, client: HttpClient): void {
  server.registerResource(
    'workflow',
    new ResourceTemplate('aios-workflow://{workflowId}', { list: undefined }),
    {
      title: 'AIOS workflow definition',
      description:
        "Mirrors GET /api/workflows/:id — a workflow's ordered steps and schedules, i.e. the concrete 'how' behind an agent capability.",
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const workflowId = variable(variables, 'workflowId');
      return jsonResource(
        uri,
        await client.get<Workflow>(`/api/workflows/${encodeURIComponent(workflowId)}`),
      );
    },
  );
}
