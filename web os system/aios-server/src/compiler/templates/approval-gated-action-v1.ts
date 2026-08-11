// Approval-gated single-write action template.
// Write is always preceded by an AIOS approval.checkpoint; Langflow has no authority.
// Does not import registry values (avoids circular dep); capability pattern matches CAPABILITY_ID_RE.
import { z } from 'zod';
import type { TemplateDefinition } from '../registry.js';

const CAPABILITY_ID = z
  .string()
  .min(1)
  .regex(
    /^mcp:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/,
    'must be capability id mcp:<serverId>:<tool>',
  );

/** The ONLY write capabilities this template may emit. */
export const APPROVAL_GATED_WRITE_ALLOWLIST: readonly string[] = [
  'mcp:gmail:gmail_send_reply',
  'mcp:line:line_push_message',
];

const approvalSchema = z
  .object({
    reason: z.string().min(1),
    risk: z.enum(['medium', 'high']),
  })
  .strict();

export const approvalGatedActionV1SlotSchema = z
  .object({
    approval: approvalSchema,
    taskDescription: z.string().min(1),
    readTools: z.array(CAPABILITY_ID).min(1),
    writeTool: CAPABILITY_ID.refine((t) => APPROVAL_GATED_WRITE_ALLOWLIST.includes(t), {
      message: 'writeTool must be in APPROVAL_GATED_WRITE_ALLOWLIST',
    }),
  })
  .strict();

export type ApprovalGatedActionV1Slots = z.infer<typeof approvalGatedActionV1SlotSchema>;

/**
 * Pure deterministic graph builder. Same slots → byte-stable isomorphic graph
 * (fixed node ids/order; no timestamps or randomness).
 */
export function buildApprovalGatedActionV1Graph(slots: ApprovalGatedActionV1Slots): unknown {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<{ from: string; to: string }> = [];

  const inputId = 'n_input';
  nodes.push({
    id: inputId,
    kind: 'input',
    config: { taskDescription: slots.taskDescription },
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

  const checkpointId = 'n_checkpoint';
  nodes.push({
    id: checkpointId,
    kind: 'approval.checkpoint',
    config: {
      reason: slots.approval.reason,
      risk: slots.approval.risk,
      authority: 'AIOS',
      emits: 'approval.required',
      resumeRequires: 'aios.approvalRequest.APPROVED',
    },
  });
  edges.push({ from: prevId, to: checkpointId });
  prevId = checkpointId;

  const actionId = 'n_action';
  nodes.push({
    id: actionId,
    kind: 'tool.gated',
    tool: slots.writeTool,
    config: {},
  });
  edges.push({ from: prevId, to: actionId });
  prevId = actionId;

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
    template: 'approval-gated-action-v1',
    templateVersion: '1',
    nodes,
    edges,
  };
}

export const approvalGatedActionV1: TemplateDefinition = {
  id: 'approval-gated-action-v1',
  version: '1',
  slotSchema: approvalGatedActionV1SlotSchema,
  buildGraph: (slots) =>
    buildApprovalGatedActionV1Graph(slots as ApprovalGatedActionV1Slots),
};
