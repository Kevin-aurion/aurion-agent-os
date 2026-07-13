// Keyword-trigger matching for workflows: given inbound text (a chat message,
// a LINE message, ...), find enabled workflows whose trigger is
// {type:'keyword', keywords:[...]} and at least one keyword appears in the
// text (case-insensitive substring match), then fire them via the Layer-2
// runner. This module owns only the *matching + fan-out* — execution itself
// stays entirely in src/workflow/runner.ts -> src/engine.
import { prisma } from '../lib/db.js';
import { hub } from '../ws/hub.js';
import type { RunOutcome } from '../engine/index.js';

interface KeywordTrigger {
  type: 'keyword';
  keywords: string[];
}

function isKeywordTrigger(trigger: unknown): trigger is KeywordTrigger {
  if (!trigger || typeof trigger !== 'object') return false;
  const t = trigger as Record<string, unknown>;
  return t.type === 'keyword' && Array.isArray(t.keywords);
}

/**
 * Find enabled, non-deleted workflows (optionally scoped to one agent) whose
 * trigger is {type:'keyword', keywords:[...]} and at least one keyword
 * appears in `text` (case-insensitive substring match).
 */
export async function findKeywordWorkflows(
  text: string,
  agentId?: string,
): Promise<Array<{ id: string; agentId: string; name: string; trigger: unknown }>> {
  const workflows = await prisma.workflow.findMany({
    where: {
      deletedAt: null,
      enabled: true,
      ...(agentId ? { agentId } : {}),
    },
  });

  const haystack = text.toLowerCase();
  return workflows.filter((wf) => {
    const trigger = wf.trigger as unknown;
    if (!isKeywordTrigger(trigger)) return false;
    return trigger.keywords.some(
      (kw) => typeof kw === 'string' && kw.trim() !== '' && haystack.includes(kw.toLowerCase()),
    );
  });
}

export interface FireKeywordWorkflowsOptions {
  agentId?: string;
  source: string;
  /** optional: invoked per fired workflow once its run settles (fulfilled or rejected). */
  onDone?: (workflowId: string, outcome: RunOutcome | null, error: unknown | null) => void;
}

export interface FiredWorkflow {
  workflowId: string;
  runId: string | null;
}

/**
 * Find keyword-triggered workflows matching `text` and fire them all
 * concurrently (never serially — each is independent). Publishes
 * 'workflow.triggered' per fire and returns the run id for each (or null if
 * the fire itself threw before a run could start).
 */
export async function fireKeywordWorkflows(
  text: string,
  opts: FireKeywordWorkflowsOptions,
): Promise<FiredWorkflow[]> {
  const matches = await findKeywordWorkflows(text, opts.agentId);
  if (matches.length === 0) return [];

  const { runWorkflow } = await import('../workflow/runner.js');

  return Promise.all(
    matches.map(async (wf): Promise<FiredWorkflow> => {
      hub.publish('workflow.triggered', { workflowId: wf.id, source: opts.source });
      try {
        const outcome = await runWorkflow(wf.id, { message: text, source: opts.source }, `trigger:${opts.source}`);
        opts.onDone?.(wf.id, outcome, null);
        return { workflowId: wf.id, runId: outcome.runId };
      } catch (e) {
        opts.onDone?.(wf.id, null, e);
        return { workflowId: wf.id, runId: null };
      }
    }),
  );
}
