// Langflow Runtime Adapter — all HTTP wire format is module-private (not exported).
// Control-plane API key (x-api-key) is required; never log or leak the key.
import { ulid } from 'ulid';
import { isRunApproved as defaultIsRunApproved } from '../lib/approval.js';
import { assertLoopbackUrl } from '../lib/mcpregistry.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import {
  assertDigestMatches,
  computeArtifactDigest,
  nowIso,
  redactAndTruncate,
  RuntimeAdapterError,
  type DeployArtifactRequest,
  type ExecuteRequest,
  type NormalizedRunEvent,
  type ResumeRequest,
  type RuntimeAdapter,
  type RuntimeBinding,
  type RuntimeErrorCode,
  type RuntimeHealth,
  type RuntimeRunState,
  type ValidateArtifactRequest,
  type ValidationResult,
} from './adapter.js';

/** Default per-request HTTP timeout (ms). */
export const LANGFLOW_DEFAULT_TIMEOUT_MS = 15_000;

/** Max accepted Langflow control-plane API key length (after trim). */
export const LANGFLOW_API_KEY_MAX_LEN = 512;

/** Max Flow ID length (shared deploy + binding parser). */
export const LANGFLOW_FLOW_ID_MAX_LEN = 128;

/**
 * Catalogue (`GET /api/v1/all`) is much larger than run responses.
 * Still hard-capped; fail-closed on oversize. Never logs body.
 */
export const LANGFLOW_CATALOGUE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Catalogue fetch timeout (ms). */
export const LANGFLOW_CATALOGUE_TIMEOUT_MS = 30_000;

/**
 * Safe Langflow Flow ID: 1–128 chars, first alphanumeric, then alnum / `.` / `_` / `-` only.
 * Pure, shared by deploy responses and runtime bindings.
 * Errors never reflect the untrusted raw value.
 */
export function parseSafeLangflowFlowId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      'langflow flow id is missing or not a string',
    );
  }
  if (raw.length === 0) {
    throw new RuntimeAdapterError('VALIDATION_FAILED', 'langflow flow id is empty');
  }
  if (raw.length > LANGFLOW_FLOW_ID_MAX_LEN) {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      'langflow flow id exceeds maximum length',
    );
  }
  // Reject controls / whitespace without echoing the value.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(raw) || /\s/.test(raw)) {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      'langflow flow id contains illegal characters',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      'langflow flow id has invalid format',
    );
  }
  return raw;
}

/** Non-throwing predicate matching parseSafeLangflowFlowId rules. */
export function isSafeLangflowFlowId(raw: unknown): raw is string {
  try {
    parseSafeLangflowFlowId(raw);
    return true;
  } catch {
    return false;
  }
}

// ── Ticket 25: 2xx run response contract (fail-closed) ──────────────────────

const OUTPUT_MAX_DEPTH = 8;
const OUTPUT_MAX_STRING = 4_000;
const OUTPUT_MAX_ARRAY = 50;
const OUTPUT_MAX_KEYS = 40;
const OUTPUT_MAX_JSON_CHARS = 32_000;

/**
 * Hard cap on raw Langflow HTTP response body bytes (before JSON parse).
 * Enforced via streaming read even when Content-Length is missing or lying.
 */
export const LANGFLOW_MAX_RESPONSE_BYTES = 256_000;

/** Constant, non-reflective oversize failure (never embed body / lengths from peer). */
const LANGFLOW_RESPONSE_OVERSIZE_MSG = 'langflow response exceeds maximum size';

