// Fail-closed skill promotion / rollback gates (Slice 2).
// Reuses skillversion promote/rollback; never auto-CONFIRMs skills.
import { prisma } from './db.js';
import { errors } from './http.js';
import { audit } from './audit.js';
import { assertCodexGateForLinkedAgents } from './skillgate.js';
import { promoteToStable, rollbackStable } from './skillversion.js';

function assertFde(actorRole: string): void {
  if (actorRole !== 'OWNER' && actorRole !== 'TRAINER') {
    throw errors.forbidden('需要訓練權限（OWNER 或 TRAINER）才能發布/回滾技能');
  }
}

/**
 * Promote a SkillVersion to stable after fail-closed gates:
 * FDE role → skill CONFIRMED → PASSED eval run → no unresolved high-risk → Codex gate → promote.
 */
export async function promoteWithGate(args: {
  skillId: string;
  versionId: string;
  actorId: string;
  actorRole: string;
}): Promise<void> {
  // a. FDE only (defense in depth; route also uses requireTrainer)
  assertFde(args.actorRole);

  // b. skill exists
  const skill = await prisma.skill.findFirst({
    where: { id: args.skillId, deletedAt: null },
  });
  if (!skill) throw errors.notFound('Skill not found');

  // c. must already be FDE-confirmed (iron rule 4 — never CONFIRM here)
  if (skill.reviewStatus !== 'CONFIRMED') {
    throw errors.conflict('技能尚未經 FDE 確認，不可發布');
  }

  // d. latest EvalRun for this skill+version must be PASSED
  const passedRun = await prisma.evalRun.findFirst({
    where: {
      skillId: args.skillId,
      candidateVersionId: args.versionId,
      status: 'PASSED',
    },
    orderBy: { startedAt: 'desc' },
  });
  if (!passedRun) {
    throw errors.conflict('沒有通過的評測執行，拒絕發布（fail-closed）');
  }

  // e. unresolved high-risk results for this candidate version
  const openHighRisk = await prisma.evalResult.findFirst({
    where: {
      highRisk: true,
      resolved: false,
      run: {
        skillId: args.skillId,
        candidateVersionId: args.versionId,
      },
    },
  });
  if (openHighRisk) {
    throw errors.conflict('存在未解的高風險評測失敗，拒絕發布');
  }

  // f. Codex gate for linked agents (RECORDED / COMPUTER_CONTROL)
  await assertCodexGateForLinkedAgents(skill);

  // g. underlying pointer switch (existing skillversion API)
  await promoteToStable(args.skillId, args.versionId);

  // h. audit trail
  await audit(args.actorId, 'skill.promote_stable', 'Skill', args.skillId, {
    versionId: args.versionId,
    evalRunId: passedRun.id,
  });
}

/**
 * Rollback stable pointer to an earlier version. Versions and eval evidence are retained.
 */
export async function rollbackWithGate(args: {
  skillId: string;
  versionId: string;
  actorId: string;
  actorRole: string;
}): Promise<void> {
  assertFde(args.actorRole);

  const skill = await prisma.skill.findFirst({
    where: { id: args.skillId, deletedAt: null },
  });
  if (!skill) throw errors.notFound('Skill not found');

  await rollbackStable(args.skillId, args.versionId);

  await audit(args.actorId, 'skill.rollback_stable', 'Skill', args.skillId, {
    versionId: args.versionId,
  });
}

/**
 * Explicit non-stable stage: set SkillVersion.channel to shadow|canary only.
 * Does not touch Skill.stableVersionId. FDE only. Not a fail-closed release gate.
 */
export async function setStage(args: {
  skillId: string;
  versionId: string;
  stage: 'shadow' | 'canary';
  actorId: string;
  actorRole: string;
}): Promise<void> {
  assertFde(args.actorRole);

  const ver = await prisma.skillVersion.findFirst({
    where: { id: args.versionId, skillId: args.skillId },
  });
  if (!ver) throw errors.notFound('SkillVersion not found');

  await prisma.skillVersion.update({
    where: { id: args.versionId },
    data: { channel: args.stage },
  });

  await audit(args.actorId, 'skill.set_stage', 'SkillVersion', args.versionId, {
    skillId: args.skillId,
    stage: args.stage,
  });
}
