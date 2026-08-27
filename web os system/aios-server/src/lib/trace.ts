// Post-run redacted trajectory sedimentation + conservative trajectory-dedupe proposals.
// Ancillary / fail-safe: never throws to callers; never auto-confirms or promotes skills.
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Engine, Prisma } from '@prisma/client';
import type { CompiledManifest, RunOutcome, StepResult } from '../engine/types.js';
import type { NormalizedRunEvent } from '../runtime/adapter.js';
import { redactSecrets } from '../memory/redactor.js';
import { createProposal } from './changeproposal.js';
import { prisma } from './db.js';
import { allowWrite } from './stopwrite.js';

/** Minimum successful identical trajectories before emitting one PENDING proposal. */
export const TRAJECTORY_MIN_OCCURRENCES = 3;

const SNIPPET_CAP = 500;

/** In-memory dedupe: agentId::trajectoryKey already proposed this process. */
const trajectorySeen = new Set<string>();

export type SelectedSkillTrace = {
  slug: string;
  name?: string;
  risk?: string;
};

type TraceAgent = {
  id: string;
};

export type RunTraceRuntimeMeta = {
  runtimeKind?: 'NATIVE' | 'LANGFLOW';
  artifactId?: string | null;
};

function capRedact(text: string | undefined | null): string | undefined {
  if (text == null || text === '') return undefined;
  return redactSecrets(String(text)).slice(0, SNIPPET_CAP);
}

function buildSelectedSkills(manifest: CompiledManifest): SelectedSkillTrace[] {
  return (manifest.skills ?? []).map((s) => {
    const meta = s.metadata as { name?: string; risk?: string; riskTier?: string } | undefined;
    const slug = redactSecrets(String(s.name ?? ''));
    const nameRaw = meta?.name;
    const riskRaw = meta?.risk ?? meta?.riskTier;
    const out: SelectedSkillTrace = { slug };
    if (typeof nameRaw === 'string' && nameRaw) out.name = redactSecrets(nameRaw);
    if (typeof riskRaw === 'string' && riskRaw) out.risk = redactSecrets(riskRaw);
    return out;
  });
}

function buildTrajectory(results: StepResult[]) {
  return results.map((r) => {
    const entry: Record<string, unknown> = {
      stepKey: r.stepKey,
      type: r.type,
      approved: r.approved,
      rounds: r.rounds,
    };
    const reason = capRedact(r.reason);
    if (reason !== undefined) entry.reason = reason;
    // Intentionally omit r.output (may contain raw prompts / secrets).
    return entry;
  });
}

function buildVerifierFeedback(results: StepResult[]) {
  const snippets: Array<Record<string, unknown>> = [];
  for (const r of results) {
    if (r.lastVerdict) {
      snippets.push({
        stepKey: r.stepKey,
        source: 'lastVerdict',
        text: capRedact(r.lastVerdict) ?? '',
      });
    }
    for (const rec of r.records ?? []) {
      if (rec.verdict) {
        snippets.push({
          stepKey: r.stepKey,
          round: rec.round,
          approved: rec.approved,
          text: capRedact(rec.verdict) ?? '',
        });
      }
    }
  }
  return snippets;
}

function computeTrajectoryKey(
  agentId: string,
  skillSlugs: string[],
  results: StepResult[],
): string {
  const skillsPart = skillSlugs.join(',');
  const stepsPart = results.map((r) => `${r.stepKey}|${r.type}`).join(';');
  const signature = `${agentId}|${skillsPart}|${stepsPart}`;
  return createHash('sha256').update(signature, 'utf8').digest('hex');
}

/**
 * Fail-safe post-run trace ingest. Never throws.
 * Persists a redacted RunTrace and may emit one deduped TRAJECTORY proposal.
 * Optional `runtime` writes runtimeKind/artifactId; omitted = legacy null columns.
 */
