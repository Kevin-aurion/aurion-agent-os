import type { Agent, Prisma } from '@prisma/client';
import type { AccessClaims } from './auth.js';
import { prisma } from './db.js';
import { errors } from './http.js';

/** FDE accounts may administer every customer's Agent; MEMBER access is owner-only. */
export function isFdeClaims(claims: Pick<AccessClaims, 'role'>): boolean {
  return claims.role === 'OWNER' || claims.role === 'TRAINER';
}

/**
 * Server-side visibility predicate for Agent-backed customer data.
 * Keep this in the query itself so a foreign Agent id is indistinguishable
 * from a missing id (404, fail-closed).
 */
export function visibleAgentWhere(
  claims: Pick<AccessClaims, 'sub' | 'role'>,
): Prisma.AgentWhereInput {
  return isFdeClaims(claims)
    ? {}
    : {
        createdBy: claims.sub,
        systemManaged: false,
      };
}

export async function requireVisibleAgent(
  agentId: string,
  claims: Pick<AccessClaims, 'sub' | 'role'>,
): Promise<Agent> {
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: null,
      ...visibleAgentWhere(claims),
    },
  });
  if (!agent) throw errors.notFound('Agent not found');
  return agent;
}

export async function requireVisibleWorkflow(
  workflowId: string,
  claims: Pick<AccessClaims, 'sub' | 'role'>,
) {
  const workflow = await prisma.workflow.findFirst({
    where: {
      id: workflowId,
      deletedAt: null,
      agent: { is: { deletedAt: null, ...visibleAgentWhere(claims) } },
    },
  });
  if (!workflow) throw errors.notFound('Workflow not found');
  return workflow;
}

export async function requireVisibleRun(
  runId: string,
  claims: Pick<AccessClaims, 'sub' | 'role'>,
) {
  const run = await prisma.run.findFirst({
    where: {
      id: runId,
      agent: { is: { deletedAt: null, ...visibleAgentWhere(claims) } },
    },
  });
  if (!run) throw errors.notFound('Run not found');
  return run;
}
