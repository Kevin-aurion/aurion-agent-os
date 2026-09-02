// External Agent Builder tools for Claude, ChatGPT, Codex and Cursor.
// These tools synchronize one durable training session and let its owner
// activate the latest READY snapshot as a callable AIOS employee.
import { open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { AgentBuildSession, ExternalBuilderSource } from '../types.js';
import { runTool } from './util.js';

const sourceSchema = z.enum(['CLAUDE_DESKTOP', 'CLAUDE_CODE', 'CODEX', 'CHATGPT', 'CURSOR', 'OTHER']);

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
    department: z.string().min(1).max(80).optional()
      .describe('Business department or function, for example 專案管理、財務、營運. Use 未分類 only when genuinely unclear.'),
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
    status: z.enum(['AVAILABLE', 'NEEDS_SETUP', 'NEEDS_FDE', 'NOT_NEEDED']).optional(),
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

const DESTRUCTIVE_DRAFT = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

function noteFor(session: AgentBuildSession): string {
  if (session.status === 'AWAITING_FDE') {
    return 'This is a legacy pending build. Synchronize one complete snapshot to migrate and make it callable in place.';
  }
  if (session.status === 'AWAITING_TEST_DATA') {
    return 'This is a legacy materialized build. Synchronize one complete snapshot to migrate it; no separate test is required.';
  }
  if (session.status === 'PASSED') {
    return 'This is a legacy passed build. Synchronize one complete snapshot to make the same employee callable.';
  }
  if (session.status === 'ACTIVE') {
    return 'The latest trained version is active and callable. Further training continues in this same build session.';
  }
  return 'Continue training in this session. The first complete synchronized snapshot becomes callable automatically.';
}

export function readinessFor(
  session: AgentBuildSession,
  agentName: string,
  becameReady: boolean,
): {
  readyForUse: boolean;
  becameReady: boolean;
  userNotice: string;
} {
  const name = agentName.trim() || '這位 AI 員工';
  const agentId = session.agentId ?? session.builtAgentId ?? session.targetAgentId;
  if (session.status !== 'ACTIVE' || !agentId) {
    return {
      readyForUse: false,
      becameReady: false,
      userNotice: `「${name}」還沒有完成建立，請繼續訓練；等 AIOS 回傳可以使用後再交付工作。`,
    };
  }
  return {
    readyForUse: true,
    becameReady,
    userNotice: becameReady
      ? `「${name}」已經建立完成，現在就可以開始使用。你可以直接說：「請叫 ${name} 幫我處理……」。`
      : `「${name}」的最新訓練內容已更新完成，現在可以繼續使用。`,
  };
}

function summarizeIteration(iteration: unknown): Record<string, unknown> | null {
  if (!iteration || typeof iteration !== 'object' || Array.isArray(iteration)) return null;
  const value = iteration as Record<string, unknown>;
  return {
    id: value.id,
    sequence: value.sequence,
    triggerKind: value.triggerKind,
    status: value.status,
    userSummary: value.userSummary,
    error: value.error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * Builder writes can contain the complete transcript and every historical
 * Harness snapshot. Returning that payload after each write makes MCP clients
 * repeat the entire training history in their context. Keep the authoritative
 * copy in AIOS and return only the fields needed to continue the conversation.
 */
export function summarizeAgentBuildSession(session: AgentBuildSession): Record<string, unknown> {
  return {
    id: session.id,
    status: session.status,
    agentId: session.agentId ?? null,
    targetAgentId: session.targetAgentId,
    builtAgentId: session.builtAgentId,
    strategy: session.strategy,
    draftSkillIds: session.draftSkillIds,
    hasTestData: session.hasTestData,
    lastRunId: session.lastRunId,
    transcriptCount: session.transcript.length,
    iterationCount: session.iterations.length,
    latestIteration: summarizeIteration(session.latestIteration),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function summarizeAgentBuildForResume(session: AgentBuildSession): Record<string, unknown> {
  return {
    ...summarizeAgentBuildSession(session),
    // Preserve the established session.transcript / session.iterations /
    // session.latestIteration shape, but include only the context required to
    // resume from the latest draft instead of replaying the whole ledger.
    transcript: session.transcript.slice(-6),
    iterations: session.latestIteration ? [session.latestIteration] : [],
    latestIteration: session.latestIteration,
  };
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
        'Start or resume one durable AIOS training session from a user request made in ChatGPT, Claude, Codex or Cursor. This records the initial request; providing an existing agentId always resumes that employee’s same backend session. The start call alone has no complete employee snapshot yet; the first complete snapshot becomes callable automatically. Keep the returned session.id for later sync calls.',
      inputSchema: {
        initialRequest: z.string().min(1).max(12_000),
        source: sourceSchema.optional(),
        externalConversationId: z.string().min(1).max(160).optional().describe('Stable id for this desktop conversation; reuse it after retries.'),
        externalConversationTitle: z.string().max(240).optional(),
        requestedAgentName: z.string().max(120).optional(),
        agentId: z.string().min(1).optional()
          .describe('若要繼續訓練既有員工，帶入該員工的 agentId：系統會自動續接該員工唯一的建置對話，不會新建。'),
      },
    },
    async ({ initialRequest, source, externalConversationId, externalConversationTitle, requestedAgentName, agentId }) =>
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
              agentId,
            },
          },
        );
        return {
          session: summarizeAgentBuildSession(result.session),
          deduplicated: result.deduplicated,
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
        return {
          session: summarizeAgentBuildSession(result.session),
          deduplicated: result.deduplicated,
          iteration: summarizeIteration(result.iteration),
          note: noteFor(result.session),
        };
      }),
  );

  server.registerTool(
    'sync_agent_build_artifact',
    {
      title: 'Sync a complete AIOS agent draft',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Synchronize the complete current training snapshot produced in ChatGPT, Claude, Codex or Cursor: identity/Agent Markdown, SKILL.md bodies, memory documents, tools, policies and workflows. Send a full snapshot, not only a patch. A successful snapshot immediately creates or updates the same callable employee. The server redacts secrets, rejects unsafe memory paths and marks unverified tool connections as NEEDS_SETUP.',
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
          becameCallable: boolean;
        }>(`/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/external-artifact`, {
          body: { source: resolvedSource(source), externalEventId, artifact },
        });
        const readiness = readinessFor(result.session, artifact.identity.name, result.becameCallable);
        return {
          session: summarizeAgentBuildSession(result.session),
          iteration: summarizeIteration(result.iteration),
          deduplicated: result.deduplicated,
          note: noteFor(result.session),
          ...readiness,
          callability: readiness.readyForUse
            ? 'The latest complete snapshot is active and callable; later training will update this same employee.'
            : 'The snapshot is not callable yet. Continue only from the returned real session status.',
        };
      }),
  );

  server.registerTool(
    'upsert_agent_build_snapshot',
    {
      title: 'Save a complete Agent Builder turn and draft',
      description:
        'Preferred synchronization tool for ChatGPT and other clients without lifecycle hooks. It retry-safely stores the exact paired conversation turn and complete current Agent/Skill/Memory/Workflow/Test snapshot. A successful complete snapshot immediately creates or updates the same callable employee without a separate activation command.',
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
          artifact: { deduplicated: boolean; iteration: unknown; becameCallable: boolean };
        }>(`/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/external-snapshot`, {
          body: { source, externalEventId, turns, summary, artifact },
        });
        const readiness = readinessFor(
          result.session,
          artifact.identity.name,
          result.artifact.becameCallable,
        );
        return {
          session: summarizeAgentBuildSession(result.session),
          turn: {
            deduplicated: result.turn.deduplicated,
            iteration: summarizeIteration(result.turn.iteration),
          },
          artifact: {
            deduplicated: result.artifact.deduplicated,
            iteration: summarizeIteration(result.artifact.iteration),
            becameCallable: result.artifact.becameCallable,
          },
          note: noteFor(result.session),
          ...readiness,
          callability: readiness.readyForUse
            ? 'The latest complete snapshot is active and callable; later training will update this same employee.'
            : 'The snapshot is not callable yet. Continue only from the returned real session status.',
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
          session: summarizeAgentBuildSession(result.session),
          assistantMessage: result.assistantMessage,
          status: result.status,
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
        'Claude Code Stop-hook tool. It mirrors the final assistant message, catches a missed Agent-building user prompt, and lets AIOS update the same durable Agent training session asynchronously. It does not activate an Agent by itself.',
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
        'Resume one owned AIOS build. By default this returns the latest complete training snapshot plus only the six most recent conversation entries; set includeHistory only for explicit audit/debug work.',
      inputSchema: {
        sessionId: z.string().min(1),
        includeHistory: z.boolean().default(false),
      },
    },
    async ({ sessionId, includeHistory }) => runTool(async () => {
      const session = await client.get<AgentBuildSession>(
        `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}`,
      );
      return {
        session: includeHistory ? session : summarizeAgentBuildForResume(session),
        historyIncluded: includeHistory,
        note: noteFor(session),
      };
    }),
  );

  server.registerTool(
    'list_agent_builds',
    {
      title: 'List AIOS agent builds',
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        'List the signed-in user’s recent AIOS Agent Builder sessions for resume or status checks. Each item includes agentId when the build is bound to an employee; pass that agentId to start_agent_build to resume the same conversation instead of opening a new one.',
      inputSchema: {},
    },
    async () => runTool(async () => {
      const sessions = await client.get<AgentBuildSession[]>('/api/agent-builder/sessions');
      return sessions.map(summarizeAgentBuildSession);
    }),
  );

  server.registerTool(
    'abandon_agent_build',
    {
      title: 'Abandon an unsubmitted AIOS build draft',
      annotations: DESTRUCTIVE_DRAFT,
      description:
        '捨棄一個尚未產生 Agent／Skill 的訓練草稿（DISCOVERY/PLAN_READY）。呼叫前先用 list_agent_builds 確認並向使用者取得明確同意。這是軟刪：紀錄保留、不再出現在清單。已產生 Agent／Skill 的建置無法用此工具捨棄。',
      inputSchema: {
        sessionId: z.string().min(1).describe('The sessionId returned by list_agent_builds.'),
        confirmSessionId: z.string().min(1).describe(
          'Must equal sessionId. Required confirmation so a stale or guessed id cannot be abandoned by accident.',
        ),
      },
    },
    async ({ sessionId, confirmSessionId }) =>
      runTool(async () => {
        const session = await client.post<AgentBuildSession>(
          `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/abandon`,
          { body: { confirmSessionId } },
        );
        return { session: summarizeAgentBuildSession(session), note: noteFor(session) };
      }),
  );

  server.registerTool(
    'activate_agent_build',
    {
      title: 'Activate the trained AIOS employee',
      annotations: DRAFT_WRITE_ANNOTATIONS,
      description:
        'Compatibility and recovery tool for legacy pending builds. Normal training does not need this call because every successfully synchronized complete snapshot is immediately callable. It preserves the same build session and existing Agent id.',
      inputSchema: {
        sessionId: z.string().min(1),
      },
    },
    async ({ sessionId }) => runTool(async () => {
      const session = await client.post<AgentBuildSession>(
        `/api/agent-builder/sessions/${encodeURIComponent(sessionId)}/activate`,
        { body: {} },
      );
      return {
        session: summarizeAgentBuildSession(session),
        note: noteFor(session),
        agentId: session.agentId ?? session.builtAgentId ?? session.targetAgentId,
      };
    }),
  );
}