export async function ingestRunTrace(input: {
  agent: TraceAgent;
  manifest: CompiledManifest;
  outcome: RunOutcome;
  runtime?: RunTraceRuntimeMeta;
}): Promise<void> {
  if (!allowWrite('runTrace')) return;
  try {
    const { agent, manifest, outcome, runtime } = input;
    const agentId = agent.id;
    const runId = outcome.runId;
    if (!agentId || !runId) return;

    const selectedSkills = buildSelectedSkills(manifest);
    const trajectory = buildTrajectory(outcome.results ?? []);
    const verifierFeedback = buildVerifierFeedback(outcome.results ?? []);
    const succeeded = outcome.status === 'SUCCEEDED';
    const traceOutcome = succeeded ? 'SUCCEEDED' : 'FAILED';
    const skillSlugs = selectedSkills.map((s) => s.slug);
    const trajectoryKey = succeeded
      ? computeTrajectoryKey(agentId, skillSlugs, outcome.results ?? [])
      : null;

    const id = ulid();
    try {
      await prisma.runTrace.create({
        data: {
          id,
          agentId,
          runId,
          selectedSkills: selectedSkills as unknown as Prisma.InputJsonValue,
          trajectory: trajectory as unknown as Prisma.InputJsonValue,
          verifierFeedback: verifierFeedback as unknown as Prisma.InputJsonValue,
          outcome: traceOutcome,
          trajectoryKey,
          engineExecute: manifest.engineExecute,
          engineVerify: manifest.engineVerify,
          ...(runtime?.runtimeKind != null
            ? { runtimeKind: runtime.runtimeKind }
            : {}),
          ...(runtime && 'artifactId' in runtime
            ? { artifactId: runtime.artifactId ?? null }
            : {}),
        },
      });
    } catch (e: unknown) {
      // Unique on runId — treat as no-op (idempotent re-ingest).
      const code =
        e && typeof e === 'object' && 'code' in e
          ? String((e as { code: unknown }).code)
          : '';
      if (code !== 'P2002') {
        console.warn(
          '[trace] runTrace create failed',
          e instanceof Error ? e.message : e,
        );
        return;
      }
    }

    if (trajectoryKey) {
      await maybeProposeTrajectoryDedupe(agentId, trajectoryKey);
    }
  } catch (e) {
    console.warn(
      '[trace] ingestRunTrace failed (non-fatal)',
      e instanceof Error ? e.message : e,
    );
  }
}

function mapPilotEventsToTrajectory(events: NormalizedRunEvent[]): Array<Record<string, unknown>> {
  return events.map((ev) => {
    const entry: Record<string, unknown> = {
      type: ev.type,
      at: 'at' in ev ? ev.at : undefined,
    };
    if ('stepKey' in ev && typeof ev.stepKey === 'string') {
      entry.stepKey = ev.stepKey;
    }
    if ('ok' in ev && typeof ev.ok === 'boolean') {
      entry.ok = ev.ok;
    }
    if (ev.type === 'step.finished' && ev.summary != null) {
      const summary = capRedact(ev.summary);
      if (summary !== undefined) entry.summary = summary;
    }
    if (ev.type === 'run.error') {
      const message = capRedact(ev.message);
      if (message !== undefined) entry.message = message;
      entry.code = ev.code;
    }
    if (ev.type === 'approval.required') {
      const reason = capRedact(ev.reason);
      if (reason !== undefined) entry.reason = reason;
    }
    if (ev.type === 'tool.call') {
      entry.tool = redactSecrets(String(ev.tool)).slice(0, SNIPPET_CAP);
    }
    if (ev.type === 'run.finished') {
      entry.status = ev.status;
    }
    return entry;
  });
}

/**
 * Fail-safe Langflow pilot RunTrace ingest. Never throws.
 * AWAITING_REVIEW → no-op (run not finished). trajectoryKey always null
 * (do not trigger trajectory-dedupe proposals). P2002 on runId → silent no-op.
 */
