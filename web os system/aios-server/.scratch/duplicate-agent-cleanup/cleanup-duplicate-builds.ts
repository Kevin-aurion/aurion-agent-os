import { prisma } from '../../src/lib/db.js';
import { audit } from '../../src/lib/audit.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function displayName(row: {
  brief: unknown;
  plan: unknown;
  iterations: Array<{ artifactSnapshot: unknown }>;
}): string {
  const latestHarnessName = [...row.iterations]
    .reverse()
    .map((iteration) => text(object(object(iteration.artifactSnapshot).identity).name))
    .find(Boolean);
  const planName = text(object(row.plan).proposedAgentName);
  const brief = object(row.brief);
  const requestedName = text(brief.requestedAgentName);
  const objective = text(brief.objective).slice(0, 80);
  return latestHarnessName || planName || requestedName || objective || '未命名';
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-TW');
}

async function main() {
  const apply = process.env.APPLY_DUPLICATE_AGENT_CLEANUP === '1';
  const sessions = await prisma.agentBuildSession.findMany({
    include: {
      iterations: { orderBy: { sequence: 'asc' } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  const referencedAgentIds = [...new Set(
    sessions.flatMap((row) => [row.builtAgentId, row.targetAgentId]).filter((id): id is string => Boolean(id)),
  )];
  const agents = referencedAgentIds.length
    ? await prisma.agent.findMany({
        where: { id: { in: referencedAgentIds } },
        select: { id: true, deletedAt: true },
      })
    : [];
  const liveAgentIds = new Set(agents.filter((agent) => !agent.deletedAt).map((agent) => agent.id));
  const groups = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const key = `${session.userId}\u0000${normalizedName(displayName(session))}`;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  const duplicateGroups = [...groups.values()].filter((rows) => rows.length > 1);
  const decisions = duplicateGroups.map((rows) => {
    const ranked = [...rows].sort((a, b) => {
      const aLive = Number(Boolean((a.builtAgentId && liveAgentIds.has(a.builtAgentId)) || (a.targetAgentId && liveAgentIds.has(a.targetAgentId))));
      const bLive = Number(Boolean((b.builtAgentId && liveAgentIds.has(b.builtAgentId)) || (b.targetAgentId && liveAgentIds.has(b.targetAgentId))));
      if (aLive !== bLive) return bLive - aLive;
      const aActive = Number(a.status === 'ACTIVE');
      const bActive = Number(b.status === 'ACTIVE');
      if (aActive !== bActive) return bActive - aActive;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    return {
      userId: ranked[0]!.userId,
      name: displayName(ranked[0]!),
      keep: ranked[0]!,
      remove: ranked.slice(1),
    };
  });
  const remove = decisions.flatMap((decision) => decision.remove);

  // Never hard-delete a duplicate record that currently owns/reuses a live
  // Agent. Such a collision needs human review rather than an automated guess.
  const unsafe = remove.filter((row) =>
    (row.builtAgentId && liveAgentIds.has(row.builtAgentId)) ||
    (row.targetAgentId && liveAgentIds.has(row.targetAgentId))
  );
  if (unsafe.length) {
    throw new Error(`Refusing cleanup: ${unsafe.length} duplicate build(s) reference a live Agent: ${unsafe.map((row) => row.id).join(', ')}`);
  }

  const report = decisions.map((decision) => ({
    userId: decision.userId,
    name: decision.name,
    keptSessionId: decision.keep.id,
    keptStatus: decision.keep.status,
    removedSessionIds: decision.remove.map((row) => row.id),
  }));
  if (!apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN', duplicateGroups: report.length, removeCount: remove.length, report }, null, 2));
    return;
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.agentBuildSession.findMany({
      where: { id: { in: remove.map((row) => row.id) } },
      select: { id: true, updatedAt: true, builtAgentId: true, targetAgentId: true },
    });
    if (current.length !== remove.length) {
      throw new Error('Cleanup set changed after inspection; rerun the dry-run before applying.');
    }
    const inspected = new Map(remove.map((row) => [row.id, row.updatedAt.getTime()]));
    if (current.some((row) => inspected.get(row.id) !== row.updatedAt.getTime())) {
      throw new Error('A duplicate build changed after inspection; refusing to delete stale data.');
    }
    await tx.agentBuildSession.deleteMany({ where: { id: { in: remove.map((row) => row.id) } } });
  });

  await audit(null, 'agent_builder.duplicate_sessions_deleted', 'AgentBuildSession', decisions[0]?.keep.id ?? 'none', {
    duplicateGroups: report.length,
    removedCount: remove.length,
    keptSessionIds: decisions.map((decision) => decision.keep.id),
    removedSessionIds: remove.map((row) => row.id),
    policy: 'same owner and normalized display name; keep live-Agent/ACTIVE/newest',
  });
  console.log(JSON.stringify({ mode: 'APPLIED', duplicateGroups: report.length, removedCount: remove.length, report }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
