// FDE Skill governance read layer: version list + promote-gate dry-run (zero writes).
// Replays promoteWithGate checks a–f without calling promoteToStable or writing DB.
import type { Skill } from '@prisma/client';
import { prisma } from './db.js';
import { errors } from './http.js';
import { assertCodexGateForLinkedAgents } from './skillgate.js';

export type SkillVersionListItem = {
  id: string;
  version: number;
  contentHash: string;
  channel: string;
  schemaVersion: string | null;
  createdBy: string | null;
  createdAt: Date;
  contentMd: string;
};

export type ListSkillVersionsResult = {
  skill: {
    id: string;
    name: string;
    slug: string;
    reviewStatus: Skill['reviewStatus'];
    confirmedBy: string | null;
    confirmedAt: Date | null;
    stableVersionId: string | null;
    canaryVersionId: string | null;
  };
  versions: SkillVersionListItem[];
};

export type PromoteGateCheck = {
  key: string;
  ok: boolean;
  reason: string;
  evalRunId?: string;
};

export type PromoteGateResult = {
  canPromote: boolean;
  checks: PromoteGateCheck[];
};

/**
 * List all SkillVersions for a skill (newest first). Pure read.
 */
export async function listSkillVersions(skillId: string): Promise<ListSkillVersionsResult> {
  const skill = await prisma.skill.findFirst({
    where: { id: skillId, deletedAt: null },
    select: {
      id: true,
      name: true,
      slug: true,
      reviewStatus: true,
      confirmedBy: true,
      confirmedAt: true,
      stableVersionId: true,
      canaryVersionId: true,
    },
  });
  if (!skill) throw errors.notFound('Skill not found');

  const versions = await prisma.skillVersion.findMany({
    where: { skillId },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      contentHash: true,
      channel: true,
      schemaVersion: true,
      createdBy: true,
      createdAt: true,
      contentMd: true,
    },
  });

  return { skill, versions };
}

/**
 * Read-only re-run of promoteWithGate gates (a–f style). Never promotes, never writes.
 */
export async function readPromoteGate(
  skillId: string,
  versionId: string,
): Promise<PromoteGateResult> {
  const skill = await prisma.skill.findFirst({
    where: { id: skillId, deletedAt: null },
  });
  if (!skill) throw errors.notFound('Skill not found');

  const checks: PromoteGateCheck[] = [];

  // 1. skill_confirmed
  if (skill.reviewStatus === 'CONFIRMED') {
    checks.push({ key: 'skill_confirmed', ok: true, reason: '' });
  } else {
    checks.push({
      key: 'skill_confirmed',
      ok: false,
      reason: '技能尚未經 FDE 確認，不可發布',
    });
  }

  // 2. version_exists
  const ver = await prisma.skillVersion.findFirst({
    where: { id: versionId, skillId },
    select: { id: true },
  });
  if (ver) {
    checks.push({ key: 'version_exists', ok: true, reason: '' });
  } else {
    checks.push({
      key: 'version_exists',
      ok: false,
      reason: '目標版本不存在或不屬於此技能',
    });
  }

  // 3. eval_passed
  const passedRun = await prisma.evalRun.findFirst({
    where: {
      skillId,
      candidateVersionId: versionId,
      status: 'PASSED',
    },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  if (passedRun) {
    checks.push({
      key: 'eval_passed',
      ok: true,
      reason: '',
      evalRunId: passedRun.id,
    });
  } else {
    checks.push({
      key: 'eval_passed',
      ok: false,
      reason: '沒有通過的評測執行（fail-closed）',
    });
  }

  // 4. no_unresolved_high_risk
  const openHighRiskCount = await prisma.evalResult.count({
    where: {
      highRisk: true,
      resolved: false,
      run: {
        skillId,
        candidateVersionId: versionId,
      },
    },
  });
  if (openHighRiskCount === 0) {
    checks.push({ key: 'no_unresolved_high_risk', ok: true, reason: '' });
  } else {
    checks.push({
      key: 'no_unresolved_high_risk',
      ok: false,
      reason: `存在 ${openHighRiskCount} 筆未解的高風險評測失敗，拒絕發布`,
    });
  }

  // 5. codex_gate
  try {
    await assertCodexGateForLinkedAgents(skill);
    checks.push({ key: 'codex_gate', ok: true, reason: '' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ key: 'codex_gate', ok: false, reason: msg });
  }

  return {
    canPromote: checks.every((c) => c.ok),
    checks,
  };
}
