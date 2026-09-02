// Fail-closed production-release gate for Agents created via Agent Builder.
//
// If an Agent was ever AgentBuildSession.builtAgentId, every session bound to
// that id must be ACTIVE and the Agent must own at least one non-deleted,
// CONFIRMED Skill. Session state + effective Skill linkage are transactional
// release authority; AuditLog remains observability rather than authorization.
// Isolated builder tests that
// pass builderTestSessionId skip this gate; compileManifest still validates
// session / actor / draft independently. Ordinary hand-created Agents that
// were never a builtAgentId are unaffected.
//
// Duplicate / corrupt sessions cannot accidentally release an Agent: every
// session that points at the Agent as builtAgentId must be ACTIVE. Lookup
// errors fail closed (treat as unreleased).

import { prisma } from './db.js';
import { errors } from './http.js';

export const BUILDER_FINALIZED_AUDIT_ACTION = 'agent_builder.finalized';
export const BUILDER_FINALIZED_AUDIT_ENTITY = 'AgentBuildSession';

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}

async function builderSessionsForAgent(agentId: string): Promise<Array<{ id: string; status: string }>> {
  return prisma.agentBuildSession.findMany({
    where: { builtAgentId: agentId },
    select: { id: true, status: true },
  });
}

async function hasConfirmedSkill(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
      skills: {
        some: {
          skill: { reviewStatus: 'CONFIRMED', deletedAt: null },
        },
      },
    },
    select: { id: true },
  });
  return Boolean(agent);
}

/** True for ordinary Agents, or complete ACTIVE Builder Agents with a confirmed Skill. */
export async function isBuilderAgentReleased(agentId: string): Promise<boolean> {
  let sessions: Array<{ id: string; status: string }>;
  try {
    sessions = await builderSessionsForAgent(agentId);
  } catch {
    return false;
  }
  if (sessions.length === 0) return true;
  if (!sessions.every((row) => row.status === 'ACTIVE')) return false;
  try {
    return await hasConfirmedSkill(agentId);
  } catch {
    return false;
  }
}

/**
 * Fail-closed gate for production runs. Isolated builderTestSessionId trials
 * are excepted here; the runner must still run compileManifest's existing
 * session/actor/draft checks and must not treat this skip as authorization.
 */
export async function assertBuilderAgentReleased(opts: {
  agentId: string;
  builderTestSessionId?: string;
}): Promise<void> {
  if (opts.builderTestSessionId) return;
  if (await isBuilderAgentReleased(opts.agentId)) return;
  throw errors.forbidden('Builder Agent is not active in its training session');
}

/**
 * Agent ids that were ever a builtAgentId but are not complete callable builds:
 * any non-ACTIVE session, or no effective CONFIRMED Skill linkage.
 *
 * Fail-closed:
 * - Session lookup error with candidates → treat every candidate as unreleased.
 * - Session lookup error without candidates → throw (caller must not assume []).
 * - Duplicate sessions: an Agent is unreleased if *any* of its builtAgentId
 *   sessions is not ACTIVE.
 */
export async function listUnreleasedBuilderAgentIds(candidateIds?: string[]): Promise<string[]> {
  const uniqueCandidates = candidateIds ? uniqueIds(candidateIds) : undefined;
  if (uniqueCandidates && uniqueCandidates.length === 0) return [];

  let withAgent: Array<{ id: string; builtAgentId: string; status: string }>;
  try {
    const sessions = await prisma.agentBuildSession.findMany({
      where: {
        builtAgentId: uniqueCandidates ? { in: uniqueCandidates } : { not: null },
      },
      select: { id: true, builtAgentId: true, status: true },
    });
    withAgent = sessions.flatMap((row) =>
      typeof row.builtAgentId === 'string'
        ? [{ id: row.id, builtAgentId: row.builtAgentId, status: row.status }]
        : [],
    );
  } catch (error) {
    if (uniqueCandidates) return uniqueCandidates;
    throw error;
  }
  if (withAgent.length === 0) return [];

  const unreleased = new Set<string>();
  const builderAgentIds = new Set<string>();
  for (const row of withAgent) {
    builderAgentIds.add(row.builtAgentId);
    if (row.status !== 'ACTIVE') unreleased.add(row.builtAgentId);
  }
  const activeCandidates = [...builderAgentIds].filter((id) => !unreleased.has(id));
  if (activeCandidates.length) {
    try {
      const completeAgents = await prisma.agent.findMany({
        where: {
          id: { in: activeCandidates },
          deletedAt: null,
          skills: {
            some: {
              skill: { reviewStatus: 'CONFIRMED', deletedAt: null },
            },
          },
        },
        select: { id: true },
      });
      const completeIds = new Set(completeAgents.map((row) => row.id));
      for (const id of activeCandidates) {
        if (!completeIds.has(id)) unreleased.add(id);
      }
    } catch (error) {
      if (uniqueCandidates) return uniqueCandidates;
      throw error;
    }
  }
  return [...unreleased];
}

/** Prisma `where` fragment that hides unreleased Builder Agents from employee lists. */
export async function excludeUnreleasedBuilderAgentsWhere(
  candidateIds?: string[],
): Promise<{ id?: { notIn: string[] } | { in: string[] } }> {
  try {
    const unreleased = await listUnreleasedBuilderAgentIds(candidateIds);
    if (unreleased.length === 0) return {};
    return { id: { notIn: unreleased } };
  } catch {
    // Cannot determine the unreleased set: hide every Agent rather than leak.
    return { id: { in: [] } };
  }
}

/** Drop unreleased Builder Agents from an already-loaded employee list. */
export async function rejectUnreleasedBuilderAgents<T extends { id: string }>(
  agents: T[],
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const blocked = new Set(await listUnreleasedBuilderAgentIds(agents.map((row) => row.id)));
  return agents.filter((row) => !blocked.has(row.id));
}
