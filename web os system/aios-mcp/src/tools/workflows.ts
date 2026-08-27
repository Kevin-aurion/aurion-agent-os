// Tools: list_workflows, get_workflow, run_workflow, test_workflow.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { Workflow, WorkflowSummary } from '../types.js';
import { runTool } from './util.js';

export function registerWorkflowTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description:
        'List the workflows belonging to one agent, each with its trigger config (schedule/keyword/manual/webhook), step count, and schedule info.',
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) =>
      runTool(() =>
        client.get<WorkflowSummary[]>(`/api/agents/${encodeURIComponent(agentId)}/workflows`),
      ),
  );

  server.registerTool(
    'get_workflow',
    {
      title: 'Get workflow',
      description:
        "Get one workflow's full definition: ordered steps (type/config/verifyRubric/onFail) and all Schedule rows — this is HOW the workflow's capability actually executes.",
      inputSchema: { workflowId: z.string().min(1) },
    },
    async ({ workflowId }) =>
      runTool(() => client.get<Workflow>(`/api/workflows/${encodeURIComponent(workflowId)}`)),
  );

  server.registerTool(
    'run_workflow',
    {
      title: 'Run workflow',
      description:
        "Manually trigger a workflow run right now, equivalent to clicking 'Run' in the web UI. Returns immediately with a runId; the run executes in the background — call get_run or list_runs to poll for completion.",
      inputSchema: {
        workflowId: z.string().min(1),
        input: z.record(z.unknown()).optional(),
      },
    },
    async ({ workflowId, input }) =>
      runTool(() =>
        client.post<{ runId: string }>(`/api/workflows/${encodeURIComponent(workflowId)}/run`, {
          body: input !== undefined ? { input } : {},
        }),
      ),
  );

  server.registerTool(
    'test_workflow',
    {
      title: 'Test workflow',
      description:
        'Trigger a workflow with a friendly default test message instead of real input — same execution path as run_workflow but tagged as a test run and defaults input to a placeholder message if none given.',
      inputSchema: {
        workflowId: z.string().min(1),
        message: z.string().optional(),
      },
    },
    async ({ workflowId, message }) =>
      runTool(() =>
        client.post<{ runId: string }>(`/api/workflows/${encodeURIComponent(workflowId)}/test`, {
          body: message !== undefined ? { message } : {},
        }),
      ),
  );
}
