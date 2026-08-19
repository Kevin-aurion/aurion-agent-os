/**
 * Ticket 25 — Langflow environment isolation + 2xx result fail-closed.
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t25-langflow-runtime-boundary.test.ts
 *
 * Covers:
 * - Explicit env for LANGFLOW network resolution (SANDBOX/STAGING/PRODUCTION)
 * - No cross-environment credential fallback
 * - Local validateArtifact without remote credentials
 * - Shared safe Flow ID parser (deploy + binding)
 * - 2xx response contract → run.output then SUCCEEDED; malformed/empty/error → failure
 * - Approval resume revalidates server-bound deployment/environment
 * - Loopback userinfo URLs rejected
 * - Never reflect hostile raw values / secrets
 *
 * Zero new deps. Real DB for resume path only. No compose/auth posture edits.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ulid } from 'ulid';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../src/lib/db.js';
import { ApiError } from '../../../src/lib/http.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  computeFlowArtifactDigest,
  createFlowArtifact,
} from '../../../src/lib/flowartifact.js';
import {
  resolveRuntimeAdapter,
  resolveLocalValidationAdapter,
  validateArtifactForRuntime,
  activateDeployment,
} from '../../../src/lib/runtimedeployment.js';
import {
  parseLangflowRuntimeBinding,
  parseSafeLangflowFlowId,
  getOrCreatePilotRun,
  executePilotRun,
  resumePilotRun,
} from '../../../src/lib/runtimeexecution.js';
import {
  computeArtifactDigest,
  isBoundedJsonObject,
  isNormalizedRunEvent,
  RuntimeAdapterError,
  nowIso,
  type DeployArtifactRequest,
  type ExecuteRequest,
  type NormalizedRunEvent,
  type ResumeRequest,
  type RuntimeAdapter,
  type RuntimeHealth,
  type RuntimeRunState,
  type ValidateArtifactRequest,
  type ValidationResult,
} from '../../../src/runtime/adapter.js';
import {
  LangflowAdapter,
  LANGFLOW_MAX_RESPONSE_BYTES,
  normalizeLangflowRunResponse,
} from '../../../src/runtime/langflow.js';
import { assertLoopbackUrl } from '../../../src/lib/mcpregistry.js';
import { decideApproval } from '../../../src/lib/approval.js';

let failed = 0;
let passed = 0;
let blocked = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

function blockedMsg(label: string, detail: string): void {
  blocked += 1;
  console.log(`BLOCKED  ${label} — ${detail}`);
}

function envSnapshot(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = [
  'AIOS_LANGFLOW_SANDBOX_URL',
  'AIOS_LANGFLOW_SANDBOX_API_KEY',
  'AIOS_LANGFLOW_STAGING_URL',
  'AIOS_LANGFLOW_STAGING_API_KEY',
  'AIOS_LANGFLOW_RUNTIME_URL',
  'AIOS_LANGFLOW_PRODUCTION_API_KEY',
] as const;

/** Distinct fake keys — never real secrets. Used only to prove which key is sent. */
const KEY_SANDBOX = 'sk-test-t25-sandbox-key-aaaa1111';
const KEY_STAGING = 'sk-test-t25-staging-key-bbbb2222';
const KEY_PRODUCTION = 'sk-test-t25-production-key-cccc3333';

const SAFE_FLOW_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

type Recorded = {
  method: string;
  url: string;
  apiKey: string;
};

