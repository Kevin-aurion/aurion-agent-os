// External Agent Builder tools for Claude, ChatGPT, Codex and Cursor.
// These tools can only synchronize inert drafts and submit them to FDE. They do
// not expose approve-build, skill confirmation or final activation.
import { open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { AgentBuildSession, ExternalBuilderSource } from '../types.js';
import { runTool } from './util.js';

const sourceSchema = z.enum(['CLAUDE_DESKTOP', 'CLAUDE_CODE', 'CHATGPT', 'CURSOR', 'OTHER']);

function resolvedSource(source?: ExternalBuilderSource): ExternalBuilderSource {
  if (source) return source;
  return process.env.CLAUDE_CODE_SESSION_ID ? 'CLAUDE_CODE' : 'CLAUDE_DESKTOP';
}

async function latestClaudeUserMessage(
  transcriptPath: string | undefined,
  conversationId: string,
): Promise<{ content: string; at?: string } | null> {
  if (!transcriptPath) return null;
  const projectsRoot = await realpath(path.join(os.homedir(), '.claude', 'projects'));
  const resolved = await realpath(transcriptPath);
  if (!resolved.startsWith(`${projectsRoot}${path.sep}`)) {
    throw new Error('Claude transcript path is outside ~/.claude/projects');
  }
  if (path.basename(resolved) !== `${conversationId}.jsonl`) {
    throw new Error('Claude transcript filename does not match the current session id');
  }

  const handle = await open(resolved, 'r');
  try {
    const info = await handle.stat();
    const maxBytes = 2 * 1024 * 1024;
    const offset = Math.max(0, info.size - maxBytes);
    const buffer = Buffer.alloc(info.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.toString('utf8');
    if (offset > 0) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== 'queue-operation' || event.operation !== 'enqueue') continue;
        if (typeof event.content !== 'string' || !event.content.trim()) continue;
        return {
          content: event.content.trim().slice(0, 24_000),
          at: typeof event.timestamp === 'string' ? event.timestamp : undefined,
        };
      } catch {
        // A partial or unknown JSONL row is ignored; Stop remains fail-safe.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}
const skillSchema = z.object({
  name: z.string().min(1).max(120).describe('Human-facing skill name.'),
  purpose: z.string().max(1_200).optional(),
  instructions: z.array(z.string().max(1_200)).max(30).optional(),
  inputs: z.array(z.string().max(600)).max(20).optional(),
  outputs: z.array(z.string().max(600)).max(20).optional(),
  edgeCases: z.array(z.string().max(800)).max(20).optional(),
  contentMd: z.string().max(60_000).optional().describe('Complete SKILL.md draft when already authored.'),
}).strict();
const workflowStepSchema = z.object({
  stepKey: z.string().min(1).max(100),
  type: z.enum(['DO', 'TOOL', 'AGENT', 'CONDITION', 'NOTIFY', 'COMPUTER_CONTROL']),
  config: z.record(z.unknown()).optional(),
  verifyRubric: z.string().max(2_000).nullable().optional(),
  onFail: z.record(z.unknown()).nullable().optional(),
}).strict();
const artifactSchema = z.object({
  identity: z.object({
    name: z.string().min(1).max(120),
    purpose: z.string().min(1).max(1_500),
    workingStyle: z.array(z.string().max(800)).max(20).optional(),
  }).strict(),
  agentMarkdown: z.string().max(60_000).optional().describe('Full agent identity/instructions Markdown draft.'),
  claudeMarkdown: z.string().max(60_000).optional().describe('Optional Claude-facing operating notes Markdown.'),
  skills: z.array(skillSchema).max(12).optional(),
  memory: z.object({
    facts: z.array(z.string().max(1_200)).max(60).optional(),
    preferences: z.array(z.string().max(1_200)).max(40).optional(),
    glossary: z.array(z.string().max(600)).max(60).optional(),
    documents: z.array(z.object({
      path: z.string().min(1).max(240).describe('Relative Markdown path only; traversal is rejected.'),
      contentMd: z.string().min(1).max(40_000),
      purpose: z.string().max(500).optional(),
    }).strict()).max(24).optional(),
  }).strict().optional(),
  tools: z.array(z.object({
    name: z.string().min(1).max(180),
    purpose: z.string().max(800).optional(),
    status: z.enum(['AVAILABLE', 'NEEDS_FDE', 'NOT_NEEDED']).optional(),
  }).strict()).max(30).optional(),
  policies: z.object({
    allowed: z.array(z.string().max(800)).max(30).optional(),
    requiresApproval: z.array(z.string().max(800)).max(30).optional(),
    forbidden: z.array(z.string().max(800)).max(30).optional(),
  }).strict().optional(),
  tests: z.array(z.object({
    name: z.string().min(1).max(180),
    input: z.string().min(1).max(5_000),
    expected: z.string().min(1).max(5_000),
  }).strict()).max(20).optional(),
  workflows: z.array(z.object({
    name: z.string().min(1).max(160),
    description: z.string().max(1_200).optional(),
    trigger: z.record(z.unknown()).optional(),
    durable: z.boolean().optional(),
    steps: z.array(workflowStepSchema).max(40).optional(),
  }).strict()).max(12).optional(),
  understanding: z.object({
    northStar: z.string().max(1_500).optional(),
    painPoints: z.array(z.string().max(1_000)).max(20).optional(),
    facts: z.array(z.object({ statement: z.string().min(1).max(1_200), source: z.string().max(240) }).strict()).max(40).optional(),
    hypotheses: z.array(z.object({ statement: z.string().min(1).max(1_000), confidence: z.enum(['low', 'medium', 'high']) }).strict()).max(20).optional(),
    decisions: z.array(z.object({
      topic: z.string().min(1).max(240),
      decision: z.string().min(1).max(1_500),
      status: z.enum(['provisional', 'confirmed', 'revised']),
    }).strict()).max(40).optional(),
    openBranches: z.array(z.object({
      topic: z.string().min(1).max(240),
      whyItMatters: z.string().min(1).max(1_000),
      recommendation: z.string().max(1_000),
    }).strict()).max(20).optional(),
    contradictions: z.array(z.string().max(1_000)).max(20).optional(),
    confidence: z.number().min(0).max(100).optional(),
  }).strict().optional(),
  changes: z.array(z.object({
    area: z.enum(['identity', 'skill', 'memory', 'tool', 'policy', 'test', 'workflow']),
    action: z.enum(['added', 'updated', 'removed']),
    summary: z.string().min(1).max(500),
    reason: z.string().max(600),
  }).strict()).max(40).optional(),
  userSummary: z.string().max(1_500).optional(),
  fdeSummary: z.string().max(4_000).optional(),
}).strict();

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const DRAFT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function noteFor(session: AgentBuildSession): string {
  if (session.status === 'AWAITING_FDE') {
    return 'The draft is waiting for an explicit FDE decision. Do not claim it is built or active.';
  }
  if (session.status === 'AWAITING_TEST_DATA') {
    return 'FDE created inert Agent/Skill drafts. Submit test data, then run the real test; nothing is active yet.';
  }
  if (session.status === 'PASSED') {
    return 'The test passed, but only FDE finalization can confirm skills and activate a new agent.';
  }
  if (session.status === 'ACTIVE') {
    return 'The latest approved version is active. Further training must create a new draft and review cycle.';
  }
  return 'Continue the adaptive interview and synchronize each turn. Import a full artifact whenever the draft meaningfully changes.';
}

export function registerAgentBuilderTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'prepare_agent_build_prompt',
    {
      title: 'Auto-start or resume an AIOS Agent build',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Claude Code UserPromptSubmit hook tool. For an explicit Agent/AI employee/Skill creation or training request, it automatically starts or resumes an AIOS build, persists the exact user prompt and queues asynchronous Agent/Skill draft evolution. Unrelated conversations are a no-op. It never approves, activates or grants permissions.',
      inputSchema: {
        externalConversationId: z.string().min(1).max(160).optional()
          .describe('Claude Code session id. The configured hook supplies ${session_id}.'),
        prompt: z.string().min(1).max(12_000)
          .describe('Exact UserPromptSubmit prompt. The configured hook supplies ${prompt}.'),
        source: sourceSchema.optional(),
      },
    },
    async ({ externalConversationId, prompt, source }) =>
      runTool(async () => {
        const conversationId = externalConversationId ?? process.env.CLAUDE_CODE_SESSION_ID;
        if (!conversationId) return { matched: false };
        const result = await client.post<Record<string, unknown>>(
          '/api/agent-builder/external/prompt-hook',
          {
            body: {
              source: resolvedSource(source),
              externalConversationId: conversationId,
              prompt,
            },
          },
        );
        const additionalContext = typeof result.additionalContext === 'string'
          ? result.additionalContext
          : undefined;
        return {
          ...result,
          ...(result.matched === true && additionalContext
            ? {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext,
                },
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    'start_agent_build',
    {
      title: 'Start an AIOS agent build',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Start or resume an AIOS shadow build from a user request made in ChatGPT, Claude, Codex or Cursor. This records the exact initial request and creates an inert, append-only build session. It never creates or activates a live Agent. Keep the returned session.id and use it on every later sync call.',
      inputSchema: {
        initialRequest: z.string().min(1).max(12_000),
        source: sourceSchema.optional(),
        externalConversationId: z.string().min(1).max(160).optional().describe('Stable id for this desktop conversation; reuse it after retries.'),
        externalConversationTitle: z.string().max(240).optional(),
        requestedAgentName: z.string().max(120).optional(),
      },
    },
    async ({ initialRequest, source, externalConversationId, externalConversationTitle, requestedAgentName }) =>
      runTool(async () => {
        const result = await client.post<{ session: AgentBuildSession; deduplicated: boolean }>(
          '/api/agent-builder/external/sessions',
          {
            body: {
              initialRequest,
              source: resolvedSource(source),
              externalConversationId: externalConversationId ?? process.env.CLAUDE_CODE_SESSION_ID,
              externalConversationTitle,
              requestedAgentName,
            },
          },
        );
        return {
          ...result,
          note: noteFor(result.session),
          next: 'Ask one contextual, high-information question. Before showing it to the user, call sync_agent_build_turn with the exact user and assistant text.',
        };
      }),
  );

  server.registerTool(
    'sync_agent_build_turn',
    {
      title: 'Sync an Agent Builder conversation turn',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Persist exact user/assistant/system text from one external build turn. Call this once per turn using a stable externalEventId. Retries are idempotent. This may update only a shadow Harness iteration; it never grants permissions or mutates the live Agent.',
      inputSchema: {
        sessionId: z.string().min(1),
        source: sourceSchema.optional(),
        externalEventId: z.string().min(1).max(160),
        turns: z.array(z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string().min(1).max(24_000),
        }).strict()).min(1).max(6),
        summary: z.string().max(2_000).optional(),
      },
    },
    async ({ sessionId, source, externalEventId, turns, summary }) =>
      runTool(async () => {
        const result = await client.post<{
          session: AgentBuildSession;
          deduplicated: boolean;
          iteration: unknown;
        }>(`/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/external-turns`, {
          body: { source: resolvedSource(source), externalEventId, turns, summary },
        });
        return { ...result, note: noteFor(result.session) };
      }),
  );

  server.registerTool(
    'sync_agent_build_artifact',
    {
      title: 'Sync a complete AIOS agent draft',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Synchronize the complete current draft produced in ChatGPT, Claude, Codex or Cursor: identity/Agent Markdown, SKILL.md bodies, memory documents, tools, approval policies, workflows and tests. Send a full snapshot, not only a patch. The server redacts secrets, rejects unsafe memory paths, downgrades claimed tool availability to NEEDS_FDE, and stores an inert version for review.',
      inputSchema: {
        sessionId: z.string().min(1),
        source: sourceSchema.optional(),
        externalEventId: z.string().min(1).max(160),
        artifact: artifactSchema,
      },
    },
    async ({ sessionId, source, externalEventId, artifact }) =>
      runTool(async () => {
        const result = await client.post<{
          session: AgentBuildSession;
          iteration: unknown;
          deduplicated: boolean;
        }>(`/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/external-artifact`, {
          body: { source: resolvedSource(source), externalEventId, artifact },
        });
        return {
          ...result,
          note: noteFor(result.session),
          warning: 'This is a shadow draft. Do not tell the user that the Agent or its skills are active.',
        };
      }),
  );

  server.registerTool(
    'upsert_agent_build_snapshot',
    {
      title: 'Save a complete Agent Builder turn and draft',
      description:
        'Preferred synchronization tool for ChatGPT and other clients without lifecycle hooks. It retry-safely stores the exact paired conversation turn and the complete current Agent/Skill/Memory/Workflow/Test shadow draft, then lets AIOS continue building asynchronously. It never approves, confirms or activates anything.',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      inputSchema: {
        sessionId: z.string().min(1),
        source: sourceSchema.default('CHATGPT'),
        externalEventId: z.string().min(1).max(120)
          .describe('Stable id for this paired turn and artifact snapshot. Reuse it for retries.'),
        turns: z.array(z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string().min(1).max(24_000),
        }).strict()).min(1).max(6),
        summary: z.string().max(2_000).optional(),
        artifact: artifactSchema,
      },
    },
    async ({ sessionId, source, externalEventId, turns, summary, artifact }) =>
      runTool(async () => {
        const result = await client.post<{
          session: AgentBuildSession;
          turn: { deduplicated: boolean; iteration: unknown };
          artifact: { deduplicated: boolean; iteration: unknown };
        }>(`/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/external-snapshot`, {
          body: { source, externalEventId, turns, summary, artifact },
        });
        return {
          ...result,
          note: noteFor(result.session),
          warning: 'This is a shadow draft. Do not tell the user that the Agent or its skills are active.',
        };
      }),
  );

  server.registerTool(
    'upload_agent_build_file',
    {
      title: 'Upload a training file to an AIOS build',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Send a user-provided training source into an owned AIOS build session. Pass either textContent or base64Content, never a local path. Supported: xlsx/xls/csv/tsv/md/txt/pdf/docx/json/yaml/yml/html. AIOS parses locally, redacts secrets before persistence and updates only the draft.',
      inputSchema: {
        sessionId: z.string().min(1),
        filename: z.string().min(1).max(160),
        mimeType: z.string().max(120).optional(),
        textContent: z.string().max(10 * 1024 * 1024).optional(),
        base64Content: z.string().max(14 * 1024 * 1024).optional(),
      },
    },
    async ({ sessionId, filename, mimeType, textContent, base64Content }) =>
      runTool(async () => {
        if ((textContent == null) === (base64Content == null)) {
          throw new Error('Provide exactly one of textContent or base64Content');
        }
        const safeName = path.basename(filename).replace(/[\r\n]/g, ' ').slice(0, 160);
        if (!safeName) throw new Error('filename is invalid');
        let bytes: Buffer;
        if (base64Content != null) {
          const compact = base64Content.replace(/\s+/g, '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
            throw new Error('base64Content is not valid base64');
          }
          bytes = Buffer.from(compact, 'base64');
        } else {
          bytes = Buffer.from(textContent as string, 'utf8');
        }
        if (!bytes.length) throw new Error('Training file is empty');
        if (bytes.length > 10 * 1024 * 1024) throw new Error('Training file exceeds 10 MB');
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: mimeType || 'application/octet-stream' }), safeName);
        const result = await client.postForm<{
          session: AgentBuildSession;
          assistantMessage: string;
          status: string;
        }>(`/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/files`, form);
        return {
          ...result,
          uploaded: { filename: safeName, bytes: bytes.length, mimeType: mimeType || 'application/octet-stream' },
          note: noteFor(result.session),
        };
      }),
  );

  server.registerTool(
    'guard_agent_build_stop',
    {
      title: 'Synchronize AIOS when Claude Code stops',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Claude Code Stop-hook tool. It mirrors the final assistant message, catches a missed Agent-building user prompt, and lets AIOS update its shadow Agent/Skill draft asynchronously from the transcript. It does not block Stop and never submits, approves, confirms, tests or activates an Agent.',
      inputSchema: {
        externalConversationId: z.string().min(1).max(160).optional()
          .describe('Claude Code session id. The configured Stop hook supplies ${session_id}.'),
        transcriptPath: z.string().max(4_096).optional()
          .describe('Claude Code transcript path. The hook supplies ${transcript_path}; only files under ~/.claude/projects are accepted.'),
        lastAssistantMessage: z.string().max(24_000).optional(),
        stopHookActive: z.union([z.boolean(), z.enum(['true', 'false'])]).default(false),
        source: sourceSchema.optional(),
      },
    },
    async ({ externalConversationId, transcriptPath, lastAssistantMessage, stopHookActive, source }) =>
      runTool(async () => {
        const conversationId = externalConversationId ?? process.env.CLAUDE_CODE_SESSION_ID;
        if (!conversationId) {
          return { matched: false, systemMessage: 'AIOS Stop guard received no Claude session id.' };
        }
        const lastUser = await latestClaudeUserMessage(transcriptPath, conversationId);
        return client.post<Record<string, unknown>>('/api/agent-builder/external/stop-guard', {
          body: {
            source: resolvedSource(source),
            externalConversationId: conversationId,
            lastUserMessage: lastUser?.content,
            lastUserMessageAt: lastUser?.at,
            lastAssistantMessage,
            stopHookActive: stopHookActive === true || stopHookActive === 'true',
          },
        });
      }),
  );

  server.registerTool(
    'get_agent_build',
    {
      title: 'Get an AIOS agent build',
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        'Read the durable synchronized transcript, latest shadow Harness, FDE state, test state and ids for one owned AIOS build session.',
      inputSchema: { sessionId: z.string().min(1) },
    },
    async ({ sessionId }) => runTool(async () => {
      const session = await client.get<AgentBuildSession>(
        `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}`,
      );
      return { session, note: noteFor(session) };
    }),
  );

  server.registerTool(
    'chat_with_agent_build',
    {
      title: 'Coach a Shadow AIOS employee in this conversation',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Send one realistic End User work message to the latest READY Shadow Agent and return its isolated reply in this Claude/ChatGPT/Codex conversation. Use this for training and debugging before FDE review. The preview has no tools, network, shell, Computer Use or external-write authority. AIOS stores the redacted pair and queues a reflection that may revise only the Shadow Skill/Rules; it never edits or activates production.',
      inputSchema: {
        sessionId: z.string().min(1),
        message: z.string().min(1).max(24_000)
          .describe('The exact realistic End User message or work input to test against the Shadow Agent.'),
      },
    },
    async ({ sessionId, message }) => runTool(async () => {
      const result = await client.post<{
        sessionId: string;
        iterationId: string;
        reply: string;
        reflectionQueued: boolean;
      }>(`/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/shadow-chat`, {
        body: { message },
      });
      return {
        ...result,
        note: 'Show reply exactly as the Shadow Agent test result, ask the user for one concrete correction, and never claim the draft is active.',
      };
    }),
  );

  server.registerTool(
    'list_agent_builds',
    {
      title: 'List AIOS agent builds',
      annotations: READ_ONLY_ANNOTATIONS,
      description: 'List the signed-in user’s recent AIOS Agent Builder sessions for resume or status checks.',
      inputSchema: {},
    },
    async () => runTool(() => client.get<AgentBuildSession[]>('/api/agent-builder/sessions')),
  );

  server.registerTool(
    'submit_agent_build_for_fde_review',
    {
      title: 'Submit an agent draft for FDE review',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Use only after the user explicitly confirms the current complete draft should be reviewed. This always stops at AWAITING_FDE, even if MCP authenticated with OWNER credentials. It does not approve, build, confirm, test or activate anything.',
      inputSchema: {
        sessionId: z.string().min(1),
        strategy: z.enum(['create', 'reuse']).default('create'),
        targetAgentId: z.string().min(1).optional(),
      },
    },
    async ({ sessionId, strategy, targetAgentId }) => runTool(async () => {
      const session = await client.post<AgentBuildSession>(
        `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/submit-review`,
        { body: { strategy, targetAgentId } },
      );
      return {
        session,
        note: noteFor(session),
        requiredHumanAction: 'An FDE must review and click approve in AIOS 管理中心 → 提案審核.',
      };
    }),
  );

  server.registerTool(
    'submit_agent_build_test_data',
    {
      title: 'Submit test data for an approved draft',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'After FDE has created the inert draft and status is AWAITING_TEST_DATA, submit a concrete fixture and expected outcome. This stores redacted test evidence but does not run or pass the test.',
      inputSchema: {
        sessionId: z.string().min(1),
        data: z.unknown(),
        expected: z.unknown(),
      },
    },
    async ({ sessionId, data, expected }) => runTool(async () => {
      const result = await client.post<{ session: AgentBuildSession }>(
        `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/test-data`,
        { body: { data, expected } },
      );
      return { ...result, note: noteFor(result.session) };
    }),
  );

  server.registerTool(
    'run_agent_build_test',
    {
      title: 'Run the real AIOS build test',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Start the real asynchronous AIOS test after test data was submitted. Poll get_agent_build until PASSED or FAILED. A pass still requires separate FDE finalization; this tool cannot finalize.',
      inputSchema: { sessionId: z.string().min(1) },
    },
    async ({ sessionId }) => runTool(async () => {
      const result = await client.post<{ session: AgentBuildSession }>(
        `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/test`,
        { body: {} },
      );
      return { ...result, note: noteFor(result.session) };
    }),
  );
}
