// Internal Agent Card projection — whitelist fields only.
// Never exposes rolePrompt, restrictions, memory, credentials, or skill bodies.
import { errors } from './http.js';
import { prisma } from './db.js';
import { parseIdentityCard } from './identitycard.js';
import { redactSecrets } from '../memory/redactor.js';

export interface AgentCard {
  id: string;
  slug: string;
  name: string;
  description: string;
  oneLiner?: string;
  supportedTasks: string[];
  inputModes: string[];
  outputModes: string[];
  riskTier: string;
  availability: string;
}

/**
 * Project a public-safe Agent Card from DB state.
 * Whitelist only; every free-text field is redacted before return.
 */
export async function projectAgentCard(agentId: string): Promise<AgentCard> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    include: {
      skills: {
        where: {
          skill: {
            reviewStatus: 'CONFIRMED',
            deletedAt: null,
          },
        },
        include: {
          skill: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
      },
    },
  });
  if (!agent) throw errors.notFound('agent not found');

  const supportedTasks: string[] = [];
  for (const link of agent.skills) {
    const label = link.skill.name || link.skill.slug;
    if (label) supportedTasks.push(redactSecrets(label));
  }

  let oneLiner: string | undefined;
  try {
    const { card } = parseIdentityCard(agent.identityCard);
    if (card.oneLiner) oneLiner = redactSecrets(card.oneLiner);
    for (const item of card.canDo ?? []) {
      if (typeof item === 'string' && item.trim()) {
        const r = redactSecrets(item.trim());
        if (r && !supportedTasks.includes(r)) supportedTasks.push(r);
      }
    }
  } catch {
    // identity card parse is defensive — ignore failures
  }

  const card: AgentCard = {
    id: agent.id,
    slug: agent.slug,
    name: redactSecrets(agent.name),
    description: redactSecrets(agent.description ?? ''),
    supportedTasks,
    inputModes: ['text'],
    outputModes: ['text'],
    riskTier: agent.riskTier || 'medium',
    availability: agent.status === 'ACTIVE' ? 'available' : 'unavailable',
  };
  if (oneLiner) card.oneLiner = oneLiner;
  return card;
}
