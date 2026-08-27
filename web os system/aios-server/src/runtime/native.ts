// Native Runtime Adapter — thin facade over existing runAgent (no governance reimplementation).
import { ulid } from 'ulid';
import { isRunApproved as defaultIsRunApproved } from '../lib/approval.js';
import { prisma } from '../lib/db.js';
import { runAgent as defaultRunAgent } from '../engine/runner.js';
import type { RunAgentOptions, RunOutcome } from '../engine/types.js';
import { redactSecrets } from '../memory/redactor.js';
import {
  assertDigestMatches,
  computeArtifactDigest,
  nowIso,
  RuntimeAdapterError,
  type DeployArtifactRequest,
  type ExecuteRequest,
  type NormalizedRunEvent,
  type ResumeRequest,
  type RuntimeAdapter,
  type RuntimeBinding,
  type RuntimeHealth,
  type RuntimeRunState,
  type ValidateArtifactRequest,
  type ValidationResult,
} from './adapter.js';

const HEALTH_TIMEOUT_MS = 5000;
const AWAITING_REVIEW_REASON =
  'Run requires human approval before continuing';

export interface NativeAdapterDeps {
  runAgent?: (opts: RunAgentOptions) => Promise<RunOutcome>;
  db?: {
    run: {
      findUnique: (args: { where: { id: string } }) => Promise<{
        id: string;
        agentId: string;
        status: string;
        startedAt: Date | string | null;
        finishedAt: Date | string | null;
      } | null>;
      update: (args: {
        where: { id: string };
        data: { status: string; finishedAt: Date };
      }) => Promise<unknown>;
    };
    $queryRaw: (...args: unknown[]) => Promise<unknown>;
  };
  isRunApproved?: (
    runId: string,
    approvalId?: string | null,
  ) => Promise<boolean>;
}

type DbLike = NonNullable<NativeAdapterDeps['db']>;

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

function mapFinishedStatus(
  status: string,
): 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'AWAITING_REVIEW' {
  if (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'AWAITING_REVIEW'
  ) {
    return status;
  }
  return 'FAILED';
}

function mapRunStateStatus(
  status: string,
): RuntimeRunState['status'] {
  if (
    status === 'RUNNING' ||
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'AWAITING_REVIEW'
  ) {
    return status;
  }
  return 'FAILED';
}

export class NativeAdapter implements RuntimeAdapter {
  readonly kind = 'NATIVE' as const;

  private readonly runAgentFn: (opts: RunAgentOptions) => Promise<RunOutcome>;
  private readonly db: DbLike;
  private readonly isRunApprovedFn: (
    runId: string,
    approvalId?: string | null,
  ) => Promise<boolean>;

  constructor(deps?: NativeAdapterDeps) {
    this.runAgentFn = deps?.runAgent ?? defaultRunAgent;
    this.db = deps?.db ?? (prisma as unknown as DbLike);
    this.isRunApprovedFn = deps?.isRunApproved ?? defaultIsRunApproved;
  }

  async health(): Promise<RuntimeHealth> {
    const checkedAt = nowIso();
    const t0 = Date.now();
    try {
      await Promise.race([
        this.db.$queryRaw`SELECT 1`,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('health query timeout')), HEALTH_TIMEOUT_MS);
        }),
      ]);
      return {
        kind: 'NATIVE',
        healthy: true,
        checkedAt,
        latencyMs: Date.now() - t0,
        detail: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'NATIVE',
        healthy: false,
        checkedAt,
        latencyMs: null,
        detail: redactSecrets(msg),
      };
    }
  }

  async validateArtifact(input: ValidateArtifactRequest): Promise<ValidationResult> {
    const actual = computeArtifactDigest(input.artifactJson);
    if (actual !== input.digest) {
      return { valid: false, errors: ['digest mismatch'] };
    }
    return { valid: true, errors: [] };
  }

  async deployArtifact(input: DeployArtifactRequest): Promise<RuntimeBinding> {
    assertDigestMatches(input.artifactJson, input.digest);
    return {
      kind: 'NATIVE',
      bindingRef: `native:${input.artifactId}`,
      deployedAt: nowIso(),
    };
  }

  async *execute(input: ExecuteRequest): AsyncIterable<NormalizedRunEvent> {
    const runId = input.runId ?? ulid();
    yield { type: 'run.started', runId, at: nowIso() };

    try {
      const outcome = await this.runAgentFn({
        agentId: input.agentId,
        workflowId: input.workflowId,
        input: input.input,
        triggeredBy: input.triggeredBy,
        runId,
      });

      if (outcome.status === 'AWAITING_REVIEW') {
        yield {
          type: 'approval.required',
          runId,
          at: nowIso(),
          reason: AWAITING_REVIEW_REASON,
        };
        yield {
          type: 'run.finished',
          runId,
          at: nowIso(),
          status: 'AWAITING_REVIEW',
        };
        return;
      }

      yield {
        type: 'run.finished',
        runId,
        at: nowIso(),
        status: mapFinishedStatus(outcome.status),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: 'run.error',
        runId,
        at: nowIso(),
        code: 'INTERNAL',
        message: redactSecrets(msg),
      };
    }
  }

  async getRun(runId: string): Promise<RuntimeRunState> {
    const run = await this.db.run.findUnique({ where: { id: runId } });
    if (!run) {
      throw new RuntimeAdapterError('NOT_FOUND', `run not found: ${runId}`);
    }
    return {
      runId: run.id,
      kind: 'NATIVE',
      status: mapRunStateStatus(run.status),
      startedAt: toIsoOrNull(run.startedAt),
      finishedAt: toIsoOrNull(run.finishedAt),
    };
  }

  async cancelRun(runId: string): Promise<void> {
    const run = await this.db.run.findUnique({ where: { id: runId } });
    if (!run) {
      throw new RuntimeAdapterError('NOT_FOUND', `run not found: ${runId}`);
    }
    if (run.status !== 'RUNNING') {
      return;
    }
    await this.db.run.update({
      where: { id: runId },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }

  async resumeRun(input: ResumeRequest): Promise<void> {
    const approved = await this.isRunApprovedFn(
      input.runId,
      input.approvalRequestId,
    );
    if (!approved) {
      throw new RuntimeAdapterError(
        'NOT_APPROVED',
        `run ${input.runId} is not approved for resume`,
      );
    }

    const run = await this.db.run.findUnique({ where: { id: input.runId } });
    if (!run) {
      throw new RuntimeAdapterError('NOT_FOUND', `run not found: ${input.runId}`);
    }

    await this.runAgentFn({
      agentId: run.agentId,
      input: {},
      triggeredBy: 'runtime-adapter-resume',
      runId: input.runId,
      approvedApprovalId: input.approvalRequestId,
    });
  }
}
