// Runtime tools exposed by the public builder profile. These can mutate only
// the signed-in account's ACTIVE Agents.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type {
  AgentRuntimeDetail,
  AgentRuntimeRun,
  AgentRuntimeSummary,
  AgentRuntimeWorkflow,
  AgentArchiveResponse,
  ScheduleMutationResponse,
} from '../types.js';
import { runTool } from './util.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const INVOKE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

const SCHEDULE_MUTATION = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

const ARCHIVE_MUTATION = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

export function registerAgentRuntimeTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'list_available_agents',
    {
      title: 'List callable AIOS employees',
      annotations: READ_ONLY,
      description:
        'List only ACTIVE Agents owned by the signed-in AIOS account, including employees directly activated from Agent Builder. Call this before invoking an employee. If the user name is ambiguous, show the matching names and ask which one they mean.',
      inputSchema: {},
    },
    async () => runTool(() => client.get<AgentRuntimeSummary[]>('/api/agent-runtime/agents')),
  );

  server.registerTool(
    'get_agent_capabilities',
    {
      title: 'Get an AIOS employee capability card',
      annotations: READ_ONLY,
      description:
        'Read the selected ACTIVE Agent capability card, confirmed Skills, enabled workflows, exact inputSchema and approval risk. Follow the selected workflow inputSchema instead of guessing third-party MCP argument names. It never exposes draft Skills or another account’s Agents.',
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) =>
      runTool(() =>
        client.get<AgentRuntimeDetail>(`/api/agent-runtime/agents/${encodeURIComponent(agentId)}`),
      ),
  );

  server.registerTool(
    'invoke_agent',
    {
      title: 'Invoke an active AIOS employee',
      annotations: INVOKE,
      description:
        'Invoke one ACTIVE Agent owned by the signed-in account. First read get_agent_capabilities and follow the selected workflow inputSchema. For an ordinary natural-language request, preserve the user wording in input.message; do not copy the downstream MCP tool schema into input. workflowId may be omitted when one keyword workflow clearly matches, because AIOS will route it deterministically. Returns immediately with runId. Never claim completion before get_agent_run reports SUCCEEDED.',
      inputSchema: {
        agentId: z.string().min(1),
        workflowId: z.string().min(1).optional(),
        input: z.record(z.unknown()).optional().describe(
          'Agent/workflow input. For natural-language work use {"message":"the user original request"}; if get_agent_capabilities returns a different inputSchema, follow that schema exactly.',
        ),
        idempotencyKey: z.string().min(8).max(160).describe(
          'Stable unique key for this intended execution. Reuse the same key on retries; choose a new key only for a genuinely new run.',
        ),
      },
    },
    async ({ agentId, workflowId, input, idempotencyKey }) =>
      runTool(() =>
        client.post<{
          runId: string;
          status: string;
          deduplicated: boolean;
          workflowId: string | null;
          workflowSelection: 'explicit' | 'keyword' | 'sole_message_workflow' | 'none';
        }>(
          `/api/agent-runtime/agents/${encodeURIComponent(agentId)}/invoke`,
          { body: { workflowId, input: input ?? {}, idempotencyKey } },
        ),
      ),
  );

  server.registerTool(
    'get_agent_run',
    {
      title: 'Get AIOS employee run result',
      annotations: READ_ONLY,
      description:
        'Poll an Agent invocation until it reaches SUCCEEDED, FAILED or CANCELLED. Report the actual terminal result and never treat QUEUED or RUNNING as completed.',
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) =>
      runTool(() =>
        client.get<AgentRuntimeRun>(`/api/agent-runtime/runs/${encodeURIComponent(runId)}`),
      ),
  );

  server.registerTool(
    'list_agent_schedules',
    {
      title: 'List AIOS employee schedules',
      annotations: READ_ONLY,
      description:
        'List enabled workflows and current schedule state for one ACTIVE Agent owned by the signed-in account.',
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) =>
      runTool(() =>
        client.get<AgentRuntimeWorkflow[]>(
          `/api/agent-runtime/agents/${encodeURIComponent(agentId)}/schedules`,
        ),
      ),
  );

  server.registerTool(
    'set_agent_schedule',
    {
      title: 'Set an AIOS employee schedule',
      annotations: SCHEDULE_MUTATION,
      description:
        'Directly add, update, pause, resume or delete a schedule for an enabled workflow owned by the signed-in account. The returned enabled state is authoritative.',
      inputSchema: {
        agentId: z.string().min(1),
        workflowId: z.string().min(1),
        action: z.enum(['UPSERT', 'PAUSE', 'RESUME', 'DELETE']),
        cron: z.string().min(1).max(160).optional().describe('Required for UPSERT; standard cron expression.'),
        timezone: z.string().min(1).max(120).optional().describe('IANA timezone, for example Asia/Taipei.'),
        input: z.record(z.unknown()).optional().describe('Non-secret workflow input persisted with the schedule.'),
        requestKey: z.string().min(8).max(160).describe('Stable key that prevents duplicate schedule changes on retry.'),
      },
    },
    async ({ agentId, workflowId, action, cron, timezone, input, requestKey }) =>
      runTool(() =>
        client.post<ScheduleMutationResponse>(
          `/api/agent-runtime/agents/${encodeURIComponent(agentId)}/schedule-proposals`,
          { body: { workflowId, action, cron, timezone, input, requestKey } },
        ),
      ),
  );

  server.registerTool(
    'archive_agent',
    {
      title: 'Archive an AIOS employee',
      annotations: ARCHIVE_MUTATION,
      description:
        'Immediately archive one Agent owned by the signed-in account. Before calling, use list_available_agents, show the exact Agent name, and obtain explicit user confirmation. A successful call disables the Agent, its workflows, and schedules.',
      inputSchema: {
        agentId: z.string().min(1),
        confirmAgentName: z.string().min(1).max(240).describe(
          'The exact Agent name returned by list_available_agents. The request is rejected if it does not match.',
        ),
        requestKey: z.string().min(8).max(160).describe(
          'Stable unique key for this archive request. Reuse it on retries to avoid duplicate proposals.',
        ),
      },
    },
    async ({ agentId, confirmAgentName, requestKey }) =>
      runTool(() =>
        client.post<AgentArchiveResponse>(
          `/api/agent-runtime/agents/${encodeURIComponent(agentId)}/archive-proposals`,
          { body: { confirmAgentName, requestKey } },
        ),
      ),
  );
}
