// Tools: get_dashboard_summary, get_health, get_preflight.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import type { DashboardSummary, Health, Preflight } from '../types.js';
import { runTool } from './util.js';

export function registerSystemTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'get_dashboard_summary',
    {
      title: 'Dashboard summary',
      description:
        "System-wide overview: active agent count, skill counts by review status, enabled workflow count, today's run counts by status, connected cloud accounts, live WS connection count.",
      inputSchema: {},
    },
    async () => runTool(() => client.get<DashboardSummary>('/api/dashboard/summary')),
  );

  server.registerTool(
    'get_health',
    {
      title: 'Server health',
      description: 'Check aios-server liveness: DB connectivity, live WS connection count, server timezone.',
      inputSchema: {},
    },
    async () => runTool(() => client.get<Health>('/api/health', { skipAuth: true })),
  );

  server.registerTool(
    'get_preflight',
    {
      title: 'Engine/integration preflight',
      description:
        'Check which engines (Claude Code/Codex/Grok CLIs) are actually installed and which integrations (Microsoft/Google/LINE) are connected, before invoking a run that depends on them.',
      inputSchema: {},
    },
    async () => runTool(() => client.get<Preflight>('/api/preflight', { skipAuth: true })),
  );
}
