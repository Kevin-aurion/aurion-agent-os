import { prisma } from '../../src/lib/db.js';
import { audit } from '../../src/lib/audit.js';

const runawaySessionIds = [
  '01KZH14X0WGN8YN7F1DSWW8EAQ',
  '01KZH1FKX8W85MTC8ZA5EKVR7H',
  '01KZH1HFGWCKD6ZHHGYTND04ET',
];
const placeholderAgentId = '01KZ48YW1SNQTVNWCF842GKDKN';
const placeholderSkillId = '01KZ48YW2017CPVE0E5CG0RRK0';
const proposalAgentId = '01KZGPJ1JS9H33FTVS07JYKGB8';
const oldName = '提案三件套生成員';
const newName = '提案三件套製作專員';

function replaceName(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(oldName, newName);
  if (Array.isArray(value)) return value.map(replaceName);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceName(item)]),
    );
  }
  return value;
}

async function main() {
  const actor = await prisma.user.findFirst({
    where: { email: process.env.AIOS_OWNER_EMAIL || 'fde@aios.test', deletedAt: null },
    select: { id: true },
  });
  if (!actor) throw new Error('Kevin owner account not found');

  const sessions = await prisma.agentBuildSession.findMany({
    where: { id: { in: runawaySessionIds } },
    select: { id: true, brief: true },
  });
  if (sessions.length !== runawaySessionIds.length) {
    throw new Error(`Expected ${runawaySessionIds.length} runaway sessions, found ${sessions.length}`);
  }
  for (const session of sessions) {
    const objective = String((session.brief as Record<string, unknown> | null)?.objective ?? '');
    if (!objective.includes('【Agent Builder 試跑】')) {
      throw new Error(`Refusing to delete non-test Builder session ${session.id}`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.agentBuildSession.deleteMany({ where: { id: { in: runawaySessionIds } } });

    const placeholder = await tx.agent.findUnique({
      where: { id: placeholderAgentId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (placeholder) {
      if (placeholder.name !== '持續學習中的 AI 員工' || !placeholder.deletedAt) {
        throw new Error('Refusing to hard-delete unexpected placeholder Agent');
      }
      await tx.agent.delete({ where: { id: placeholderAgentId } });
    }
    const placeholderSkill = await tx.skill.findUnique({
      where: { id: placeholderSkillId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (placeholderSkill) {
      if (placeholderSkill.name !== '持續學習中的 AI 員工核心能力' || !placeholderSkill.deletedAt) {
        throw new Error('Refusing to hard-delete unexpected placeholder Skill');
      }
      await tx.skill.delete({ where: { id: placeholderSkillId } });
    }

    const agent = await tx.agent.findUnique({ where: { id: proposalAgentId } });
    if (!agent || agent.name !== oldName) {
      throw new Error('Proposal Agent is missing or already has an unexpected name');
    }
    await tx.agent.update({
      where: { id: proposalAgentId },
      data: {
        name: newName,
        rolePrompt: agent.rolePrompt.replaceAll(oldName, newName),
      },
    });

    const buildSessions = await tx.agentBuildSession.findMany({
      where: { OR: [{ builtAgentId: proposalAgentId }, { targetAgentId: proposalAgentId }] },
      include: { iterations: true },
    });
    for (const session of buildSessions) {
      await tx.agentBuildSession.update({
        where: { id: session.id },
        data: {
          brief: replaceName(session.brief) as object,
          plan: session.plan == null ? undefined : replaceName(session.plan) as object,
        },
      });
      for (const iteration of session.iterations) {
        if (iteration.artifactSnapshot == null) continue;
        await tx.agentBuildIteration.update({
          where: { id: iteration.id },
          data: { artifactSnapshot: replaceName(iteration.artifactSnapshot) as object },
        });
      }
    }
  });

  await audit(actor.id, 'agent_builder.runaway_test_sessions_deleted', 'AgentBuildSession', runawaySessionIds[0], {
    sessionIds: runawaySessionIds,
    reason: 'Internal Agent Builder test was incorrectly captured by Claude Code hooks.',
  });
  await audit(actor.id, 'agent.deleted_permanently', 'Agent', placeholderAgentId, {
    name: '持續學習中的 AI 員工',
    alreadySoftDeleted: true,
  });
  await audit(actor.id, 'agent.renamed', 'Agent', proposalAgentId, { oldName, newName });

  console.log(JSON.stringify({
    deletedRunawaySessions: runawaySessionIds,
    deletedPlaceholderAgent: placeholderAgentId,
    deletedPlaceholderSkill: placeholderSkillId,
    renamedAgent: { id: proposalAgentId, oldName, newName },
  }, null, 2));
}

main()
  .finally(async () => prisma.$disconnect());
