// Safe conversational preview for an Agent Builder Shadow Draft.
//
// This is deliberately not a live Agent run: the latest READY Harness is
// rendered into a no-tools prompt so an end user can coach it through Claude
// MCP before FDE review. Every pair is persisted as redacted evidence and
// queues a non-effective reflection iteration.
import type { Prisma, UserRole } from '@prisma/client';
import { runClaude } from '../engine/claude.js';
import { paths } from '../config.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { audit } from './audit.js';
import { createBuilderEvolutionIteration, type HarnessSnapshot } from './agentbuilderevolution.js';
import { loadOwnedSession } from './agentbuilder.js';
import { prisma } from './db.js';
import { errors } from './http.js';
import { hub } from '../ws/hub.js';
import {
  assemblePrompt,
  PROMPT_ORDER,
  type PromptSection,
} from './promptassembly.js';

type TranscriptEntry = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  source?: string;
  externalEventId?: string;
};

export type ShadowExecute = (input: {
  prompt: string;
  systemAppend?: string;
  signal?: AbortSignal;
}) => Promise<string>;

const CATALOG_TEXT_MAX = 400;

function truncate(s: string, max = CATALOG_TEXT_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function bullets(items: string[], empty = '（無）'): string {
  if (!items.length) return `- ${empty}`;
  return items.map((item) => `- ${truncate(item)}`).join('\n');
}

function renderShadowIdentity(identity: HarnessSnapshot['identity']): string {
  const name = String(identity?.name ?? '').trim() || '（未命名）';
  const purpose = String(identity?.purpose ?? '').trim() || '（未指定）';
  const styles = asStringList(identity?.workingStyle);
  return [
    '## 身份',
    `- 名稱: ${truncate(name)}`,
    `- 目的: ${truncate(purpose)}`,
    '- 工作風格:',
    styles.length ? styles.map((item) => `  - ${truncate(item)}`).join('\n') : '  - （未指定）',
  ].join('\n');
}

function renderShadowSkills(skills: HarnessSnapshot['skills']): string {
  const lines = ['## Shadow Skills', ''];
  if (!Array.isArray(skills) || skills.length === 0) {
    lines.push('（目前沒有技能草稿）');
    return lines.join('\n');
  }
  for (const skill of skills) {
    const name = String(skill?.name ?? '').trim() || '（未命名技能）';
    const purpose = String(skill?.purpose ?? '').trim() || '（無）';
    const instructions = asStringList(skill?.instructions);
    const summary = instructions.length
      ? instructions.slice(0, 6).map((item) => truncate(item)).join('；')
      : '（無）';
    lines.push(`## ${name}`);
    lines.push(`- 用途: ${truncate(purpose)}`);
    lines.push(`- 指令摘要: ${summary}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderShadowMemory(memory: HarnessSnapshot['memory']): string {
  const facts = asStringList(memory?.facts);
  const preferences = asStringList(memory?.preferences);
  const glossary = asStringList(memory?.glossary);
  const documents = Array.isArray(memory?.documents) ? memory.documents : [];
  const docLines = documents.length
    ? documents.map((doc) => {
        const filePath = String(doc?.path ?? '').trim() || '（未命名文件）';
        const purpose = String(doc?.purpose ?? '').trim();
        return purpose ? `- ${truncate(filePath)}：${truncate(purpose)}` : `- ${truncate(filePath)}`;
      })
    : ['- （無）'];
  return [
    '## 已確認記憶與偏好',
    '',
    '### 事實',
    bullets(facts),
    '',
    '### 偏好',
    bullets(preferences),
    '',
    '### 術語',
    bullets(glossary),
    '',
    '### 文件',
    ...docLines,
  ].join('\n');
}

function renderShadowPolicies(policies: HarnessSnapshot['policies']): string {
  return [
    '## 權限邊界',
    '',
    '### 允許',
    bullets(asStringList(policies?.allowed)),
    '',
    '### 需核准',
    bullets(asStringList(policies?.requiresApproval)),
    '',
    '### 禁止',
    bullets(asStringList(policies?.forbidden)),
  ].join('\n');
}

function shadowHarnessSections(
  harness: Pick<HarnessSnapshot, 'identity' | 'skills' | 'memory' | 'policies'>,
): PromptSection[] {
  return [
    {
      name: 'shadow-identity',
      order: PROMPT_ORDER.contract + 10,
      enabled: true,
      render: () => renderShadowIdentity(harness.identity),
    },
    {
      name: 'shadow-skills',
      order: PROMPT_ORDER.contract + 20,
      enabled: true,
      render: () => renderShadowSkills(harness.skills),
    },
    {
      name: 'shadow-memory',
      order: PROMPT_ORDER.contract + 30,
      enabled: true,
      render: () => renderShadowMemory(harness.memory),
    },
    {
      name: 'shadow-policies',
      order: PROMPT_ORDER.contract + 40,
      enabled: true,
      render: () => renderShadowPolicies(harness.policies),
    },
  ];
}

export function renderShadowPrompt(
  harness: Pick<HarnessSnapshot, 'identity' | 'skills' | 'memory' | 'policies'>,
  message: string,
): { systemPrompt: string; userTurn: string; sectionsUsed: string[] } {
  const extraSections = shadowHarnessSections(harness);
  const assembled = assemblePrompt({
    stage: 'shadow',
    vars: {},
    extraSections,
  });
  return {
    systemPrompt: assembled.systemPrompt,
    userTurn: message,
    sectionsUsed: assembled.sectionsUsed,
  };
}

export const BUILDER_SHADOW_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'Task',
] as const;

function transcript(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is TranscriptEntry => {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    return Boolean(row && ['user', 'assistant', 'system'].includes(String(row.role)) && typeof row.content === 'string');
  }).slice(-1_000);
}

async function defaultExecute(input: {
  prompt: string;
  systemAppend?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await runClaude({
    prompt: input.prompt,
    systemAppend: input.systemAppend,
    cwd: paths.cache,
    timeoutMs: 120_000,
    signal: input.signal,
    safeMode: true,
    disallowedTools: [...BUILDER_SHADOW_DISALLOWED_TOOLS],
  });
  return result.stdout;
}

export async function chatWithBuilderShadow(opts: {
  sessionId: string;
  userId: string;
  role: UserRole | string;
  message: string;
  execute?: ShadowExecute;
  signal?: AbortSignal;
}): Promise<{
  sessionId: string;
  iterationId: string;
  reply: string;
  reflectionQueued: boolean;
}> {
  const session = await loadOwnedSession(opts.sessionId, opts.userId, opts.role);
  if (session.userId !== opts.userId) throw errors.notFound('Session not found');
  if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(session.status)) {
    throw errors.conflict(`Shadow training is unavailable from status=${session.status}`);
  }
  const message = String(deepRedactSecrets(opts.message)).trim().slice(0, 24_000);
  if (!message) throw errors.badRequest('message is required');

  const latest = await prisma.agentBuildIteration.findFirst({
    where: { sessionId: session.id, status: 'READY' },
    orderBy: { sequence: 'desc' },
  });
  if (!latest?.artifactSnapshot) {
    throw errors.conflict('Shadow Agent is still learning; wait for the latest draft before starting a dialogue test');
  }
  const harness = deepRedactSecrets(latest.artifactSnapshot) as unknown as HarnessSnapshot;
  let systemPrompt = '';
  let userTurn = message;
  try {
    const assembled = renderShadowPrompt(harness, message);
    systemPrompt = assembled.systemPrompt;
    userTurn = assembled.userTurn;
  } catch (err) {
    console.warn('[builderconversation] shadow prompt assembly failed; using harness fallback', err);
    systemPrompt = shadowHarnessSections(harness).map((section) => section.render({})).join('\n\n');
  }
  const rawReply = await (opts.execute ?? defaultExecute)({
    prompt: userTurn,
    systemAppend: systemPrompt || undefined,
    signal: opts.signal,
  });
  const reply = String(deepRedactSecrets(rawReply)).trim().slice(0, 24_000);
  if (!reply) throw errors.badRequest('Shadow Agent returned an empty reply');

  const now = new Date().toISOString();
  const nextTranscript = [
    ...transcript(session.transcript),
    { role: 'system' as const, content: `【互動試教輸入】\n${message}`, at: now, source: 'SHADOW_TEST' },
    { role: 'system' as const, content: `【Shadow Agent 試教回覆】\n${reply}`, at: now, source: 'SHADOW_TEST' },
  ];
  await prisma.agentBuildSession.update({
    where: { id: session.id },
    data: {
      transcript: deepRedactSecrets(nextTranscript) as Prisma.InputJsonValue,
      lastAssistantMessage: reply,
    },
  });

  const reflection = await createBuilderEvolutionIteration({
    sessionId: session.id,
    triggerKind: 'reflection',
    triggerSummary: [
      'Shadow Agent 互動試教結束。',
      `End User 輸入：${message}`,
      `Shadow Agent 行為：${reply}`,
      '請反思輸出是否符合現有 Skill、規則與權限；只把使用者已確認的要求寫成規則，其餘列為假設或測試。',
    ].join('\n'),
  });
  await audit(opts.userId, 'agent_builder.shadow_dialogue', 'AgentBuildSession', session.id, {
    basedOnIterationId: latest.id,
    reflectionIterationId: reflection.id,
  });
  hub.publishToUser(opts.userId, 'agent-builder.shadow.reply', {
    sessionId: session.id,
    iterationId: reflection.id,
    at: now,
  });
  return {
    sessionId: session.id,
    iterationId: reflection.id,
    reply,
    reflectionQueued: true,
  };
}