export async function ingestPilotRunTrace(input: {
  runId: string;
  agentId: string;
  artifactId: string | null | undefined;
  engineExecute: Engine;
  engineVerify: Engine;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'AWAITING_REVIEW';
  events: NormalizedRunEvent[];
}): Promise<void> {
  if (!allowWrite('runTrace')) return;
  try {
    const { runId, agentId, artifactId, engineExecute, engineVerify, status, events } =
      input;
    if (!runId || !agentId) return;
    if (status === 'AWAITING_REVIEW') return;

    const trajectory = mapPilotEventsToTrajectory(events ?? []);
    const traceOutcome = status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';

    // Idempotent: existing row for runId → silent no-op (also covers P2002).
    const existing = await prisma.runTrace.findUnique({
      where: { runId },
      select: { id: true },
    });
    if (existing) return;

    const id = ulid();
    try {
      await prisma.runTrace.create({
        data: {
          id,
          agentId,
          runId,
          selectedSkills: [] as unknown as Prisma.InputJsonValue,
          trajectory: trajectory as unknown as Prisma.InputJsonValue,
          verifierFeedback: [] as unknown as Prisma.InputJsonValue,
          outcome: traceOutcome,
          trajectoryKey: null,
          engineExecute,
          engineVerify,
          runtimeKind: 'LANGFLOW',
          artifactId: artifactId ?? null,
        },
      });
    } catch (e: unknown) {
      const code =
        e && typeof e === 'object' && 'code' in e
          ? String((e as { code: unknown }).code)
          : '';
      if (code !== 'P2002') {
        console.warn(
          '[trace] ingestPilotRunTrace create failed',
          e instanceof Error ? e.message : e,
        );
      }
      // P2002 → silent no-op (idempotent race)
    }
  } catch (e) {
    console.warn(
      '[trace] ingestPilotRunTrace failed (non-fatal)',
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Conservative + deduped TRAJECTORY proposal when the same successful path
 * repeats ≥ TRAJECTORY_MIN_OCCURRENCES. Skip when no CONFIRMED skill is linked.
 * Fail-safe: never throws.
 */
export async function maybeProposeTrajectoryDedupe(
  agentId: string,
  trajectoryKey: string,
): Promise<void> {
  try {
    if (!agentId || !trajectoryKey) return;

    const memKey = `${agentId}::${trajectoryKey}`;
    if (trajectorySeen.has(memKey)) return;

    const count = await prisma.runTrace.count({
      where: {
        agentId,
        trajectoryKey,
        outcome: 'SUCCEEDED',
      },
    });
    if (count < TRAJECTORY_MIN_OCCURRENCES) return;

    const pending = await prisma.changeProposal.findMany({
      where: {
        agentId,
        source: 'TRAJECTORY',
        status: 'PENDING',
      },
    });
    for (const p of pending) {
      const change = p.proposedChange as { trajectoryKey?: string } | null;
      if (change && change.trajectoryKey === trajectoryKey) {
        trajectorySeen.add(memKey);
        return;
      }
    }

    // Prefer first CONFIRMED skill mounted on this agent; skip if none.
    const link = await prisma.agentSkill.findFirst({
      where: {
        agentId,
        skill: {
          reviewStatus: 'CONFIRMED',
          deletedAt: null,
        },
      },
      include: {
        skill: {
          select: {
            id: true,
            stableVersionId: true,
            canaryVersionId: true,
          },
        },
      },
      orderBy: { skillId: 'asc' },
    });
    if (!link?.skill) return;

    const skill = link.skill;
    const skillVersionId = skill.stableVersionId ?? skill.canaryVersionId ?? null;

    let evalCaseId: string | null = null;
    try {
      const suite = await prisma.evalSuite.findFirst({
        where: { skillId: skill.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (suite) {
        const ec = await prisma.evalCase.findFirst({
          where: { suiteId: suite.id },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        evalCaseId = ec?.id ?? null;
      }
    } catch {
      evalCaseId = null;
    }

    await createProposal({
      agentId,
      source: 'TRAJECTORY',
      proposedBy: 'system',
      targetType: 'SKILL',
      targetId: skill.id,
      proposedChange: {
        kind: 'trajectory_dedupe',
        trajectoryKey,
        rationale: '重複成功軌跡偵測，建議整併/去重技能',
        occurrences: count,
        skillVersionId,
        evalCaseId,
      },
      severity: 'low',
      confidence: 0.5,
    });

    trajectorySeen.add(memKey);
  } catch (e) {
    console.warn(
      '[trace] maybeProposeTrajectoryDedupe failed (non-fatal)',
      e instanceof Error ? e.message : e,
    );
  }
}
