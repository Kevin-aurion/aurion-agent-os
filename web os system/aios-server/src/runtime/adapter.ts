// Runtime Adapter contract: normalized types, errors, and pure helpers.
// Runtime ≠ Engine — LANGFLOW is a RuntimeKind only, never an Engine enum value.
import { createHash } from 'node:crypto';
import { redactSecrets } from '../memory/redactor.js';

export type RuntimeKind = 'NATIVE' | 'LANGFLOW';

export type RuntimeErrorCode =
  | 'RUNTIME_UNREACHABLE'
  | 'TIMEOUT'
  | 'VALIDATION_FAILED'
  | 'NOT_SUPPORTED'
  | 'NOT_APPROVED'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'INTERNAL';

export class RuntimeAdapterError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(redactSecrets(message));
    this.name = 'RuntimeAdapterError';
    this.code = code;
  }
}

export interface RuntimeHealth {
  kind: RuntimeKind;
  healthy: boolean;
  checkedAt: string;
  latencyMs: number | null;
  detail: string | null;
}

export interface ValidateArtifactRequest {
  artifactId: string;
  artifactJson: unknown;
  digest: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface DeployArtifactRequest {
  artifactId: string;
  artifactJson: unknown;
  digest: string;
  environment: 'SANDBOX' | 'STAGING' | 'PRODUCTION';
  channel: 'CANARY' | 'STABLE';
}

export interface RuntimeBinding {
  kind: RuntimeKind;
  bindingRef: string;
  deployedAt: string;
}

export interface ExecuteRequest {
  runId?: string;
  agentId: string;
  workflowId?: string;
  artifactId?: string;
  input: Record<string, unknown>;
  triggeredBy: string;
  timeoutMs?: number;
}

export type NormalizedRunEvent =
  | { type: 'run.started'; runId: string; at: string }
  | { type: 'step.started'; runId: string; stepKey: string; at: string }
  | {
      type: 'step.finished';
      runId: string;
      stepKey: string;
      ok: boolean;
      at: string;
      summary?: string;
    }
  | { type: 'tool.call'; runId: string; tool: string; at: string }
  | {
      type: 'approval.required';
      runId: string;
      at: string;
      reason: string;
      approvalRequestId?: string;
    }
  | {
      /** Bounded, deep-redacted, JSON-safe normalized output (never raw Langflow wire). */
      type: 'run.output';
      runId: string;
      at: string;
      output: Record<string, unknown>;
    }
  | {
      type: 'run.finished';
      runId: string;
      at: string;
      status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'AWAITING_REVIEW';
    }
  | {
      type: 'run.error';
      runId: string;
      at: string;
      code: RuntimeErrorCode;
      message: string;
    };

export interface RuntimeRunState {
  runId: string;
  kind: RuntimeKind;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'AWAITING_REVIEW';
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ResumeRequest {
  runId: string;
  approvalRequestId: string;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  health(): Promise<RuntimeHealth>;
  validateArtifact(input: ValidateArtifactRequest): Promise<ValidationResult>;
  deployArtifact(input: DeployArtifactRequest): Promise<RuntimeBinding>;
  execute(input: ExecuteRequest): AsyncIterable<NormalizedRunEvent>;
  getRun(runId: string): Promise<RuntimeRunState>;
  cancelRun(runId: string): Promise<void>;
  resumeRun(input: ResumeRequest): Promise<void>;
}

const ERROR_CODES = new Set<RuntimeErrorCode>([
  'RUNTIME_UNREACHABLE',
  'TIMEOUT',
  'VALIDATION_FAILED',
  'NOT_SUPPORTED',
  'NOT_APPROVED',
  'NOT_FOUND',
  'CANCELLED',
  'INTERNAL',
]);

const FINISHED_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'AWAITING_REVIEW',
] as const);

/** Recursive key-sorted JSON for deterministic digests. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/** SHA-256 hex of canonical JSON (object keys sorted recursively). Deterministic. */
export function computeArtifactDigest(artifactJson: unknown): string {
  const canonical = JSON.stringify(canonicalize(artifactJson));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Fail-closed digest check; throws RuntimeAdapterError VALIDATION_FAILED on mismatch. */
export function assertDigestMatches(artifactJson: unknown, digest: string): void {
  const actual = computeArtifactDigest(artifactJson);
  if (actual !== digest) {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      `artifact digest mismatch: expected ${digest}, got ${actual}`,
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isIsoLikeString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Bounds for run.output (and any injected-adapter output) before DB/trace. */
const RUN_OUTPUT_MAX_DEPTH = 8;
const RUN_OUTPUT_MAX_NODES = 200;
const RUN_OUTPUT_MAX_ARRAY = 50;
const RUN_OUTPUT_MAX_KEYS = 40;
const RUN_OUTPUT_MAX_STRING = 4_000;
const RUN_OUTPUT_MAX_JSON_CHARS = 32_000;

/**
 * Deterministic, cycle-safe, bounded JSON-object guard.
 * Rejects cycles, non-JSON types, oversize depth/nodes/arrays/keys/strings,
 * and oversize JSON.stringify result. Used so hostile injected adapters cannot
 * pass unbounded data into DB/trace via run.output.
 */
export function isBoundedJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const state = { nodes: 0 };
  if (!walkBoundedJson(value, 0, state, new WeakSet<object>())) return false;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return false;
    if (serialized.length > RUN_OUTPUT_MAX_JSON_CHARS) return false;
  } catch {
    // Cycles / BigInt / etc.
    return false;
  }
  return true;
}

function walkBoundedJson(
  value: unknown,
  depth: number,
  state: { nodes: number },
  seen: WeakSet<object>,
): boolean {
  if (value === null) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= RUN_OUTPUT_MAX_STRING;
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    return false;
  }
  if (typeof value !== 'object') return false;

  if (depth > RUN_OUTPUT_MAX_DEPTH) return false;
  if (seen.has(value as object)) return false; // cycle
  seen.add(value as object);

  state.nodes += 1;
  if (state.nodes > RUN_OUTPUT_MAX_NODES) return false;

  if (Array.isArray(value)) {
    if (value.length > RUN_OUTPUT_MAX_ARRAY) return false;
    for (const item of value) {
      if (!walkBoundedJson(item, depth + 1, state, seen)) return false;
    }
    return true;
  }

  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > RUN_OUTPUT_MAX_KEYS) return false;
  for (const k of keys) {
    if (typeof k !== 'string' || k.length > RUN_OUTPUT_MAX_STRING) return false;
    const child = (value as Record<string, unknown>)[k];
    if (!walkBoundedJson(child, depth + 1, state, seen)) return false;
  }
  return true;
}

