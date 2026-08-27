// Content-addressed Skill version history + stable/canary pointers.
// Additive only: does not change existing skill load / materialize paths.
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { prisma } from './db.js';

/** SHA-256 hex digest of markdown content (content-address key). */
export function contentHash(md: string): string {
  return createHash('sha256').update(md, 'utf8').digest('hex');
}

/**
 * Create a canary SkillVersion for the skill (or return existing if same contentHash).
 * Version number = max existing + 1 (or 1). Updates Skill.canaryVersionId on create.
 */
export async function createSkillVersion(
  skillId: string,
  contentMd: string,
  createdBy?: string,
): Promise<{ id: string; version: number; contentHash: string }> {
  const hash = contentHash(contentMd);

  const existing = await prisma.skillVersion.findFirst({
    where: { skillId, contentHash: hash },
    orderBy: { version: 'asc' },
  });
  if (existing) {
    return { id: existing.id, version: existing.version, contentHash: existing.contentHash };
  }

  const agg = await prisma.skillVersion.aggregate({
    where: { skillId },
    _max: { version: true },
  });
  const nextVersion = (agg._max.version ?? 0) + 1;
  const id = ulid();

  await prisma.$transaction([
    prisma.skillVersion.create({
      data: {
        id,
        skillId,
        version: nextVersion,
        contentHash: hash,
        contentMd,
        channel: 'canary',
        createdBy: createdBy ?? null,
      },
    }),
    prisma.skill.update({
      where: { id: skillId },
      data: { canaryVersionId: id },
    }),
  ]);

  return { id, version: nextVersion, contentHash: hash };
}

/**
 * Promote a version to stable: set its channel to stable, point Skill.stableVersionId,
 * and archive the previous stable version's channel.
 */
export async function promoteToStable(skillId: string, versionId: string): Promise<void> {
  const target = await prisma.skillVersion.findFirst({
    where: { id: versionId, skillId },
  });
  if (!target) {
    throw new Error(`SkillVersion ${versionId} not found for skill ${skillId}`);
  }

  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill) {
    throw new Error(`Skill ${skillId} not found`);
  }

  await prisma.$transaction(async (tx) => {
    if (skill.stableVersionId && skill.stableVersionId !== versionId) {
      await tx.skillVersion.updateMany({
        where: { id: skill.stableVersionId, skillId },
        data: { channel: 'archived' },
      });
    }
    await tx.skillVersion.update({
      where: { id: versionId },
      data: { channel: 'stable' },
    });
    await tx.skill.update({
      where: { id: skillId },
      data: { stableVersionId: versionId },
    });
  });
}

/**
 * Rollback stable = switch Skill.stableVersionId to an earlier versionId.
 * Does not delete any versions.
 */
export async function rollbackStable(skillId: string, versionId: string): Promise<void> {
  const target = await prisma.skillVersion.findFirst({
    where: { id: versionId, skillId },
  });
  if (!target) {
    throw new Error(`SkillVersion ${versionId} not found for skill ${skillId}`);
  }

  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill) {
    throw new Error(`Skill ${skillId} not found`);
  }

  await prisma.$transaction(async (tx) => {
    if (skill.stableVersionId && skill.stableVersionId !== versionId) {
      await tx.skillVersion.updateMany({
        where: { id: skill.stableVersionId, skillId },
        data: { channel: 'archived' },
      });
    }
    await tx.skillVersion.update({
      where: { id: versionId },
      data: { channel: 'stable' },
    });
    await tx.skill.update({
      where: { id: skillId },
      data: { stableVersionId: versionId },
    });
  });
}

/**
 * Return contentMd for the skill's current stable or canary pointer, or null if unset.
 */
export async function getActiveContent(
  skillId: string,
  channel: 'stable' | 'canary',
): Promise<string | null> {
  const skill = await prisma.skill.findUnique({
    where: { id: skillId },
    select: { stableVersionId: true, canaryVersionId: true },
  });
  if (!skill) return null;

  const versionId = channel === 'stable' ? skill.stableVersionId : skill.canaryVersionId;
  if (!versionId) return null;

  const ver = await prisma.skillVersion.findUnique({
    where: { id: versionId },
    select: { contentMd: true, skillId: true },
  });
  if (!ver || ver.skillId !== skillId) return null;
  return ver.contentMd;
}
