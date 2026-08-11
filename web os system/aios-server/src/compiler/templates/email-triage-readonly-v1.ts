// Read-only email triage template — no send/write/provider/python nodes.
// Does not import registry (avoids circular dep); capability pattern matches CAPABILITY_ID_RE.
import { z } from 'zod';
import type { TemplateDefinition } from '../registry.js';

const CAPABILITY_ID = z
  .string()
  .min(1)
  .regex(
    /^mcp:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/,
    'must be capability id mcp:<serverId>:<tool>',
  );

export const emailTriageReadonlyV1SlotSchema = z
  .object({
    readTools: z.array(CAPABILITY_ID).min(1),
    categories: z.array(z.string().min(1)).min(1),
    summaryLanguage: z.enum(['zh-TW', 'en']).default('zh-TW'),
    query: z.string().optional(),
  })
  .strict();

export type EmailTriageReadonlyV1Slots = z.infer<typeof emailTriageReadonlyV1SlotSchema>;

/**
 * Pure deterministic graph builder. Same slots → byte-stable isomorphic graph
 * (fixed node ids/order; no timestamps or randomness).
 */
export function buildEmailTriageReadonlyV1Graph(slots: EmailTriageReadonlyV1Slots): unknown {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<{ from: string; to: string }> = [];

  const inputId = 'n_input';
  nodes.push({
    id: inputId,
    kind: 'input',
    config: slots.query !== undefined ? { query: slots.query } : {},
  });

  let prevId = inputId;
  for (let i = 0; i < slots.readTools.length; i++) {
    const id = `n_read_${i}`;
    nodes.push({
      id,
      kind: 'tool.read',
      tool: slots.readTools[i],
      config: {},
    });
    edges.push({ from: prevId, to: id });
    prevId = id;
  }

  const classifyId = 'n_classify';
  nodes.push({
    id: classifyId,
    kind: 'gateway.classify',
    config: {
      categories: [...slots.categories],
    },
  });
  edges.push({ from: prevId, to: classifyId });
  prevId = classifyId;

  const summarizeId = 'n_summarize';
  nodes.push({
    id: summarizeId,
    kind: 'gateway.summarize',
    config: {
      summaryLanguage: slots.summaryLanguage,
    },
  });
  edges.push({ from: prevId, to: summarizeId });
  prevId = summarizeId;

  const verifyId = 'n_verify';
  nodes.push({
    id: verifyId,
    kind: 'gateway.verify',
    config: {},
  });
  edges.push({ from: prevId, to: verifyId });
  prevId = verifyId;

  const outputId = 'n_output';
  nodes.push({
    id: outputId,
    kind: 'output',
    config: {},
  });
  edges.push({ from: prevId, to: outputId });

  return {
    schemaVersion: 'aios.flow-graph/1',
    template: 'email-triage-readonly-v1',
    templateVersion: '1',
    nodes,
    edges,
  };
}

export const emailTriageReadonlyV1: TemplateDefinition = {
  id: 'email-triage-readonly-v1',
  version: '1',
  slotSchema: emailTriageReadonlyV1SlotSchema,
  buildGraph: (slots) => buildEmailTriageReadonlyV1Graph(slots as EmailTriageReadonlyV1Slots),
};