/**
 * Runtime type guard for NormalizedRunEvent.
 * Whitelist keys only — rejects any extra field (e.g. Langflow wire leakage).
 */
export function isNormalizedRunEvent(e: unknown): e is NormalizedRunEvent {
  if (!isPlainObject(e)) return false;
  const type = e['type'];
  if (typeof type !== 'string') return false;

  switch (type) {
    case 'run.started': {
      const allowed = new Set(['type', 'runId', 'at']);
      return (
        hasOnlyKeys(e, allowed) &&
        isNonEmptyString(e['runId']) &&
        isIsoLikeString(e['at'])
      );
    }
    case 'step.started': {
      const allowed = new Set(['type', 'runId', 'stepKey', 'at']);
      return (
        hasOnlyKeys(e, allowed) &&
        isNonEmptyString(e['runId']) &&
        isNonEmptyString(e['stepKey']) &&
        isIsoLikeString(e['at'])
      );
    }
    case 'step.finished': {
      const allowed = new Set(['type', 'runId', 'stepKey', 'ok', 'at', 'summary']);
      if (!hasOnlyKeys(e, allowed)) return false;
      if (!isNonEmptyString(e['runId']) || !isNonEmptyString(e['stepKey'])) return false;
      if (typeof e['ok'] !== 'boolean' || !isIsoLikeString(e['at'])) return false;
      if (e['summary'] !== undefined && typeof e['summary'] !== 'string') return false;
      return true;
    }
    case 'tool.call': {
      const allowed = new Set(['type', 'runId', 'tool', 'at']);
      return (
        hasOnlyKeys(e, allowed) &&
        isNonEmptyString(e['runId']) &&
        isNonEmptyString(e['tool']) &&
        isIsoLikeString(e['at'])
      );
    }
    case 'approval.required': {
      const allowed = new Set(['type', 'runId', 'at', 'reason', 'approvalRequestId']);
      if (!hasOnlyKeys(e, allowed)) return false;
      if (!isNonEmptyString(e['runId']) || !isIsoLikeString(e['at'])) return false;
      if (typeof e['reason'] !== 'string') return false;
      if (
        e['approvalRequestId'] !== undefined &&
        typeof e['approvalRequestId'] !== 'string'
      ) {
        return false;
      }
      return true;
    }
    case 'run.output': {
      const allowed = new Set(['type', 'runId', 'at', 'output']);
      if (!hasOnlyKeys(e, allowed)) return false;
      if (!isNonEmptyString(e['runId']) || !isIsoLikeString(e['at'])) return false;
      // Strict: bounded JSON object only (cycle-safe; depth/nodes/array/keys/string/size).
      // Hostile injected adapters must not pass unbounded/cyclic data into DB/trace.
      return isBoundedJsonObject(e['output']);
    }
    case 'run.finished': {
      const allowed = new Set(['type', 'runId', 'at', 'status']);
      if (!hasOnlyKeys(e, allowed)) return false;
      if (!isNonEmptyString(e['runId']) || !isIsoLikeString(e['at'])) return false;
      const status = e['status'];
      return typeof status === 'string' && (FINISHED_STATUSES as Set<string>).has(status);
    }
    case 'run.error': {
      const allowed = new Set(['type', 'runId', 'at', 'code', 'message']);
      if (!hasOnlyKeys(e, allowed)) return false;
      if (!isNonEmptyString(e['runId']) || !isIsoLikeString(e['at'])) return false;
      if (typeof e['message'] !== 'string') return false;
      const code = e['code'];
      return typeof code === 'string' && ERROR_CODES.has(code as RuntimeErrorCode);
    }
    default:
      return false;
  }
}

/** ISO timestamp helper for adapters. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Redact then truncate external text for events / errors / health detail. */
export function redactAndTruncate(text: string, maxLen = 300): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= maxLen) return redacted;
  return redacted.slice(0, maxLen);
}
