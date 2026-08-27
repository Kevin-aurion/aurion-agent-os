// Runtime tools exposed by the public builder profile. These can invoke only
// the signed-in account's ACTIVE Agents. Scheduling and archival are
// proposal-only and do not bypass FDE approval.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type {
  AgentRuntimeDetail,
  AgentRuntimeRun,
  AgentRuntimeSummary,
  AgentRuntimeWorkflow,
  AgentArchiveProposalResponse,
  ScheduleProposalResponse,
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

const PROPOSAL_ONLY = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_PROPOSAL = {
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
        'List only ACTIVE, FDE-approved Agents owned by the signed-in AIOS account. Call this before invoking an employee. If the user name is ambiguous, show the matching names and ask which one they mean.',
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
        'Read the selected ACTIVE Agent capability card, confirmed Skills, enabled workflows, required inputs and approval risk. It never exposes draft Skills or another account’s Agents.',
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
      title: 'Invoke an approved AIOS employee',
      annotations: INVOKE,
      description:
        'Invoke one ACTIVE Agent owned by the signed-in account. Select an enabled workflow when a precise capability exists; otherwise omit workflowId for the Agent’s default task. Returns immediately with runId. High-risk work remains AWAITING_REVIEW until FDE approves it. Never claim completion before get_agent_run reports SUCCEEDED.',
      inputSchema: {
        agentId: z.string().min(1),
        workflowId: z.string().min(1).optional(),
        input: z.record(z.unknown()).optional(),
        idempotencyKey: z.string().min(8).max(160).describe(
          'Stable unique key for this intended execution. Reuse the same key on retries; choose a new key only for a genuinely new run.',
        ),
      },
    },
    async ({ agentId, workflowId, input, idempotencyKey }) =>
      runTool(() =>
        client.post<{ runId: string; status: string; deduplicated: boolean }>(
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
        'Poll an Agent invocation until it reaches SUCCEEDED, FAILED, CANCELLED or AWAITING_REVIEW. AWAITING_REVIEW means an FDE must approve before execution continues.',
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
    'request_agent_schedule',
    {
      title: 'Request an AIOS employee schedule',
      annotations: PROPOSAL_ONLY,
      description:
        'Create a PENDING FDE proposal to add, update, pause, resume or delete a schedule for an enabled Agent workflow. This tool never activates a schedule itself. Tell the user it remains pending until FDE approval.',
      inputSchema: {
        agentId: z.string().min(1),
        workflowId: z.string().min(1),
        action: z.enum(['UPSERT', 'PAUSE', 'RESUME', 'DELETE']),
        cron: z.string().min(1).max(160).optional().describe('Required for UPSERT; standard cron expression.'),
        timezone: z.string().min(1).max(120).optional().describe('IANA timezone, for example Asia/Taipei.'),
        input: z.record(z.unknown()).optional().describe('Non-secret workflow input persisted with the schedule.'),
        requestKey: z.string().min(8).max(160).describe('Stable key that prevents duplicate pending proposals on retry.'),
      },
    },
    async ({ agentId, workflowId, action, cron, timezone, input, requestKey }) =>
      runTool(() =>
        client.post<ScheduleProposalResponse>(
          `/api/agent-runtime/agents/${encodeURIComponent(agentId)}/schedule-proposals`,
          { body: { workflowId, action, cron, timezone, input, requestKey } },
        ),
      ),
  );

  server.registerTool(
    'request_agent_archive',
    {
      title: 'Request AIOS employee archival',
      annotations: DESTRUCTIVE_PROPOSAL,
      description:
        'Create a PENDING FDE proposal to archive one Agent owned by the signed-in account. Before calling, use list_available_agents, show the exact Agent name, and obtain explicit user confirmation. This tool never archives immediately. After FDE approval the Agent, its workflows and schedules are disabled and it can no longer be listed or invoked.',
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
        client.post<AgentArchiveProposalResponse>(
          `/api/agent-runtime/agents/${encodeURIComponent(agentId)}/archive-proposals`,
          { body: { confirmAgentName, requestKey } },
        ),
      ),
  );
}
