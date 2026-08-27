// Skill activation gates (fail-closed). Shared by skill confirm + proposal approval + attach.
import type { Prisma, Skill } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';

type Tx = Prisma.TransactionClient;

/** RECORDED origin or COMPUTER_CONTROL kind requires CODEX execute engine (ADR 0005). */
export function skillRequiresCodex(skill: Pick<Skill, 'origin' | 'kind'>): boolean {
  return skill.origin === 'RECORDED' || skill.kind === 'COMPUTER_CONTROL';
}

/**
 * Fail-closed: no non-CODEX linked agent may activate a RECORDED / COMPUTER_CONTROL skill.
 * Call before confirm / confirm_skill proposal approval / mount.
 */
export async function assertCodexGateForLinkedAgents(
  skill: Pick<Skill, 'id' | 'origin' | 'kind'>,
  client: Tx | typeof prisma = prisma,
): Promise<void> {
  if (!skillRequiresCodex(skill)) return;

  const links = await client.agentSkill.findMany({
    where: { skillId: skill.id },
    include: {
      agent: { select: { id: true, name: true, engineExecute: true, deletedAt: true } },
    },
  });

  const offenders = links.filter((l) => !l.agent.deletedAt && l.agent.engineExecute !== 'CODEX');
  if (offenders.length > 0) {
    const names = offenders.map((o) => o.agent.name || o.agent.id).join(', ');
    throw errors.badRequest(
      `此類技能只能由 CODEX 引擎驅動，請將員工主引擎改為 CODEX（目前掛載於非 CODEX：${names}）`,
    );
  }
}

/**
 * Confirm a skill that is still awaiting human confirmation.
 * Applies CODEX gate for any linked agents. Does not trust client content.
 */
export async function confirmAwaitingSkill(
  skillId: string,
  confirmedBy: string,
  opts?: {
    /** When set, skill must already be linked to this agent (proposal scope). */
    requireLinkedAgentId?: string;
    client?: Tx | typeof prisma;
  },
): Promise<Skill> {
  const client = opts?.client ?? prisma;
  const skill = await client.skill.findFirst({ where: { id: skillId, deletedAt: null } });
  if (!skill) throw errors.notFound('Skill not found');

  if (skill.reviewStatus !== 'AWAITING_USER_CONFIRM') {
    throw errors.conflict(`Skill is not awaiting confirmation (status=${skill.reviewStatus})`);
  }

  if (opts?.requireLinkedAgentId) {
    const link = await client.agentSkill.findUnique({
      where: {
        agentId_skillId: { agentId: opts.requireLinkedAgentId, skillId },
      },
    });
    if (!link) {
      throw errors.badRequest('Skill is not linked to the proposal agent');
    }
  }

  await assertCodexGateForLinkedAgents(skill, client);

  return client.skill.update({
    where: { id: skillId },
    data: {
      reviewStatus: 'CONFIRMED',
      confirmedBy,
      confirmedAt: new Date(),
    },
  });
}
