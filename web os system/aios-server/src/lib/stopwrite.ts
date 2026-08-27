// Stage-1 S1-6 stop-write: freeze idle clusters (no schema drop).
// HTTP write endpoints return 501; internal writers honour env flags (default off).
// Read paths stay intact. Re-enable a cluster with `<FLAG>=true`.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './http.js';

export const STAGE1_STOP_WRITE_ERROR = 'stage1-stop-write';
export const STAGE1_STOP_WRITE_HINT = '見 docs/specs/stage1-convergence.md';

export const STAGE1_STOP_WRITE_BODY = {
  error: STAGE1_STOP_WRITE_ERROR,
  hint: STAGE1_STOP_WRITE_HINT,
} as const;

export type StopWriteCluster =
  | 'langflowRuntime'
  | 'a2a'
  | 'reflection'
  | 'recording'
  | 'eval'
  | 'runTrace';

export const STOP_WRITE_ENV: Record<StopWriteCluster, string> = {
  langflowRuntime: 'AIOS_LANGFLOW_RUNTIME_WRITES',
  a2a: 'AIOS_A2A_WRITES',
  reflection: 'AIOS_REFLECTION_ENABLED',
  recording: 'AIOS_RECORDING_WRITES',
  eval: 'AIOS_EVAL_WRITES',
  runTrace: 'AIOS_RUNTRACE_WRITES',
};

/** HTTP write endpoints frozen in S1-6. Read/GET siblings are intentionally absent. */
export const STOP_WRITE_HTTP_ROUTES: ReadonlyArray<{
  cluster: StopWriteCluster;
  method: 'POST' | 'PATCH' | 'DELETE';
  url: string;
}> = [
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/graph/artifacts' },
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/graph/artifacts/s16-dummy/compile/langflow' },
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/runtime/artifacts/s16-dummy/validate' },
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/runtime/deployments' },
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/runtime/deployments/s16-dummy/rollback' },
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/runtime/deployments/s16-dummy/deactivate' },
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/runtime/dead-letters/s16-dummy/replay' },
  { cluster: 'langflowRuntime', method: 'POST', url: '/api/runtime/dead-letters/s16-dummy/discard' },
  { cluster: 'a2a', method: 'POST', url: '/api/a2a/peers' },
  { cluster: 'a2a', method: 'PATCH', url: '/api/a2a/peers/s16-dummy/enabled' },
  { cluster: 'a2a', method: 'DELETE', url: '/api/a2a/peers/s16-dummy' },
  { cluster: 'a2a', method: 'POST', url: '/api/a2a/tasks' },
  { cluster: 'a2a', method: 'POST', url: '/api/a2a/tasks/s16-dummy/cancel' },
  { cluster: 'reflection', method: 'POST', url: '/api/reflections/run' },
  { cluster: 'reflection', method: 'POST', url: '/api/reflection-suggestions/s16-dummy/propose' },
  { cluster: 'reflection', method: 'POST', url: '/api/reflection-suggestions/s16-dummy/dismiss' },
  { cluster: 'recording', method: 'POST', url: '/api/recording/start' },
  { cluster: 'recording', method: 'POST', url: '/api/recording/stop' },
  { cluster: 'recording', method: 'POST', url: '/api/agents/s16-dummy/recording/to-skill' },
  { cluster: 'eval', method: 'POST', url: '/api/skills/s16-dummy/eval-suites' },
  { cluster: 'eval', method: 'POST', url: '/api/eval-suites/s16-dummy/cases' },
  { cluster: 'eval', method: 'POST', url: '/api/eval-suites/s16-dummy/run' },
];

const warned = new Set<string>();

function envFlagOn(name: string): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/** Live env read (not frozen at import) so tests can toggle flags. */
export function writesEnabled(cluster: StopWriteCluster): boolean {
  return envFlagOn(STOP_WRITE_ENV[cluster]);
}

/** Fail-safe writers: skip the write after a one-time console.info. */
export function allowWrite(cluster: StopWriteCluster): boolean {
  if (writesEnabled(cluster)) return true;
  const flag = STOP_WRITE_ENV[cluster];
  if (!warned.has(flag)) {
    warned.add(flag);
    console.info(
      `[stage1-stop-write] ${cluster} writes disabled (set ${flag}=true to re-enable). ${STAGE1_STOP_WRITE_HINT}`,
    );
  }
  return false;
}

export function stage1StopWriteError(): ApiError {
  return new ApiError(501, STAGE1_STOP_WRITE_ERROR, STAGE1_STOP_WRITE_HINT);
}

/** Fail-closed writers: throw 501 so callers cannot treat the write as success. */
export function assertWriteEnabled(cluster: StopWriteCluster): void {
  if (!allowWrite(cluster)) throw stage1StopWriteError();
}

export function sendStopWrite(reply: FastifyReply) {
  return reply.code(501).send({ ...STAGE1_STOP_WRITE_BODY });
}

/** Route preHandler: 501 unless the cluster env flag is on. Auth still runs first. */
export function stopWriteGuard(cluster: StopWriteCluster) {
  return async function stopWriteGuardHandler(_req: FastifyRequest, reply: FastifyReply) {
    if (writesEnabled(cluster)) return;
    allowWrite(cluster);
    return sendStopWrite(reply);
  };
}

export function resetStopWriteWarningsForTest(): void {
  warned.clear();
}
