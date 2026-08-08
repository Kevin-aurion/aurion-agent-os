// Tools: list_runs, get_run, cancel_run.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { Run, RunSummary } from '../types.js';
import { runTool } from './util.js';

export function registerRunTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'list_runs',
    {
      title: 'List runs',
      description: 'List recent runs, optionally filtered to one agent, most recent first.',
      inputSchema: {
        agentId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ agentId, limit }) =>
      runTool(() => client.get<RunSummary[]>('/api/runs', { query: { agentId, limit } })),
  );

  server.registerTool(
    'get_run',
    {
      title: 'Get run',
      description:
        "Get one run's full detail including its ordered step-by-step execution log (RunStep[] — status, output, verdict, approved, error per step/round) — this is where run output/logs actually live.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) => runTool(() => client.get<Run>(`/api/runs/${encodeURIComponent(runId)}`)),
  );

  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel run',
      description:
        'Best-effort cancel of a still-RUNNING run (cannot interrupt an in-flight engine process, but marks the run CANCELLED and stops further step processing). No-op if the run already finished.',
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) =>
      runTool(() =>
        client.post<{ id: string; status: string }>(
          `/api/runs/${encodeURIComponent(runId)}/cancel`,
        ),
      ),
  );
}