/** Error-bearing field names checked at top / outer / effective ResultData levels. */
const ERROR_BEARING_KEYS = [
  'error',
  'errors',
  'exception',
  'traceback',
  'detail',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Meaningful error-bearing values: non-empty string/true/number/non-empty
 * array/object. Empty string / false / null / undefined / [] / {} are not.
 * Never used to reflect the value into errors.
 */
function isMeaningfulErrorValue(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  if (isPlainObject(v) && Object.keys(v).length === 0) return false;
  return true;
}

function hasMeaningfulErrorFields(obj: Record<string, unknown>): boolean {
  for (const key of ERROR_BEARING_KEYS) {
    if (isMeaningfulErrorValue(obj[key])) return true;
  }
  return false;
}

/** Explicit error-bearing Langflow payloads (even under HTTP 2xx). */
function isErrorBearingPayload(json: unknown): boolean {
  if (!isPlainObject(json)) return false;
  // Top-level Result envelope
  if (hasMeaningfulErrorFields(json)) return true;
  if (Array.isArray(json['outputs'])) {
    for (const outer of json['outputs']) {
      if (!isPlainObject(outer)) continue;
      // Outer output item
      if (hasMeaningfulErrorFields(outer)) return true;
      const nested = outer['outputs'];
      if (Array.isArray(nested)) {
        for (const inner of nested) {
          // Effective inner ResultData
          if (isPlainObject(inner) && hasMeaningfulErrorFields(inner)) return true;
        }
      }
    }
  }
  return false;
}

/** Non-null plain non-empty ResultData-like object. */
function isNonEmptyResultData(item: unknown): item is Record<string, unknown> {
  return isPlainObject(item) && Object.keys(item).length > 0;
}

/**
 * Collect effective nested outputs: at least one outer item must have a
 * nested `outputs` array containing ≥1 non-null plain non-empty ResultData.
 * Returns null when none.
 */
function extractEffectiveOutputs(json: unknown): unknown[] | null {
  if (!isPlainObject(json)) return null;
  const outputs = json['outputs'];
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const effective: unknown[] = [];
  for (const outer of outputs) {
    if (!isPlainObject(outer)) continue;
    const nested = outer['outputs'];
    if (!Array.isArray(nested) || nested.length === 0) continue;
    for (const item of nested) {
      // Reject null / primitives / empty objects — only ResultData-like objects.
      if (isNonEmptyResultData(item)) {
        effective.push(item);
      }
    }
  }
  return effective.length > 0 ? effective : null;
}

/**
 * Stream-read a fetch Response body with a hard byte cap.
 * - Content-Length present and > max → cancel body, fail closed (no read/parse).
 * - Content-Length missing or lying → still caps on actual streamed bytes.
 * - Never returns oversize text; never logs body.
 */
async function readResponseTextCapped(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const clRaw = res.headers.get('content-length');
  if (clRaw != null && clRaw !== '') {
    const cl = Number(clRaw);
    if (Number.isFinite(cl) && cl > maxBytes) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore cancel errors */
      }
      throw new RuntimeAdapterError('VALIDATION_FAILED', LANGFLOW_RESPONSE_OVERSIZE_MSG);
    }
  }

  if (!res.body) {
    // No stream (e.g. some mocks) — fall back to arrayBuffer with cap.
    const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (buf.byteLength > maxBytes) {
      throw new RuntimeAdapterError('VALIDATION_FAILED', LANGFLOW_RESPONSE_OVERSIZE_MSG);
    }
    return buf.toString('utf8');
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new RuntimeAdapterError('VALIDATION_FAILED', LANGFLOW_RESPONSE_OVERSIZE_MSG);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof RuntimeAdapterError) throw err;
    // Unexpected stream failure — surface as unreachable without body content.
    const msg = err instanceof Error ? err.message : 'stream read failed';
    throw new RuntimeAdapterError(
      'RUNTIME_UNREACHABLE',
      `langflow response read failed: ${redactAndTruncate(msg, 120)}`,
    );
  }

  if (chunks.length === 0) return '';
  if (chunks.length === 1) return Buffer.from(chunks[0]!).toString('utf8');
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Bound depth/size and drop non-JSON values (functions, symbols, bigint, NaN). */
function boundJsonSafe(value: unknown, depth = 0): unknown {
  if (depth > OUTPUT_MAX_DEPTH) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    return value.length > OUTPUT_MAX_STRING
      ? `${value.slice(0, OUTPUT_MAX_STRING)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, OUTPUT_MAX_ARRAY).map((v) => boundJsonSafe(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= OUTPUT_MAX_KEYS) break;
      if (typeof k !== 'string') continue;
      out[k] = boundJsonSafe(v, depth + 1);
      n += 1;
    }
    return out;
  }
  return null;
}

export type NormalizedLangflowOutput = { results: unknown[] };

/**
 * Fail-closed parse of non-streaming Langflow `POST /api/v1/run/{flowId}` body.
 * HTTP 2xx is transport-only — this validates the documented shape:
 * `{ session_id?, outputs:[{ outputs:[...] }] }` with ≥1 effective nested output
 * and no explicit error-bearing payload.
 *
 * Returns bounded, deep-redacted, JSON-safe `{ results }` only (no session_id / wire junk).
 * Reasons never reflect raw hostile body content or secrets.
 */
export function normalizeLangflowRunResponse(
  json: unknown,
): { ok: true; output: NormalizedLangflowOutput } | { ok: false; reason: string } {
  if (json === null || json === undefined) {
    return { ok: false, reason: 'langflow response body missing' };
  }
  if (!isPlainObject(json)) {
    return { ok: false, reason: 'langflow response is not a JSON object' };
  }
  if (isErrorBearingPayload(json)) {
    return { ok: false, reason: 'langflow response contains explicit error' };
  }
  const effective = extractEffectiveOutputs(json);
  if (!effective) {
    return { ok: false, reason: 'langflow response has no effective outputs' };
  }
  let results: unknown[];
  try {
    const bounded = boundJsonSafe(effective);
    const redacted = deepRedactSecrets(bounded);
    results = JSON.parse(JSON.stringify(redacted)) as unknown[];
  } catch {
    return { ok: false, reason: 'langflow output is not JSON-safe' };
  }
  if (!Array.isArray(results) || results.length === 0) {
    return { ok: false, reason: 'langflow response has no effective outputs' };
  }
  const serialized = JSON.stringify(results);
  if (serialized.length > OUTPUT_MAX_JSON_CHARS) {
    return {
      ok: true,
      output: {
        results: [
          {
            truncated: true,
            preview: `${serialized.slice(0, 1_000)}…[truncated]`,
          },
        ],
      },
    };
  }
  return { ok: true, output: { results } };
}

/**
 * Fail-closed normalize of Langflow control-plane API key.
 * - trim whitespace
 * - non-empty
 * - bounded length
 * - reject CR/LF and other C0 control characters (incl. DEL)
 * Never returns a value that should be logged; callers must not embed it in errors.
 */
export function normalizeLangflowApiKey(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      'langflow apiKey must be a non-empty string',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      'langflow apiKey must be a non-empty string',
    );
  }
  if (trimmed.length > LANGFLOW_API_KEY_MAX_LEN) {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      `langflow apiKey exceeds maximum length of ${LANGFLOW_API_KEY_MAX_LEN}`,
    );
  }
  // Reject control / line-separator characters (header injection / log forging):
  // - C0 controls U+0000–U+001F (incl. CR/LF/NUL/TAB)
  // - DEL U+007F
  // - C1 controls U+0080–U+009F
  // - Unicode line/paragraph separators U+2028 / U+2029
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(trimmed)) {
    throw new RuntimeAdapterError(
      'VALIDATION_FAILED',
      'langflow apiKey must not contain control characters (CR/LF/C1/U+2028/U+2029)',
    );
  }
  return trimmed;
}

export interface LangflowAdapterConfig {
  /** Loopback-only base URL; validated at construct time (fail-closed). */
  baseUrl: string;
  /**
   * Langflow control-plane credential (sent as `x-api-key` on every request).
   * Not a provider key. Required; trimmed, non-empty, bounded, no control chars.
   */
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  isRunApproved?: (
    runId: string,
    approvalId?: string | null,
  ) => Promise<boolean>;
}

/** In-flight execute bookkeeping (private to this adapter instance). */
type ActiveRun = {
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
  state: RuntimeRunState;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

export class LangflowAdapter implements RuntimeAdapter {
  readonly kind = 'LANGFLOW' as const;

  private readonly baseUrl: string;
  /** Control-plane key only — never log, never include in errors. */
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly isRunApprovedFn: (
    runId: string,
    approvalId?: string | null,
  ) => Promise<boolean>;
  private readonly active = new Map<string, ActiveRun>();

  constructor(config: LangflowAdapterConfig) {
    // Fail-closed: precise loopback host check (rejects prefix-bypass hostnames).
    assertLoopbackUrl(config.baseUrl);
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    // Fail-closed before any network: validate control-plane key at construct.
    this.apiKey = normalizeLangflowApiKey(config.apiKey);
    this.timeoutMs = config.timeoutMs ?? LANGFLOW_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.isRunApprovedFn = config.isRunApproved ?? defaultIsRunApproved;
  }

  /**
   * Scrub the configured API key from any external/error text before redaction.
   * Works even when the key does not match generic redactor patterns (sk-/Bearer…).
   */
  private scrubKey(text: string): string {
    if (!text || !this.apiKey) return text;
    return text.split(this.apiKey).join('[REDACTED_API_KEY]');
  }

  private safeExternalText(text: string, maxLen = 300): string {
    return redactAndTruncate(this.scrubKey(text), maxLen);
  }

  /**
   * Shared HTTP helper: AbortController + timeout, normalized errors.
   * Always attaches the same `x-api-key` header. Never hangs unbounded.
   * Body text is key-scrubbed + redacted + truncated before use in errors.
   */
  private async http(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
      /** When set, maps non-2xx to this code instead of RUNTIME_UNREACHABLE. */
      non2xxCode?: RuntimeErrorCode;
    },
  ): Promise<{ status: number; text: string; json: unknown }> {
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => {
      controller.abort();
    };
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.apiKey,
    };
    if (opts?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut || (err instanceof Error && err.name === 'AbortError' && timedOut)) {
          throw new RuntimeAdapterError('TIMEOUT', `langflow request timed out after ${timeoutMs}ms`);
        }
        if (err instanceof Error && err.name === 'AbortError') {
          // Propagate so caller can distinguish cancel vs other abort.
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new RuntimeAdapterError(
          'RUNTIME_UNREACHABLE',
          `langflow unreachable: ${this.safeExternalText(msg)}`,
        );
      }

      // Fail-closed raw body size bound BEFORE JSON parse/store/log.
      // Caps streamed bytes even when Content-Length is missing or false.
      const text = await readResponseTextCapped(res, LANGFLOW_MAX_RESPONSE_BYTES);
      const safeText = this.safeExternalText(text);
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = null;
        }
      }

      if (res.status < 200 || res.status >= 300) {
        const code = opts?.non2xxCode ?? 'RUNTIME_UNREACHABLE';
        throw new RuntimeAdapterError(
          code,
          `langflow HTTP ${res.status}: ${safeText || res.statusText || 'error'}`,
        );
      }

      return { status: res.status, text: safeText, json };
    } finally {
      clearTimeout(timer);
      if (opts?.signal) {
        opts.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async health(): Promise<RuntimeHealth> {
    const checkedAt = nowIso();
    const t0 = Date.now();
    try {
      await this.http('GET', '/health', { timeoutMs: this.timeoutMs });
      return {
        kind: 'LANGFLOW',
        healthy: true,
        checkedAt,
        latencyMs: Date.now() - t0,
        detail: null,
      };
    } catch (err) {
      const msg =
        err instanceof RuntimeAdapterError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        kind: 'LANGFLOW',
        healthy: false,
        checkedAt,
        latencyMs: null,
        detail: redactSecrets(msg),
      };
    }
  }

  /**
   * Fetch the exact Langflow component catalogue (`GET /api/v1/all`).
   * Bounded size/time; fail-closed. Does not log or return credentials.
   * Used by the Graph → native Langflow compiler only.
   */
  async fetchComponentCatalogue(opts?: {
    timeoutMs?: number;
    maxBytes?: number;
  }): Promise<unknown> {
    const timeoutMs = opts?.timeoutMs ?? LANGFLOW_CATALOGUE_TIMEOUT_MS;
    const maxBytes = opts?.maxBytes ?? LANGFLOW_CATALOGUE_MAX_RESPONSE_BYTES;
    // Dedicated path: larger body cap than run responses, same key scrubbing.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.apiKey,
    };

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/api/v1/all`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut || (err instanceof Error && err.name === 'AbortError' && timedOut)) {
          throw new RuntimeAdapterError(
            'TIMEOUT',
            `langflow catalogue request timed out after ${timeoutMs}ms`,
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new RuntimeAdapterError(
          'RUNTIME_UNREACHABLE',
          `langflow catalogue unreachable: ${this.safeExternalText(msg)}`,
        );
      }

      const text = await readResponseTextCapped(res, maxBytes);
      const safeText = this.safeExternalText(text);
      if (res.status < 200 || res.status >= 300) {
        throw new RuntimeAdapterError(
          'RUNTIME_UNREACHABLE',
          `langflow catalogue HTTP ${res.status}: ${safeText || res.statusText || 'error'}`,
        );
      }
      if (!text) {
        throw new RuntimeAdapterError('VALIDATION_FAILED', 'langflow catalogue body empty');
      }
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw new RuntimeAdapterError(
          'VALIDATION_FAILED',
          'langflow catalogue is not valid JSON',
        );
      }
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        throw new RuntimeAdapterError(
          'VALIDATION_FAILED',
          'langflow catalogue must be a JSON object',
        );
      }
      // Deep-redact any accidental secret material before returning to compiler.
      return deepRedactSecrets(json);
    } finally {
      clearTimeout(timer);
    }
  }

  async validateArtifact(input: ValidateArtifactRequest): Promise<ValidationResult> {
    // Local-only, deterministic — no network.
    const actual = computeArtifactDigest(input.artifactJson);
    if (actual !== input.digest) {
      return { valid: false, errors: ['digest mismatch'] };
    }
    if (
      input.artifactJson === null ||
      typeof input.artifactJson !== 'object' ||
      Array.isArray(input.artifactJson)
    ) {
      return { valid: false, errors: ['artifact must be an object with nodes and edges arrays'] };
    }
    const obj = input.artifactJson as Record<string, unknown>;
    if (!Array.isArray(obj['nodes']) || !Array.isArray(obj['edges'])) {
      return { valid: false, errors: ['artifact must contain nodes and edges arrays'] };
    }
    return { valid: true, errors: [] };
  }

  async deployArtifact(input: DeployArtifactRequest): Promise<RuntimeBinding> {
    assertDigestMatches(input.artifactJson, input.digest);

    // Wire (private): POST /api/v1/flows/  body { name, data }
    const { json } = await this.http('POST', '/api/v1/flows/', {
      body: { name: input.artifactId, data: input.artifactJson },
    });

    const id =
      json && typeof json === 'object' && !Array.isArray(json)
        ? (json as Record<string, unknown>)['id']
        : undefined;
    // Shared safe parser — reject unsafe ids without reflecting the raw value.
    let safeId: string;
    try {
      safeId = parseSafeLangflowFlowId(id);
    } catch (e) {
      if (e instanceof RuntimeAdapterError) throw e;
      throw new RuntimeAdapterError(
        'VALIDATION_FAILED',
        'langflow deploy response flow id is invalid',
      );
    }

    return {
      kind: 'LANGFLOW',
      bindingRef: `langflow:flow:${safeId}`,
      deployedAt: nowIso(),
    };
  }

  async *execute(input: ExecuteRequest): AsyncIterable<NormalizedRunEvent> {
    const runId = input.runId ?? ulid();
    const artifactId = input.artifactId ?? '';
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const startedAt = nowIso();

    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      cancelled: false,
      timedOut: false,
      timeoutHandle: null,
      state: {
        runId,
        kind: 'LANGFLOW',
        status: 'RUNNING',
        startedAt,
        finishedAt: null,
      },
    };
    this.active.set(runId, active);

    active.timeoutHandle = setTimeout(() => {
      active.timedOut = true;
      controller.abort();
    }, timeoutMs);

    yield { type: 'run.started', runId, at: startedAt };

    try {
      // Wire (private): POST /api/v1/run/{artifactId}  body { input_value }
      // HTTP 2xx is transport-only — body contract is validated fail-closed below.
      const { json } = await this.http(
        'POST',
        `/api/v1/run/${encodeURIComponent(artifactId)}`,
        {
          body: { input_value: JSON.stringify(input.input) },
          signal: controller.signal,
          timeoutMs,
        },
      );

      const normalized = normalizeLangflowRunResponse(json);
      if (!normalized.ok) {
        throw new RuntimeAdapterError('VALIDATION_FAILED', normalized.reason);
      }

      // Emit bounded/deep-redacted output before terminal success.
      yield {
        type: 'run.output',
        runId,
        at: nowIso(),
        output: normalized.output as unknown as Record<string, unknown>,
      };

      active.state = {
        ...active.state,
        status: 'SUCCEEDED',
        finishedAt: nowIso(),
      };
      yield {
        type: 'run.finished',
        runId,
        at: nowIso(),
        status: 'SUCCEEDED',
      };
    } catch (err) {
      if (active.cancelled || (err instanceof Error && err.name === 'AbortError' && active.cancelled)) {
        active.state = {
          ...active.state,
          status: 'CANCELLED',
          finishedAt: nowIso(),
        };
        yield {
          type: 'run.finished',
          runId,
          at: nowIso(),
          status: 'CANCELLED',
        };
        return;
      }

      if (active.timedOut || (err instanceof RuntimeAdapterError && err.code === 'TIMEOUT')) {
        active.state = {
          ...active.state,
          status: 'FAILED',
          finishedAt: nowIso(),
        };
        yield {
          type: 'run.error',
          runId,
          at: nowIso(),
          code: 'TIMEOUT',
          message: redactSecrets(
            err instanceof Error ? err.message : `langflow run timed out after ${timeoutMs}ms`,
          ),
        };
        return;
      }

      if (err instanceof Error && err.name === 'AbortError') {
        // Unexpected abort without cancel/timeout flags.
        active.state = {
          ...active.state,
          status: 'FAILED',
          finishedAt: nowIso(),
        };
        yield {
          type: 'run.error',
          runId,
          at: nowIso(),
          code: 'RUNTIME_UNREACHABLE',
          message: redactSecrets('langflow run aborted'),
        };
        return;
      }

      // Preserve VALIDATION_FAILED for 2xx contract failures (empty/malformed/error-bearing).
      // Other non-adapter errors stay RUNTIME_UNREACHABLE.
      let code: RuntimeErrorCode = 'RUNTIME_UNREACHABLE';
      if (err instanceof RuntimeAdapterError) {
        code = err.code;
      }
      const message = redactSecrets(
        err instanceof Error ? err.message : String(err),
      );
      active.state = {
        ...active.state,
        status: 'FAILED',
        finishedAt: nowIso(),
      };
      yield {
        type: 'run.error',
        runId,
        at: nowIso(),
        code,
        message: this.scrubKey(message),
      };
    } finally {
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
      this.active.delete(runId);
    }
  }

  async getRun(runId: string): Promise<RuntimeRunState> {
    // In-memory only — AIOS DB is the durable source of truth (not Langflow API).
    const active = this.active.get(runId);
    if (!active) {
      throw new RuntimeAdapterError('NOT_FOUND', `langflow run not found: ${runId}`);
    }
    return { ...active.state };
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) {
      throw new RuntimeAdapterError('NOT_FOUND', `langflow run not found: ${runId}`);
    }
    active.cancelled = true;
    active.controller.abort();
  }

  async resumeRun(input: ResumeRequest): Promise<void> {
    // Fail-closed: only a real AIOS ApprovalRequest counts (not Langflow UI approve).
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

    // Wire (private): POST /api/v1/resume/{runId}
    await this.http('POST', `/api/v1/resume/${encodeURIComponent(input.runId)}`, {
      body: { approval_request_id: input.approvalRequestId },
    });
  }
}
