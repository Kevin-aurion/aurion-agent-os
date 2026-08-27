import { Prisma } from '@prisma/client';
import { ulid } from 'ulid';
import { prisma } from './db.js';
import { slugify } from './slug.js';
import { deepRedactSecrets } from '../memory/deepredact.js';

export const BUILDER_WORKING_RESTRICTIONS = {
  webSearch: false,
  computerUse: false,
  sendEmail: false,
  cloudWrite: false,
  shell: false,
  cloudEmbedding: false,
  notes: '建立後即可對話；外部工具、寫入與不可逆操作仍需另外授權。',
} as const;

type BuilderBrief = {
  requestedAgentName?: string;
  objective?: string;
  process?: string;
  tags?: string[];
};

function asBrief(raw: Prisma.JsonValue | null): BuilderBrief {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as BuilderBrief;
}

async function uniqueAgentSlug(tx: Prisma.TransactionClient, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;
  while (await tx.agent.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export async function createBuilderWorkingAgent(
  tx: Prisma.TransactionClient,
  opts: {
    userId: string;
    name?: string;
    objective?: string;
    process?: string;
    tags?: string[];
  },
): Promise<{ id: string; name: string }> {
  const name = (opts.name?.trim() || '新 AI 員工').slice(0, 80);
  const objective = (opts.objective?.trim() || `協助使用者完成「${name}」相關工作`).slice(0, 500);
  const rolePrompt = deepRedactSecrets([
    `你是「${name}」，建立後即可直接接受使用者交辦工作。`,
    `目標：${objective}`,
    opts.process?.trim() ? `目前工作方式：${opts.process.trim().slice(0, 8_000)}` : '',
    '遇到資訊不足時先詢問，不得宣稱已完成未實際執行的外部操作。',
    '目前禁止網路搜尋、寄信、雲端寫入、Shell 與電腦操控；這些能力必須另外授權。',
  ].filter(Boolean).join('\n'));
  const id = ulid();
  const slug = await uniqueAgentSlug(tx, name);
  await tx.agent.create({
    data: {
      id,
      slug,
      name,
      description: deepRedactSecrets(objective),
      department: opts.tags?.includes('finance') ? '財務' : '未分類',
      rolePrompt,
      engineExecute: 'CLAUDE_CODE',
      engineVerify: null,
      restrictions: BUILDER_WORKING_RESTRICTIONS,
      riskTier: 'medium',
      status: 'ACTIVE',
      createdBy: opts.userId,
    },
  });
  return { id, name };
}

export async function ensureBuilderWorkingAgent(sessionId: string): Promise<{
  created: boolean;
  sessionId: string;
  agentId: string | null;
  reason?: string;
}> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ locked: number }>>`
      WITH builder_lock AS (
        SELECT pg_advisory_xact_lock(hashtext('builder-working-agent'), hashtext(${sessionId}))
      )
      SELECT 1::int AS "locked" FROM builder_lock
    `;
    const row = await tx.agentBuildSession.findUnique({ where: { id: sessionId } });
    if (!row) return { created: false, sessionId, agentId: null, reason: 'missing_session' };
    const existingId = row.builtAgentId ?? row.targetAgentId ?? row.agentId;
    if (existingId) return { created: false, sessionId, agentId: existingId, reason: 'already_bound' };
    if (row.status === 'ABANDONED') return { created: false, sessionId, agentId: null, reason: 'abandoned' };
    if (row.status !== 'DISCOVERY') {
      return { created: false, sessionId, agentId: null, reason: `unsupported_status:${row.status}` };
    }
    if (row.strategy && row.strategy !== 'create') {
      return { created: false, sessionId, agentId: null, reason: 'reuse_session' };
    }
    const brief = asBrief(row.brief);
    const workingAgent = await createBuilderWorkingAgent(tx, {
      userId: row.userId,
      name: brief.requestedAgentName || row.externalConversationTitle || undefined,
      objective: brief.objective,
      process: brief.process,
      tags: brief.tags,
    });
    await tx.agentBuildSession.update({
      where: { id: row.id },
      data: {
        status: 'ACTIVE',
        strategy: 'create',
        agentId: workingAgent.id,
        targetAgentId: workingAgent.id,
        builtAgentId: workingAgent.id,
      },
    });
    return { created: true, sessionId, agentId: workingAgent.id };
  });
}
