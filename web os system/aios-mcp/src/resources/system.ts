// Resources: aios-system://health and aios-system://preflight (static, unauthenticated endpoints).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import type { Health, Preflight } from '../types.js';
import { jsonResource } from './util.js';

export function registerSystemResources(server: McpServer, client: HttpClient): void {
  server.registerResource(
    'health',
    'aios-system://health',
    {
      title: 'AIOS server health',
      description: 'Mirrors GET /api/health — quick liveness/DB/timezone snapshot.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await client.get<Health>('/api/health', { skipAuth: true })),
  );

  server.registerResource(
    'preflight',
    'aios-system://preflight',
    {
      title: 'AIOS engine/integration preflight',
      description: 'Mirrors GET /api/preflight — which engines/integrations are currently usable.',
      mimeType: 'application/json',
    },
    async (uri) =>
      jsonResource(uri, await client.get<Preflight>('/api/preflight', { skipAuth: true })),
  );
}