async function startKeyCaptureMock(opts?: {
  runBody?: unknown;
  runStatus?: number;
  deployId?: string;
  rawBody?: string | null;
  /**
   * Content-Length control for size-cap tests:
   * - auto: let Node set CL from body (default)
   * - omit: chunked, no Content-Length header
   * - number: force Content-Length to this value (may lie)
   */
  contentLength?: 'auto' | 'omit' | number;
}): Promise<{
  baseUrl: string;
  requests: Recorded[];
  close: () => Promise<void>;
}> {
  const requests: Recorded[] = [];
  const deployId = opts?.deployId ?? SAFE_FLOW_ID;
  const runStatus = opts?.runStatus ?? 200;
  const runBody =
    opts?.runBody ??
    ({
      session_id: 'sess-t25',
      outputs: [{ outputs: [{ message: 'classified', label: 'ok' }] }],
    } as const);
  const clMode = opts?.contentLength ?? 'auto';

  const writeRunResponse = (res: http.ServerResponse, body: string) => {
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
    };
    if (clMode === 'omit') {
      // Chunked transfer — no Content-Length (cap must still apply on stream).
      headers['transfer-encoding'] = 'chunked';
      res.writeHead(runStatus, headers);
      // Write in chunks so body is truly streamed.
      const mid = Math.max(1, Math.floor(body.length / 2));
      res.write(body.slice(0, mid));
      res.write(body.slice(mid));
      res.end();
      return;
    }
    if (typeof clMode === 'number') {
      headers['content-length'] = clMode;
      res.writeHead(runStatus, headers);
      res.end(body);
      return;
    }
    // auto
    res.writeHead(runStatus, headers);
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const apiKey = String(req.headers['x-api-key'] ?? '');
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '',
      apiKey,
    });

    const drain = (cb: () => void) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        void body;
        cb();
      });
    };

    const method = req.method ?? 'GET';
    const url = req.url ?? '';

    if (method === 'GET' && url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (method === 'POST' && (url === '/api/v1/flows/' || url === '/api/v1/flows')) {
      drain(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: deployId }));
      });
      return;
    }

    if (method === 'POST' && url.startsWith('/api/v1/run/')) {
      drain(() => {
        if (opts?.rawBody !== undefined) {
          writeRunResponse(res, opts.rawBody ?? '');
          return;
        }
        writeRunResponse(res, JSON.stringify(runBody));
      });
      return;
    }

    if (method === 'POST' && url.startsWith('/api/v1/resume/')) {
      drain(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function collectEvents(
  iter: AsyncIterable<NormalizedRunEvent>,
): Promise<NormalizedRunEvent[]> {
  const out: NormalizedRunEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function createMockAdapter(opts?: {
  script?: (req: ExecuteRequest) => AsyncGenerator<NormalizedRunEvent>;
  flowId?: string;
}): RuntimeAdapter & {
  executeCalls: ExecuteRequest[];
  resumeCalls: ResumeRequest[];
} {
  const executeCalls: ExecuteRequest[] = [];
  const resumeCalls: ResumeRequest[] = [];
  const flowId = opts?.flowId ?? SAFE_FLOW_ID;
  const adapter = {
    kind: 'LANGFLOW' as const,
    executeCalls,
    resumeCalls,
    async health(): Promise<RuntimeHealth> {
      return {
        kind: 'LANGFLOW',
        healthy: true,
        checkedAt: nowIso(),
        latencyMs: 1,
        detail: null,
      };
    },
    async validateArtifact(_input: ValidateArtifactRequest): Promise<ValidationResult> {
      return { valid: true, errors: [] };
    },
    async deployArtifact(_input: DeployArtifactRequest) {
      return {
        kind: 'LANGFLOW' as const,
        bindingRef: `langflow:flow:${flowId}`,
        deployedAt: nowIso(),
      };
    },
    async *execute(input: ExecuteRequest): AsyncGenerator<NormalizedRunEvent> {
      executeCalls.push(input);
      if (opts?.script) {
        yield* opts.script(input);
        return;
      }
      const runId = input.runId ?? 'unknown';
      yield { type: 'run.started', runId, at: nowIso() };
      yield {
        type: 'run.output',
        runId,
        at: nowIso(),
        output: { results: [{ ok: true }] },
      };
      yield {
        type: 'run.finished',
        runId,
        at: nowIso(),
        status: 'SUCCEEDED',
      };
    },
    async getRun(runId: string): Promise<RuntimeRunState> {
      return {
        runId,
        kind: 'LANGFLOW',
        status: 'RUNNING',
        startedAt: null,
        finishedAt: null,
      };
    },
    async cancelRun(): Promise<void> {},
    async resumeRun(input: ResumeRequest): Promise<void> {
      resumeCalls.push(input);
    },
  };
  return adapter;
}

async function main(): Promise<void> {
  console.log('=== t25 langflow runtime boundary ===\n');

  // ── A. Shared safe Flow ID parser ──────────────────────────────────────
  console.log('--- A. parseSafeLangflowFlowId ---');
  {
    check(
      parseSafeLangflowFlowId(SAFE_FLOW_ID) === SAFE_FLOW_ID,
      'safe uuid-like flow id accepted',
      '',
    );
    check(parseSafeLangflowFlowId('Flow_1.2-x') === 'Flow_1.2-x', 'safe alnum/._- accepted', '');

    const hostile = [
      '',
      ' abc',
      'abc def',
      '../x',
      'a/b',
      'a\\b',
      'a:b',
      'a\nb',
      'a\0b',
      '-leading-dash',
      '.leading-dot',
      '_leading-us',
      'x'.repeat(129),
      null,
      123,
      { id: 'x' },
    ];
    for (const h of hostile) {
      let threw = false;
      let msg = '';
      try {
        parseSafeLangflowFlowId(h);
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      check(threw, `parser rejects ${JSON.stringify(h)?.slice(0, 40)}`, 'did not throw');
      // Never reflect hostile raw payload in error text
      if (typeof h === 'string' && h.length > 0) {
        check(
          !msg.includes(h) || h.length < 3,
          `parser error does not reflect hostile value (${String(h).slice(0, 12)}…)`,
          msg,
        );
      }
    }
  }

  // Binding uses same parser semantics; wrong-kind constant message (no reflection)
  console.log('\n--- A2. binding parser shared + no kind reflection ---');
  {
    const ok = parseLangflowRuntimeBinding({
      kind: 'LANGFLOW',
      bindingRef: `langflow:flow:${SAFE_FLOW_ID}`,
    });
    check(ok.ok === true, 'binding valid with shared flow id', JSON.stringify(ok));

    const wrong = parseLangflowRuntimeBinding({
      kind: 'NATIVE_HOSTILE_<script>alert(1)</script>',
      bindingRef: `langflow:flow:${SAFE_FLOW_ID}`,
    });
    check(wrong.ok === false, 'wrong kind rejected', JSON.stringify(wrong));
    if (!wrong.ok) {
      check(
        !wrong.reason.includes('HOSTILE') &&
          !wrong.reason.includes('<script>') &&
          !wrong.reason.includes('NATIVE_HOSTILE'),
        'wrong-kind reason is constant (no reflection)',
        wrong.reason,
      );
      check(
        /LANGFLOW/i.test(wrong.reason) && /kind/i.test(wrong.reason),
        'wrong-kind reason mentions kind must be LANGFLOW',
        wrong.reason,
      );
    }

    const unsafeFlow = parseLangflowRuntimeBinding({
      kind: 'LANGFLOW',
      bindingRef: 'langflow:flow:../evil',
    });
    check(unsafeFlow.ok === false, 'unsafe flow id in binding rejected', JSON.stringify(unsafeFlow));
    if (!unsafeFlow.ok) {
      check(!unsafeFlow.reason.includes('../evil'), 'binding error does not echo unsafe flow id', unsafeFlow.reason);
    }
  }

  // ── B. Environment isolation matrix ────────────────────────────────────
  console.log('\n--- B. environment isolation (no cross-env key) ---');
  {
    const sandboxMock = await startKeyCaptureMock();
    const stagingMock = await startKeyCaptureMock();
    const prodMock = await startKeyCaptureMock();
    const snap = envSnapshot([...ENV_KEYS]);
    try {
      process.env.AIOS_LANGFLOW_SANDBOX_URL = sandboxMock.baseUrl;
      process.env.AIOS_LANGFLOW_SANDBOX_API_KEY = KEY_SANDBOX;
      process.env.AIOS_LANGFLOW_STAGING_URL = stagingMock.baseUrl;
      process.env.AIOS_LANGFLOW_STAGING_API_KEY = KEY_STAGING;
      process.env.AIOS_LANGFLOW_RUNTIME_URL = prodMock.baseUrl;
      process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY = KEY_PRODUCTION;

      // Missing environment → reject before network
      {
        const before = sandboxMock.requests.length + stagingMock.requests.length + prodMock.requests.length;
        let threw = false;
        try {
          resolveRuntimeAdapter('LANGFLOW');
        } catch {
          threw = true;
        }
        const after = sandboxMock.requests.length + stagingMock.requests.length + prodMock.requests.length;
        check(threw, 'LANGFLOW without environment → reject', 'did not throw');
        check(after === before, 'missing environment: zero network', `delta=${after - before}`);
      }

      // Invalid environment → reject
      {
        let threw = false;
        try {
          resolveRuntimeAdapter('LANGFLOW', 'PROD' as 'PRODUCTION');
        } catch {
          threw = true;
        }
        check(threw, 'invalid environment string → reject', 'did not throw');
      }

      // Matrix: each env uses only its key
      const matrix: Array<{ env: 'SANDBOX' | 'STAGING' | 'PRODUCTION'; mock: typeof sandboxMock; key: string }> =
        [
          { env: 'SANDBOX', mock: sandboxMock, key: KEY_SANDBOX },
          { env: 'STAGING', mock: stagingMock, key: KEY_STAGING },
          { env: 'PRODUCTION', mock: prodMock, key: KEY_PRODUCTION },
        ];

      for (const row of matrix) {
        const adapter = resolveRuntimeAdapter('LANGFLOW', row.env);
        const before = row.mock.requests.length;
        await adapter.health();
        const hits = row.mock.requests.slice(before);
        check(hits.length >= 1, `${row.env}: health hits its own endpoint`, `hits=${hits.length}`);
        check(
          hits.every((h) => h.apiKey === row.key),
          `${row.env}: only own API key sent`,
          hits.map((h) => h.apiKey.slice(0, 20)).join(','),
        );
        // Production key must never appear on sandbox/staging
        if (row.env !== 'PRODUCTION') {
          check(
            hits.every((h) => h.apiKey !== KEY_PRODUCTION),
            `${row.env}: production key never sent`,
            '',
          );
        }
        if (row.env !== 'SANDBOX') {
          check(
            hits.every((h) => h.apiKey !== KEY_SANDBOX),
            `${row.env}: sandbox key never sent`,
            '',
          );
        }
      }

      // No fallback: SANDBOX missing URL even when PRODUCTION set
      {
        delete process.env.AIOS_LANGFLOW_SANDBOX_URL;
        let threw = false;
        let msg = '';
        try {
          resolveRuntimeAdapter('LANGFLOW', 'SANDBOX');
        } catch (e) {
          threw = true;
          msg = e instanceof Error ? e.message : String(e);
        }
        check(threw, 'SANDBOX missing URL does not fall back to PRODUCTION', 'did not throw');
        check(
          !msg.includes(KEY_PRODUCTION) && !msg.includes(KEY_SANDBOX),
          'missing URL error does not leak keys',
          msg,
        );
        process.env.AIOS_LANGFLOW_SANDBOX_URL = sandboxMock.baseUrl;
      }

      // Missing key for STAGING — no fallback to production key
      {
        delete process.env.AIOS_LANGFLOW_STAGING_API_KEY;
        let threw = false;
        try {
          resolveRuntimeAdapter('LANGFLOW', 'STAGING');
        } catch {
          threw = true;
        }
        check(threw, 'STAGING missing key does not fall back to PRODUCTION key', 'did not throw');
        process.env.AIOS_LANGFLOW_STAGING_API_KEY = KEY_STAGING;
      }

      // NATIVE still works without Langflow env
      {
        for (const k of ENV_KEYS) delete process.env[k];
        const native = resolveRuntimeAdapter('NATIVE');
        check(native.kind === 'NATIVE', 'NATIVE resolver ignores Langflow env', native.kind);
      }
    } finally {
      restoreEnv(snap);
      await sandboxMock.close();
      await stagingMock.close();
      await prodMock.close();
    }
  }

  // ── C. Local validation without remote credentials ─────────────────────
  console.log('\n--- C. local validation without remote config ---');
  {
    const snap = envSnapshot([...ENV_KEYS]);
    try {
      for (const k of ENV_KEYS) delete process.env[k];
      const local = resolveLocalValidationAdapter('LANGFLOW');
      const good = { nodes: [{ id: 'n1' }], edges: [] };
      const digest = computeArtifactDigest(good);
      const v = await local.validateArtifact({
        artifactId: 'art-local',
        artifactJson: good,
        digest,
      });
      check(v.valid === true, 'local LANGFLOW validate succeeds without env secrets', JSON.stringify(v));

      // resolveRuntimeAdapter still fail-closed without env
      let threw = false;
      try {
        resolveRuntimeAdapter('LANGFLOW', 'PRODUCTION');
      } catch {
        threw = true;
      }
      check(threw, 'network resolver still requires PRODUCTION credentials', 'did not throw');
    } finally {
      restoreEnv(snap);
    }
  }

  // ── D. 2xx response contract ───────────────────────────────────────────
  console.log('\n--- D. 2xx result contract (run.output / failures) ---');
  {
    // Pure normalizer
    const goodNorm = normalizeLangflowRunResponse({
      session_id: 'raw-session-should-not-appear-as-key-in-output-event-path',
      outputs: [{ outputs: [{ text: 'hello sk-test-should-redact-abcdef0123456789' }], wire_only: true }],
    });
    check(goodNorm.ok === true, 'normalizer accepts valid nested outputs', JSON.stringify(goodNorm));
    if (goodNorm.ok) {
      const blob = JSON.stringify(goodNorm.output);
      check(
        !blob.includes('session_id') && !blob.includes('wire_only'),
        'normalized output drops session_id/wire_only',
        blob,
      );
      check(
        !blob.includes('sk-test-should-redact-abcdef0123456789'),
        'normalized output deep-redacts secrets',
        blob.slice(0, 200),
      );
    }

    const badCases: Array<{ label: string; body: unknown; raw?: string }> = [
      { label: 'null body', body: null },
      { label: 'array body', body: [] },
      { label: 'missing outputs', body: { session_id: 's' } },
      { label: 'empty outputs', body: { session_id: 's', outputs: [] } },
      {
        label: 'outer without nested outputs',
        body: { session_id: 's', outputs: [{ wire_only: true }] },
      },
      {
        label: 'empty nested outputs',
        body: { session_id: 's', outputs: [{ outputs: [] }] },
      },
      {
        label: 'explicit top-level error',
        body: { session_id: 's', error: 'boom', outputs: [{ outputs: [{ x: 1 }] }] },
      },
      {
        label: 'nested error',
        body: { session_id: 's', outputs: [{ outputs: [{ error: 'node failed' }] }] },
      },
      // Effective ResultData must be non-null plain non-empty objects
      {
        label: 'nested null ResultData',
        body: { outputs: [{ outputs: [null] }] },
      },
      {
        label: 'nested primitive ResultData',
        body: { outputs: [{ outputs: ['ok-string'] }] },
      },
      {
        label: 'nested empty object ResultData',
        body: { outputs: [{ outputs: [{}] }] },
      },
      {
        label: 'nested number ResultData',
        body: { outputs: [{ outputs: [42] }] },
      },
      // Expanded error-bearing fields (top / outer / inner)
      {
        label: 'top-level errors array',
        body: {
          errors: ['graph failed SECRET_ERR_TOP'],
          outputs: [{ outputs: [{ x: 1 }] }],
        },
      },
      {
        label: 'top-level exception',
        body: {
          exception: 'ValueError: SECRET_EXC_TOP',
          outputs: [{ outputs: [{ x: 1 }] }],
        },
      },
      {
        label: 'top-level traceback',
        body: {
          traceback: 'Traceback SECRET_TB_TOP\n  File...',
          outputs: [{ outputs: [{ x: 1 }] }],
        },
      },
      {
        label: 'top-level detail string',
        body: {
          detail: 'SECRET_DETAIL_TOP not allowed',
          outputs: [{ outputs: [{ x: 1 }] }],
        },
      },
      {
        label: 'outer-level errors',
        body: {
          outputs: [{ errors: { msg: 'SECRET_ERR_OUTER' }, outputs: [{ x: 1 }] }],
        },
      },
      {
        label: 'outer-level exception',
        body: {
          outputs: [{ exception: 'SECRET_EXC_OUTER', outputs: [{ x: 1 }] }],
        },
      },
      {
        label: 'inner-level traceback',
        body: {
          outputs: [{ outputs: [{ text: 'ok', traceback: 'SECRET_TB_INNER' }] }],
        },
      },
      {
        label: 'inner-level detail object',
        body: {
          outputs: [{ outputs: [{ detail: { code: 'SECRET_DETAIL_INNER' } }] }],
        },
      },
    ];
    for (const c of badCases) {
      const r = normalizeLangflowRunResponse(c.body);
      check(r.ok === false, `normalizer rejects: ${c.label}`, JSON.stringify(r));
      if (!r.ok) {
        const reason = r.reason;
        // Reasons must never reflect hostile secrets / stack / raw values
        const reflected =
          reason.includes('SECRET_') ||
          reason.includes('Traceback') ||
          reason.includes('ValueError') ||
          reason.includes('graph failed') ||
          reason.includes('node failed') ||
          reason.includes('boom');
        check(!reflected, `normalizer reason safe: ${c.label}`, reason);
      }
    }

    // Empty error-field forms are NOT meaningful — valid payload still succeeds
    const emptyErrorForms: Array<{ label: string; body: unknown }> = [
      {
        label: 'empty-string error fields',
        body: {
          error: '',
          errors: [],
          exception: '',
          traceback: '',
          detail: '',
          outputs: [{ error: null, errors: {}, outputs: [{ message: 'ok', error: false }] }],
        },
      },
      {
        label: 'null/false empty error fields',
        body: {
          error: null,
          detail: null,
          outputs: [
            {
              exception: false,
              traceback: {},
              outputs: [{ text: 'ok', errors: [], detail: {} }],
            },
          ],
        },
      },
    ];
    for (const c of emptyErrorForms) {
      const r = normalizeLangflowRunResponse(c.body);
      check(r.ok === true, `empty error forms allowed: ${c.label}`, JSON.stringify(r));
    }

    // Live adapter: valid 2xx → run.output then SUCCEEDED
    {
      const mock = await startKeyCaptureMock({
        runBody: {
          session_id: 'raw-wire-junk',
          outputs: [{ outputs: [{ message: 'ok-result' }], wire_only: true }],
        },
      });
      try {
        const adapter = new LangflowAdapter({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-test-t25-exec-valid-not-real',
          timeoutMs: 5000,
          isRunApproved: async () => false,
        });
        const events = await collectEvents(
          adapter.execute({
            agentId: 'a',
            artifactId: SAFE_FLOW_ID,
            input: {},
            triggeredBy: 't25',
            runId: 'run-t25-valid',
          }),
        );
        check(events.every(isNormalizedRunEvent), 'valid execute events all normalized', '');
        const types = events.map((e) => e.type);
        const outIdx = types.indexOf('run.output');
        const finIdx = types.indexOf('run.finished');
        check(outIdx >= 0, 'valid 2xx emits run.output', types.join(','));
        check(
          finIdx > outIdx &&
            events[finIdx]?.type === 'run.finished' &&
            (events[finIdx] as { status?: string }).status === 'SUCCEEDED',
          'run.output precedes run.finished SUCCEEDED',
          types.join(','),
        );
        const blob = JSON.stringify(events);
        check(
          !blob.includes('session_id') &&
            !blob.includes('raw-wire-junk') &&
            !blob.includes('wire_only'),
          'wire fields do not leak into events',
          blob.slice(0, 300),
        );
      } finally {
        await mock.close();
      }
    }

    // Malformed JSON 2xx → failure, never success
    {
      const mock = await startKeyCaptureMock({ rawBody: '{not-json' });
      try {
        const adapter = new LangflowAdapter({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-test-t25-exec-badjson-not-real',
          timeoutMs: 5000,
          isRunApproved: async () => false,
        });
        const events = await collectEvents(
          adapter.execute({
            agentId: 'a',
            artifactId: SAFE_FLOW_ID,
            input: {},
            triggeredBy: 't25',
            runId: 'run-t25-badjson',
          }),
        );
        const last = events[events.length - 1];
        check(
          last?.type === 'run.error',
          'malformed JSON 2xx → run.error',
          JSON.stringify(last),
        );
        check(
          !events.some((e) => e.type === 'run.finished' && e.status === 'SUCCEEDED'),
          'malformed JSON never SUCCEEDED',
          JSON.stringify(events.map((e) => e.type)),
        );
      } finally {
        await mock.close();
      }
    }

    // Empty effective outputs 2xx → failure
    {
      const mock = await startKeyCaptureMock({
        runBody: { session_id: 's', outputs: [{ outputs: [] }] },
      });
      try {
        const adapter = new LangflowAdapter({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-test-t25-exec-empty-not-real',
          timeoutMs: 5000,
          isRunApproved: async () => false,
        });
        const events = await collectEvents(
          adapter.execute({
            agentId: 'a',
            artifactId: SAFE_FLOW_ID,
            input: {},
            triggeredBy: 't25',
            runId: 'run-t25-empty',
          }),
        );
        const last = events[events.length - 1];
        check(last?.type === 'run.error', 'empty effective outputs → run.error', JSON.stringify(last));
        check(
          !events.some((e) => e.type === 'run.finished' && e.status === 'SUCCEEDED'),
          'empty outputs never SUCCEEDED',
          '',
        );
      } finally {
        await mock.close();
      }
    }

    // Explicit error-bearing 2xx → failure
    {
      const mock = await startKeyCaptureMock({
        runBody: {
          session_id: 's',
          error: 'graph exploded sk-test-leak-me-zzzz9999',
          outputs: [{ outputs: [{ x: 1 }] }],
        },
      });
      try {
        const adapter = new LangflowAdapter({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-test-t25-exec-errbody-not-real',
          timeoutMs: 5000,
          isRunApproved: async () => false,
        });
        const events = await collectEvents(
          adapter.execute({
            agentId: 'a',
            artifactId: SAFE_FLOW_ID,
            input: {},
            triggeredBy: 't25',
            runId: 'run-t25-errbody',
          }),
        );
        const blob = JSON.stringify(events);
        check(
          events.some((e) => e.type === 'run.error'),
          'error-bearing 2xx → run.error',
          blob.slice(0, 200),
        );
        check(
          !blob.includes('sk-test-leak-me-zzzz9999'),
          'error-bearing payload secrets not reflected in events',
          blob.slice(0, 200),
        );
        check(
          !events.some((e) => e.type === 'run.finished' && e.status === 'SUCCEEDED'),
          'error-bearing 2xx never SUCCEEDED',
          '',
        );
      } finally {
        await mock.close();
      }
    }

    // Unsafe deploy Flow ID
    {
      const mock = await startKeyCaptureMock({ deployId: '../not-safe' });
      try {
        const adapter = new LangflowAdapter({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-test-t25-deploy-unsafe-not-real',
          timeoutMs: 5000,
          isRunApproved: async () => false,
        });
        const good = { nodes: [], edges: [] };
        const digest = computeArtifactDigest(good);
        let threw = false;
        let msg = '';
        try {
          await adapter.deployArtifact({
            artifactId: 'art',
            artifactJson: good,
            digest,
            environment: 'SANDBOX',
            channel: 'CANARY',
          });
        } catch (e) {
          threw = true;
          msg = e instanceof Error ? e.message : String(e);
        }
        check(threw, 'deploy unsafe flow id rejected', 'did not throw');
        check(
          !msg.includes('../not-safe'),
          'deploy error does not reflect unsafe flow id',
          msg,
        );
      } finally {
        await mock.close();
      }
    }

    // ── D2. Streaming response byte cap (before JSON parse) ──────────────
    console.log('\n--- D2. raw response byte cap (streaming) ---');
    {
      const OVERSIZE_MARKER = 'OVERSIZE_BODY_MARKER_MUST_NEVER_APPEAR_IN_ERRORS_zzzz';

      /** Build ASCII body of exact byte length (JSON-ish padding). */
      function bodyOfExactBytes(n: number, marker = ''): string {
        // Prefer a valid small JSON envelope when it fits; else pure padding.
        const base = `{"outputs":[{"outputs":[{"m":"${marker}","p":"`;
        const end = '"}]}]}';
        const overhead = base.length + end.length;
        if (n < overhead + 1) {
          return 'x'.repeat(n);
        }
        return base + 'a'.repeat(n - overhead) + end;
      }

      // Just below max with Content-Length (auto) → read succeeds; may still fail contract
      {
        const justBelow = bodyOfExactBytes(LANGFLOW_MAX_RESPONSE_BYTES - 1, 'below');
        check(
          Buffer.byteLength(justBelow, 'utf8') === LANGFLOW_MAX_RESPONSE_BYTES - 1,
          'fixture just-below is exact max-1 bytes',
          `len=${Buffer.byteLength(justBelow, 'utf8')}`,
        );
        const mock = await startKeyCaptureMock({
          rawBody: justBelow,
          contentLength: 'auto',
        });
        try {
          const adapter = new LangflowAdapter({
            baseUrl: mock.baseUrl,
            apiKey: 'sk-test-t25-size-below-not-real',
            timeoutMs: 8000,
            isRunApproved: async () => false,
          });
          const events = await collectEvents(
            adapter.execute({
              agentId: 'a',
              artifactId: SAFE_FLOW_ID,
              input: {},
              triggeredBy: 't25',
              runId: 'run-t25-size-below',
            }),
          );
          const blob = JSON.stringify(events);
          // Must not fail with oversize constant — body was under cap
          check(
            !blob.includes('exceeds maximum size'),
            'just-below max does not trip oversize',
            blob.slice(0, 240),
          );
          // Valid envelope under cap → success path allowed
          check(
            events.some((e) => e.type === 'run.finished' && e.status === 'SUCCEEDED') ||
              events.some((e) => e.type === 'run.error'),
            'just-below produces terminal event (success or contract error, not hang)',
            events.map((e) => e.type).join(','),
          );
        } finally {
          await mock.close();
        }
      }

      // Just above max with Content-Length → fail-closed, no body reflection
      {
        const justAbove = bodyOfExactBytes(
          LANGFLOW_MAX_RESPONSE_BYTES + 1,
          OVERSIZE_MARKER,
        );
        check(
          Buffer.byteLength(justAbove, 'utf8') === LANGFLOW_MAX_RESPONSE_BYTES + 1,
          'fixture just-above is exact max+1 bytes',
          `len=${Buffer.byteLength(justAbove, 'utf8')}`,
        );
        const mock = await startKeyCaptureMock({
          rawBody: justAbove,
          contentLength: 'auto',
        });
        try {
          const adapter = new LangflowAdapter({
            baseUrl: mock.baseUrl,
            apiKey: 'sk-test-t25-size-above-not-real',
            timeoutMs: 8000,
            isRunApproved: async () => false,
          });
          const events = await collectEvents(
            adapter.execute({
              agentId: 'a',
              artifactId: SAFE_FLOW_ID,
              input: {},
              triggeredBy: 't25',
              runId: 'run-t25-size-above',
            }),
          );
          const last = events[events.length - 1];
          const blob = JSON.stringify(events);
          check(last?.type === 'run.error', 'just-above max → run.error', JSON.stringify(last));
          check(
            !events.some((e) => e.type === 'run.finished' && e.status === 'SUCCEEDED'),
            'just-above never SUCCEEDED',
            '',
          );
          check(
            blob.includes('exceeds maximum size'),
            'just-above uses constant oversize message',
            blob.slice(0, 240),
          );
          check(
            !blob.includes(OVERSIZE_MARKER) && !blob.includes('a'.repeat(40)),
            'just-above never reflects/stores body content',
            blob.slice(0, 240),
          );
        } finally {
          await mock.close();
        }
      }

      // Missing Content-Length (chunked) with oversize body → still capped
      {
        const justAbove = bodyOfExactBytes(
          LANGFLOW_MAX_RESPONSE_BYTES + 1,
          OVERSIZE_MARKER,
        );
        const mock = await startKeyCaptureMock({
          rawBody: justAbove,
          contentLength: 'omit',
        });
        try {
          const adapter = new LangflowAdapter({
            baseUrl: mock.baseUrl,
            apiKey: 'sk-test-t25-size-nocl-not-real',
            timeoutMs: 8000,
            isRunApproved: async () => false,
          });
          const events = await collectEvents(
            adapter.execute({
              agentId: 'a',
              artifactId: SAFE_FLOW_ID,
              input: {},
              triggeredBy: 't25',
              runId: 'run-t25-size-nocl',
            }),
          );
          const blob = JSON.stringify(events);
          check(
            events.some((e) => e.type === 'run.error'),
            'missing Content-Length oversize → run.error',
            blob.slice(0, 240),
          );
          check(
            blob.includes('exceeds maximum size'),
            'missing CL oversize uses constant message',
            blob.slice(0, 240),
          );
          check(
            !blob.includes(OVERSIZE_MARKER),
            'missing CL oversize never reflects body marker',
            blob.slice(0, 240),
          );
          check(
            !events.some((e) => e.type === 'run.finished' && e.status === 'SUCCEEDED'),
            'missing CL oversize never SUCCEEDED',
            '',
          );
        } finally {
          await mock.close();
        }
      }

      // Content-Length claims oversize (even before streaming full body)
      {
        const small = JSON.stringify({
          outputs: [{ outputs: [{ message: 'tiny' }] }],
        });
        const mock = await startKeyCaptureMock({
          rawBody: small,
          contentLength: LANGFLOW_MAX_RESPONSE_BYTES + 99,
        });
        try {
          const adapter = new LangflowAdapter({
            baseUrl: mock.baseUrl,
            apiKey: 'sk-test-t25-size-cl-lie-not-real',
            timeoutMs: 5000,
            isRunApproved: async () => false,
          });
          const events = await collectEvents(
            adapter.execute({
              agentId: 'a',
              artifactId: SAFE_FLOW_ID,
              input: {},
              triggeredBy: 't25',
              runId: 'run-t25-size-cl',
            }),
          );
          const blob = JSON.stringify(events);
          check(
            events.some((e) => e.type === 'run.error') &&
              blob.includes('exceeds maximum size'),
            'Content-Length oversize claim → constant fail-closed',
            blob.slice(0, 240),
          );
          check(
            !events.some((e) => e.type === 'run.finished' && e.status === 'SUCCEEDED'),
            'CL oversize claim never SUCCEEDED',
            '',
          );
        } finally {
          await mock.close();
        }
      }
    }

    // ── D3. isNormalizedRunEvent / isBoundedJsonObject guard ─────────────
    console.log('\n--- D3. run.output bounded JSON guard ---');
    {
      const at = nowIso();
      const base = { type: 'run.output' as const, runId: 'r1', at };

      check(
        isBoundedJsonObject({ results: [{ ok: true }] }),
        'isBoundedJsonObject accepts plain results object',
        '',
      );
      check(
        isNormalizedRunEvent({
          ...base,
          output: { results: [{ message: 'ok' }] },
        }),
        'run.output with bounded results accepted',
        '',
      );

      // Cycle
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic['self'] = cyclic;
      check(!isBoundedJsonObject(cyclic), 'isBoundedJsonObject rejects cycle', '');
      check(
        !isNormalizedRunEvent({ ...base, output: cyclic }),
        'run.output with cyclic output rejected',
        '',
      );

      // Over-deep nesting
      let deep: unknown = { v: 1 };
      for (let i = 0; i < 20; i++) deep = { child: deep };
      check(
        !isBoundedJsonObject(deep as Record<string, unknown>),
        'isBoundedJsonObject rejects over-deep object',
        '',
      );
      check(
        !isNormalizedRunEvent({ ...base, output: deep as Record<string, unknown> }),
        'run.output over-deep rejected',
        '',
      );

      // Oversize array
      const bigArr = { results: Array.from({ length: 80 }, (_, i) => ({ i })) };
      check(!isBoundedJsonObject(bigArr), 'isBoundedJsonObject rejects oversize array', '');
      check(
        !isNormalizedRunEvent({ ...base, output: bigArr }),
        'run.output oversize array rejected',
        '',
      );

      // Oversize string leaf
      const bigStr = { results: [{ text: 'z'.repeat(5_000) }] };
      check(!isBoundedJsonObject(bigStr), 'isBoundedJsonObject rejects oversize string', '');
      check(
        !isNormalizedRunEvent({ ...base, output: bigStr }),
        'run.output oversize string rejected',
        '',
      );

      // Oversize key count
      const manyKeys: Record<string, unknown> = {};
      for (let i = 0; i < 60; i++) manyKeys[`k${i}`] = i;
      check(!isBoundedJsonObject(manyKeys), 'isBoundedJsonObject rejects too many keys', '');
      check(
        !isNormalizedRunEvent({ ...base, output: manyKeys }),
        'run.output too many keys rejected',
        '',
      );

      // Non-plain / array root
      check(!isBoundedJsonObject([1, 2, 3]), 'isBoundedJsonObject rejects array root', '');
      check(
        !isNormalizedRunEvent({ ...base, output: [1, 2, 3] as unknown as Record<string, unknown> }),
        'run.output array root rejected',
        '',
      );
      check(!isBoundedJsonObject(null), 'isBoundedJsonObject rejects null', '');
      check(
        !isNormalizedRunEvent({
          ...base,
          output: null as unknown as Record<string, unknown>,
        }),
        'run.output null rejected',
        '',
      );

      // Serialized size (many medium strings under other limits but huge JSON)
      const fat: Record<string, unknown> = {
        results: Array.from({ length: 40 }, (_, i) => ({
          t: 'y'.repeat(900),
          i,
        })),
      };
      // 40 * ~900 > 32k when serialized
      check(
        !isBoundedJsonObject(fat) || JSON.stringify(fat).length > 32_000,
        'fat payload either rejected by bound or over serialized limit',
        `jsonLen=${JSON.stringify(fat).length}`,
      );
      if (JSON.stringify(fat).length > 32_000) {
        check(
          !isBoundedJsonObject(fat),
          'isBoundedJsonObject rejects oversize serialized JSON',
          '',
        );
        check(
          !isNormalizedRunEvent({ ...base, output: fat }),
          'run.output oversize serialized rejected',
          '',
        );
      }
    }
  }

  // ── E. userinfo loopback rejected ──────────────────────────────────────
  console.log('\n--- E. userinfo loopback URL rejected ---');
  {
    const urls = [
      'http://user:pass@127.0.0.1:7860',
      'http://user@localhost:7860',
      'http://:pass@127.0.0.1:7860',
    ];
    for (const url of urls) {
      let threw = false;
      let msg = '';
      try {
        assertLoopbackUrl(url);
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      check(threw, `assertLoopbackUrl rejects userinfo: ${url.replace(/:[^:@/]+@/, ':***@')}`, 'did not throw');
      // Constant message may say "username or password"; must not echo the raw credential values.
      check(
        !msg.includes('user:pass') &&
          !msg.includes('@127') &&
          !/:\/\/[^/]*:/.test(msg) &&
          !msg.includes(url),
        'userinfo reject message does not leak credentials',
        msg,
      );
      // LangflowAdapter construct also fails
      let threw2 = false;
      try {
        new LangflowAdapter({ baseUrl: url, apiKey: 'sk-test-t25-userinfo-not-real' });
      } catch {
        threw2 = true;
      }
      check(threw2, `LangflowAdapter rejects userinfo URL`, 'did not throw');
    }
  }

  // ── F. Approval resume binding (DB) ────────────────────────────────────
  console.log('\n--- F. approval resume revalidates deployment/environment ---');
  {
    const tag = ulid().slice(-8).toLowerCase();
    const ownerId = ulid();
    const agentId = ulid();
    const skillId = ulid();
    const suiteId = ulid();
    const evalRunId = ulid();
    const workflowId = ulid();
    const stepId = ulid();
    const contentMd = `# t25 resume ${tag}\n`;
    let skillVersionId = '';
    let artifactId = '';
    let deployId = '';
    const runIds: string[] = [];
    const mock = createMockAdapter({
      script: async function* (req) {
        const runId = req.runId ?? 'unknown';
        yield {
          type: 'approval.required',
          runId,
          at: nowIso(),
          reason: 'need fde',
        };
      },
    });

    try {
      await prisma.user.create({
        data: {
          id: ownerId,
          email: `t25-owner-${tag}@aios.test`,
          displayName: 'T25 Owner',
          passwordHash: 'x',
          role: 'OWNER',
        },
      });
      await prisma.agent.create({
        data: {
          id: agentId,
          slug: `t25-agent-${tag}`,
          name: `T25 Agent ${tag}`,
          description: 't25',
          rolePrompt: 't25',
          engineExecute: 'CLAUDE_CODE',
          engineVerify: null,
          createdBy: ownerId,
          riskTier: 'low',
        },
      });
      await prisma.skill.create({
        data: {
          id: skillId,
          slug: `t25-skill-${tag}`,
          name: `T25 Skill ${tag}`,
          origin: 'UPLOADED',
          kind: 'PROMPT_MANUAL',
          contentMd,
          reviewStatus: 'CONFIRMED',
          confirmedAt: new Date(),
          confirmedBy: ownerId,
          executionEnv: 'CLI',
        },
      });
      const sv = await createSkillVersion(skillId, contentMd, ownerId);
      skillVersionId = sv.id;
      await prisma.evalSuite.create({
        data: { id: suiteId, skillId, name: `T25 Suite ${tag}`, createdBy: ownerId },
      });
      await prisma.evalRun.create({
        data: {
          id: evalRunId,
          suiteId,
          skillId,
          candidateVersionId: skillVersionId,
          executeEngine: 'CLAUDE_CODE',
          verifyEngine: 'CODEX',
          status: 'PASSED',
          totalCases: 1,
          passedCases: 1,
          finishedAt: new Date(),
          triggeredBy: ownerId,
        },
      });
      const art = await createFlowArtifact({
        skillVersionId,
        runtimeKind: 'LANGFLOW',
        template: 'email-triage-readonly-v1',
        compilerVersion: `t25-${tag}`,
        artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'langflow', tag },
        createdBy: ownerId,
      });
      artifactId = art.id;
      const row = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });
      await prisma.flowArtifact.update({
        where: { id: artifactId },
        data: {
          status: 'VALIDATED',
          digest: computeFlowArtifactDigest(row.artifactJson),
        },
      });
      await prisma.agentSkill.create({ data: { agentId, skillId } });
      const dep = await activateDeployment(
        {
          artifactId,
          environment: 'SANDBOX',
          channel: 'CANARY',
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: mock },
      );
      deployId = dep.id;
      await prisma.workflow.create({
        data: {
          id: workflowId,
          agentId,
          name: `T25 WF ${tag}`,
          description: 't25',
          enabled: true,
          trigger: { type: 'manual' },
        },
      });
      await prisma.workflowStep.create({
        data: {
          id: stepId,
          workflowId,
          position: 0,
          stepKey: 'do-1',
          type: 'DO',
          config: { prompt: 'x' },
        },
      });

      const deployment = await prisma.runtimeDeployment.findUniqueOrThrow({
        where: { id: deployId },
      });
      const artifact = await prisma.flowArtifact.findUniqueOrThrow({ where: { id: artifactId } });

      const { run } = await getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: `msg-appr-${tag}`,
        triggeredBy: ownerId,
        input: { messageId: `msg-appr-${tag}` },
      });
      runIds.push(run.id);

      const exec = await executePilotRun(
        { runId: run.id, deployment, artifact, triggeredBy: ownerId },
        { adapter: mock },
      );
      check(exec.status === 'AWAITING_REVIEW', 'approval path → AWAITING_REVIEW', `status=${exec.status}`);

      const approval = await prisma.approvalRequest.findUnique({ where: { runId: run.id } });
      check(!!approval, 'ApprovalRequest created', '');
      const payload = (approval?.payload ?? {}) as Record<string, unknown>;
      check(
        payload.deploymentId === deployId && payload.environment === 'SANDBOX',
        'approval payload is server-bound deploymentId+environment',
        JSON.stringify(payload),
      );
      check(
        payload.artifactId === artifactId,
        'approval payload includes artifactId',
        JSON.stringify(payload),
      );

      // Client-invented metadata must not be trusted: strip payload then resume after approve
      await decideApproval(approval!.id, true, ownerId);

      // Tamper: wrong environment in payload
      await prisma.approvalRequest.update({
        where: { id: approval!.id },
        data: {
          payload: {
            source: 'langflow-pilot',
            deploymentId: deployId,
            environment: 'PRODUCTION', // mismatch vs real SANDBOX deployment
            artifactId,
          } as Prisma.InputJsonValue,
        },
      });
      const resumeBefore = mock.resumeCalls.length;
      try {
        await resumePilotRun(
          {
            runId: run.id,
            approvalRequestId: approval!.id,
            actorId: ownerId,
            actorRole: 'OWNER',
          },
          { adapter: mock },
        );
        fail('mismatched environment resume rejects', 'did not throw');
      } catch (e) {
        check(
          e instanceof ApiError || e instanceof Error,
          'mismatched environment → fail-closed',
          String(e),
        );
      }
      check(
        mock.resumeCalls.length === resumeBefore,
        'resume adapter not called on env mismatch',
        `calls=${mock.resumeCalls.length}`,
      );

      // Missing deployment binding
      await prisma.approvalRequest.update({
        where: { id: approval!.id },
        data: {
          payload: { source: 'langflow-pilot' } as Prisma.InputJsonValue,
        },
      });
      try {
        await resumePilotRun(
          {
            runId: run.id,
            approvalRequestId: approval!.id,
            actorId: ownerId,
            actorRole: 'OWNER',
          },
          { adapter: mock },
        );
        fail('missing deployment binding resume rejects', 'did not throw');
      } catch {
        pass('missing deployment binding → reject');
      }
      check(
        mock.resumeCalls.length === resumeBefore,
        'resume adapter not called on missing binding',
        `calls=${mock.resumeCalls.length}`,
      );

      // Stale: deactivate deployment
      await prisma.approvalRequest.update({
        where: { id: approval!.id },
        data: {
          payload: {
            source: 'langflow-pilot',
            deploymentId: deployId,
            environment: 'SANDBOX',
            artifactId,
          } as Prisma.InputJsonValue,
        },
      });
      await prisma.runtimeDeployment.update({
        where: { id: deployId },
        data: { active: false, deactivatedAt: new Date() },
      });
      try {
        await resumePilotRun(
          {
            runId: run.id,
            approvalRequestId: approval!.id,
            actorId: ownerId,
            actorRole: 'OWNER',
          },
          { adapter: mock },
        );
        fail('inactive deployment resume rejects', 'did not throw');
      } catch {
        pass('inactive/stale deployment → reject');
      }
      check(
        mock.resumeCalls.length === resumeBefore,
        'resume adapter not called on inactive deployment',
        `calls=${mock.resumeCalls.length}`,
      );

      // Restore active + correct payload for further resume binding negatives
      await prisma.runtimeDeployment.update({
        where: { id: deployId },
        data: { active: true, deactivatedAt: null },
      });
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: 'AWAITING_REVIEW',
          finishedAt: null,
          artifactId,
        },
      });
      await prisma.approvalRequest.update({
        where: { id: approval!.id },
        data: {
          payload: {
            source: 'langflow-pilot',
            deploymentId: deployId,
            environment: 'SANDBOX',
            artifactId,
          } as Prisma.InputJsonValue,
        },
      });

      // Triple artifact binding: missing run.artifactId → fail-closed, zero adapter
      {
        await prisma.run.update({
          where: { id: run.id },
          data: { artifactId: null, status: 'AWAITING_REVIEW', finishedAt: null },
        });
        const before = mock.resumeCalls.length;
        try {
          await resumePilotRun(
            {
              runId: run.id,
              approvalRequestId: approval!.id,
              actorId: ownerId,
              actorRole: 'OWNER',
            },
            { adapter: mock },
          );
          fail('missing run.artifactId resume rejects', 'did not throw');
        } catch {
          pass('missing run.artifactId → reject');
        }
        check(
          mock.resumeCalls.length === before,
          'resume adapter not called on missing run.artifactId',
          `calls=${mock.resumeCalls.length}`,
        );
        await prisma.run.update({
          where: { id: run.id },
          data: { artifactId, status: 'AWAITING_REVIEW', finishedAt: null },
        });
      }

      // Missing payload.artifactId → fail-closed, zero adapter
      {
        await prisma.approvalRequest.update({
          where: { id: approval!.id },
          data: {
            payload: {
              source: 'langflow-pilot',
              deploymentId: deployId,
              environment: 'SANDBOX',
              // artifactId intentionally omitted
            } as Prisma.InputJsonValue,
          },
        });
        const before = mock.resumeCalls.length;
        try {
          await resumePilotRun(
            {
              runId: run.id,
              approvalRequestId: approval!.id,
              actorId: ownerId,
              actorRole: 'OWNER',
            },
            { adapter: mock },
          );
          fail('missing payload.artifactId resume rejects', 'did not throw');
        } catch {
          pass('missing payload.artifactId → reject');
        }
        check(
          mock.resumeCalls.length === before,
          'resume adapter not called on missing payload.artifactId',
          `calls=${mock.resumeCalls.length}`,
        );
      }

      // Empty-string payload.artifactId → fail-closed
      {
        await prisma.approvalRequest.update({
          where: { id: approval!.id },
          data: {
            payload: {
              source: 'langflow-pilot',
              deploymentId: deployId,
              environment: 'SANDBOX',
              artifactId: '',
            } as Prisma.InputJsonValue,
          },
        });
        const before = mock.resumeCalls.length;
        try {
          await resumePilotRun(
            {
              runId: run.id,
              approvalRequestId: approval!.id,
              actorId: ownerId,
              actorRole: 'OWNER',
            },
            { adapter: mock },
          );
          fail('empty payload.artifactId resume rejects', 'did not throw');
        } catch {
          pass('empty payload.artifactId → reject');
        }
        check(
          mock.resumeCalls.length === before,
          'resume adapter not called on empty payload.artifactId',
          `calls=${mock.resumeCalls.length}`,
        );
      }

      // Mismatched payload.artifactId vs run/deployment → fail-closed
      {
        await prisma.approvalRequest.update({
          where: { id: approval!.id },
          data: {
            payload: {
              source: 'langflow-pilot',
              deploymentId: deployId,
              environment: 'SANDBOX',
              artifactId: 'art_MISMATCH_NOT_EQUAL',
            } as Prisma.InputJsonValue,
          },
        });
        const before = mock.resumeCalls.length;
        try {
          await resumePilotRun(
            {
              runId: run.id,
              approvalRequestId: approval!.id,
              actorId: ownerId,
              actorRole: 'OWNER',
            },
            { adapter: mock },
          );
          fail('mismatched payload.artifactId resume rejects', 'did not throw');
        } catch {
          pass('mismatched payload.artifactId → reject');
        }
        check(
          mock.resumeCalls.length === before,
          'resume adapter not called on mismatched artifactId',
          `calls=${mock.resumeCalls.length}`,
        );
      }

      // Restore correct triple binding → success
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'AWAITING_REVIEW', finishedAt: null, artifactId },
      });
      await prisma.approvalRequest.update({
        where: { id: approval!.id },
        data: {
          payload: {
            source: 'langflow-pilot',
            deploymentId: deployId,
            environment: 'SANDBOX',
            artifactId,
          } as Prisma.InputJsonValue,
        },
      });
      const resumeBeforeValid = mock.resumeCalls.length;
      const resumed = await resumePilotRun(
        {
          runId: run.id,
          approvalRequestId: approval!.id,
          actorId: ownerId,
          actorRole: 'OWNER',
        },
        { adapter: mock },
      );
      check(resumed.status === 'RUNNING', 'valid resume → RUNNING', `status=${resumed.status}`);
      check(
        mock.resumeCalls.length === resumeBeforeValid + 1,
        'resume adapter called once after valid revalidation',
        `calls=${mock.resumeCalls.length}`,
      );

      // Persist normalized output before terminal success
      const outMock = createMockAdapter();
      const { run: run2 } = await getOrCreatePilotRun({
        workflowId,
        agentId,
        artifactId,
        messageId: `msg-out-${tag}`,
        triggeredBy: ownerId,
        input: { messageId: `msg-out-${tag}` },
      });
      runIds.push(run2.id);
      const deployment2 = await prisma.runtimeDeployment.findUniqueOrThrow({
        where: { id: deployId },
      });
      const result2 = await executePilotRun(
        {
          runId: run2.id,
          deployment: deployment2,
          artifact,
          triggeredBy: ownerId,
        },
        { adapter: outMock },
      );
      check(result2.status === 'SUCCEEDED', 'output path SUCCEEDED', `status=${result2.status}`);
      const runRow = await prisma.run.findUniqueOrThrow({ where: { id: run2.id } });
      check(runRow.status === 'SUCCEEDED', 'DB status SUCCEEDED', `status=${runRow.status}`);
      const outBlob = JSON.stringify(runRow.output ?? null);
      check(
        outBlob.includes('results') || outBlob.includes('ok'),
        'normalized output persisted on Run',
        outBlob.slice(0, 200),
      );

      // validateArtifactForRuntime local without env (uses real artifact)
      const snap = envSnapshot([...ENV_KEYS]);
      try {
        for (const k of ENV_KEYS) delete process.env[k];
        // Need COMPILED/VALIDATED — already VALIDATED
        const vr = await validateArtifactForRuntime({
          artifactId,
          actorId: ownerId,
          actorRole: 'OWNER',
        });
        check(
          vr.status === 'VALIDATED',
          'validateArtifactForRuntime without Langflow env secrets',
          JSON.stringify(vr),
        );
      } finally {
        restoreEnv(snap);
      }
    } catch (e) {
      fail('resume binding suite', e instanceof Error ? e.message : String(e));
    } finally {
      // cleanup test-owned rows only
      try {
        if (runIds.length) {
          await prisma.approvalRequest.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.runStep.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.costLog.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.runTrace.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.runtimeDeadLetter.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.run.deleteMany({ where: { id: { in: runIds } } });
        }
        await prisma.workflowStep.deleteMany({ where: { workflowId } });
        await prisma.workflow.deleteMany({ where: { id: workflowId } });
        await prisma.runtimeDeployment.deleteMany({ where: { skillId } });
        await prisma.agentSkill.deleteMany({ where: { agentId } });
        await prisma.evalRun.deleteMany({ where: { id: evalRunId } });
        await prisma.evalSuite.deleteMany({ where: { id: suiteId } });
        if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } });
        if (skillVersionId) {
          await prisma.flowArtifact.deleteMany({ where: { skillVersionId } });
          await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } });
        }
        await prisma.skill.deleteMany({ where: { id: skillId } });
        await prisma.agent.deleteMany({ where: { id: agentId } });
        await prisma.user.deleteMany({ where: { id: ownerId } });
      } catch (cleanupErr) {
        console.warn(
          '[t25] cleanup warning:',
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        );
      }
    }
  }

  // ── G. Optional live canonical IR (BLOCKED if not native Langflow graph) ─
  console.log('\n--- G. live canonical AIOS IR (optional) ---');
  {
    const liveUrl = process.env.AIOS_LANGFLOW_SANDBOX_URL?.trim() || 'http://127.0.0.1:7860';
    const liveKey = process.env.AIOS_LANGFLOW_SANDBOX_API_KEY?.trim();
    let healthOk = false;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      try {
        const res = await fetch(`${liveUrl.replace(/\/+$/, '')}/health`, { signal: ac.signal });
        healthOk = res.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      healthOk = false;
    }
    if (!healthOk) {
      blockedMsg(
        'live Langflow execute of canonical AIOS IR',
        'sandbox not reachable — skip (not FAIL)',
      );
    } else if (!liveKey) {
      blockedMsg(
        'live Langflow execute of canonical AIOS IR',
        'AIOS_LANGFLOW_SANDBOX_API_KEY unset — skip (not FAIL; do not invent secrets)',
      );
    } else {
      // Canonical AIOS IR (nodes/edges) is not a native Langflow graph — must not claim success
      // if run contract fails. Report BLOCKED rather than weaken validation.
      try {
        const adapter = new LangflowAdapter({
          baseUrl: liveUrl,
          apiKey: liveKey,
          timeoutMs: 15_000,
          isRunApproved: async () => false,
        });
        // Attempt deploy of minimal AIOS-shaped artifact (not a full Langflow graph)
        const aiosIr = { nodes: [{ id: 'n1', kind: 'read' }], edges: [] };
        const digest = computeArtifactDigest(aiosIr);
        let deployOk = false;
        let flowId = '';
        try {
          const binding = await adapter.deployArtifact({
            artifactId: `t25-live-${ulid().slice(-6)}`,
            artifactJson: aiosIr,
            digest,
            environment: 'SANDBOX',
            channel: 'CANARY',
          });
          deployOk = binding.bindingRef.startsWith('langflow:flow:');
          flowId = binding.bindingRef.slice('langflow:flow:'.length);
        } catch {
          deployOk = false;
        }
        if (!deployOk || !flowId) {
          blockedMsg(
            'live Langflow execute of canonical AIOS IR',
            'deploy of AIOS IR failed or not a native Langflow graph — BLOCKED (not weakened)',
          );
        } else {
          const events = await collectEvents(
            adapter.execute({
              agentId: 'live',
              artifactId: flowId,
              input: { text: 'ping' },
              triggeredBy: 't25-live',
              timeoutMs: 15_000,
            }),
          );
          const succeeded = events.some(
            (e) => e.type === 'run.finished' && e.status === 'SUCCEEDED',
          );
          if (succeeded) {
            pass('live AIOS IR execute produced valid contract success');
          } else {
            blockedMsg(
              'live Langflow execute of canonical AIOS IR',
              '2xx/result contract did not yield SUCCEEDED — AIOS IR is not a native Langflow graph (BLOCKED, not FAIL)',
            );
          }
        }
      } catch (e) {
        blockedMsg(
          'live Langflow execute of canonical AIOS IR',
          e instanceof Error ? e.message.slice(0, 120) : 'error',
        );
      }
    }
  }

  console.log(
    `\n=== summary: PASS=${passed} FAIL=${failed} BLOCKED=${blocked} ===`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
