// Scheduled report template — single-fire report Run content only.
// Schedule ownership stays with AIOS (BullMQ/Temporal); no scheduler/cron/timer nodes.
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

/** Deterministic IANA timezone check via Intl (no new deps). */
function isValidIanaTimezone(tz: string): boolean {
  try {
    // Invalid timeZone throws RangeError
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const scheduleRefSchema = z
  .object({
    scheduleId: z.string().min(1),
    timezone: z
      .string()
      .min(1)
      .refine(isValidIanaTimezone, {
        message: 'timezone must be a valid IANA timezone',
      }),
    /** Opaque metadata only — AIOS Schedule owns actual scheduling; never becomes a graph node. */
    cron: z.string().min(1).optional(),
  })
  .strict();

export const scheduledReportV1SlotSchema = z
  .object({
    scheduleRef: scheduleRefSchema,
    reportTitle: z.string().min(1),
    readTools: z.array(CAPABILITY_ID).min(1),
    rubric: z.array(z.string().min(1)).min(1),
    summaryLanguage: z.enum(['zh-TW', 'en']).default('zh-TW'),
  })
  .strict();

export type ScheduledReportV1Slots = z.infer<typeof scheduledReportV1SlotSchema>;

/**
 * Pure deterministic graph builder. Same slots → byte-stable isomorphic graph
 * (fixed node ids/order; no timestamps or randomness).
 * Schedule is metadata only — Flow has no second scheduler.
 */
export function buildScheduledReportV1Graph(slots: ScheduledReportV1Slots): unknown {
  const { scheduleId, timezone, cron } = slots.scheduleRef;

  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<{ from: string; to: string }> = [];

  const inputId = 'n_input';
  nodes.push({
    id: inputId,
    kind: 'input',
    config: { scheduleId },
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

  const summarizeId = 'n_summarize';
  nodes.push({
    id: summarizeId,
    kind: 'gateway.summarize',
    config: {
      reportTitle: slots.reportTitle,
      summaryLanguage: slots.summaryLanguage,
      timezone,
    },
  });
  edges.push({ from: prevId, to: summarizeId });
  prevId = summarizeId;

  const verifyId = 'n_verify';
  nodes.push({
    id: verifyId,
    kind: 'gateway.verify',
    config: {
      rubric: [...slots.rubric],
    },
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

  const scheduleRef: Record<string, unknown> = {
    scheduleId,
    timezone,
    ownedBy: 'AIOS',
  };
  if (cron !== undefined) {
    scheduleRef.cron = cron;
  }

  return {
    schemaVersion: 'aios.flow-graph/1',
    template: 'scheduled-report-v1',
    templateVersion: '1',
    scheduleRef,
    trigger: {
      source: 'aios-schedule',
      scheduleId,
      // Template string with placeholder — not a concrete fire time (duplicate trigger contract).
      idempotencyKeyTemplate: `schedule:${scheduleId}:{scheduledFireAtIso}`,
    },
    nodes,
    edges,
  };
}

export const scheduledReportV1: TemplateDefinition = {
  id: 'scheduled-report-v1',
  version: '1',
  slotSchema: scheduledReportV1SlotSchema,
  buildGraph: (slots) => buildScheduledReportV1Graph(slots as ScheduledReportV1Slots),
};
