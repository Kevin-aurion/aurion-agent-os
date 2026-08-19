/**
 * Ticket 03 — Runtime Adapter Contract (shared assertions for Native + Langflow).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t03-adapter-contract.test.ts
 *
 * Zero new deps. No real DB, no engine spawn, no git.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  computeArtifactDigest,
  isNormalizedRunEvent,
  RuntimeAdapterError,
  type NormalizedRunEvent,
  type RuntimeAdapter,
  type RuntimeHealth,
} from '../../../src/runtime/adapter.js';
import { NativeAdapter } from '../../../src/runtime/native.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';
import type { RunAgentOptions, RunOutcome } from '../../../src/engine/types.js';

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

function isRuntimeHealth(h: unknown): h is RuntimeHealth {
  if (!h || typeof h !== 'object') return false;
  const o = h as Record<string, unknown>;
  return (
    (o['kind'] === 'NATIVE' || o['kind'] === 'LANGFLOW') &&
    typeof o['healthy'] === 'boolean' &&
    typeof o['checkedAt'] === 'string' &&
    (o['latencyMs'] === null || typeof o['latencyMs'] === 'number') &&
    (o['detail'] === null || typeof o['detail'] === 'string')
  );
}

async function collectEvents(
  iter: AsyncIterable<NormalizedRunEvent>,
): Promise<NormalizedRunEvent[]> {
  const out: NormalizedRunEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function isTerminal(e: NormalizedRunEvent): boolean {
  return e.type === 'run.finished' || e.type === 'run.error';
}

type SharedHooks = {
  /** artifact used for validate/deploy digest tests */
  goodArtifact: unknown;
  /** execute input (adapter-specific extras ok) */
  executeInput: {
    agentId: string;
    artifactId?: string;
    input: Record<string, unknown>;
    triggeredBy: string;
    runId?: string;
  };
  /** Build adapter with isRunApproved override for resume tests */
  withIsRunApproved: (
    fn: (runId: string, approvalId?: string | null) => Promise<boolean>,
  ) => RuntimeAdapter;
  /** After true-approved resume: assert side effects */
  assertResumeSuccess: (labelPrefix: string) => void | Promise<void>;
  /** After false-approved resume: assert no side effects (e.g. no HTTP) */
  assertResumeBlocked: (labelPrefix: string) => void | Promise<void>;
  /** Unknown getRun id */
  unknownRunId: string;
};

async function runSharedContract(
  name: string,
  adapter: RuntimeAdapter,
  hooks: SharedHooks,
): Promise<void> {
  const p = `${name}`;

  // 1. kind
  check(
    adapter.kind === name,
    `${p}: kind`,
    `expected ${name}, got ${adapter.kind}`,
  );

  // 2. health bounded + shape
  {
    const t0 = Date.now();
    const h = await adapter.health();
    const elapsed = Date.now() - t0;
    check(isRuntimeHealth(h), `${p}: health shape`, JSON.stringify(h));
    check(h.kind === name, `${p}: health.kind`, `got ${h.kind}`);
    check(elapsed < 10_000, `${p}: health bounded`, `elapsed ${elapsed}ms`);
  }

  // 3. execute stream: first run.started, one terminal, all normalized
  {
    const events = await collectEvents(adapter.execute(hooks.executeInput));
    check(events.length >= 2, `${p}: execute has events`, `len=${events.length}`);
    const first = events[0];
    check(
      first?.type === 'run.started',
      `${p}: execute first is run.started`,
      `got ${first?.type}`,
    );
    const terminals = events.filter(isTerminal);
    check(
      terminals.length === 1,
      `${p}: execute exactly one terminal`,
      `terminals=${terminals.map((t) => t.type).join(',')}`,
    );
    check(
      isTerminal(events[events.length - 1]!),
      `${p}: execute last is terminal`,
      `last=${events[events.length - 1]?.type}`,
    );
    let allNorm = true;
    for (const e of events) {
      if (!isNormalizedRunEvent(e)) {
        allNorm = false;
        fail(`${p}: event normalized`, JSON.stringify(e));
      }
    }
    if (allNorm) pass(`${p}: all events pass isNormalizedRunEvent`);
  }

  // 4. validateArtifact digest tamper
  {
    const good = hooks.goodArtifact;
    const digest = computeArtifactDigest(good);
    const tampered =
      good && typeof good === 'object' && !Array.isArray(good)
        ? { ...(good as Record<string, unknown>), __tamper: true }
        : { x: 1 };
    const result = await adapter.validateArtifact({
      artifactId: 'a1',
      artifactJson: tampered,
      digest,
    });
    check(
      result.valid === false,
      `${p}: validate digest mismatch → valid:false`,
      JSON.stringify(result),
    );
  }

  // 5. deployArtifact digest tamper → VALIDATION_FAILED
  {
    const good = hooks.goodArtifact;
    const digest = computeArtifactDigest(good);
    const tampered =
      good && typeof good === 'object' && !Array.isArray(good)
        ? { ...(good as Record<string, unknown>), __tamper: true }
        : { x: 1 };
    try {
      await adapter.deployArtifact({
        artifactId: 'a1',
        artifactJson: tampered,
        digest,
        environment: 'SANDBOX',
        channel: 'CANARY',
      });
      fail(`${p}: deploy digest mismatch throws`, 'did not throw');
    } catch (err) {
      check(
        err instanceof RuntimeAdapterError && err.code === 'VALIDATION_FAILED',
        `${p}: deploy digest mismatch → VALIDATION_FAILED`,
        err instanceof RuntimeAdapterError
          ? `code=${err.code}`
          : String(err),
      );
    }
  }

  // 6. resumeRun NOT_APPROVED / approved
  {
    const denied = hooks.withIsRunApproved(async () => false);
    try {
      await denied.resumeRun({ runId: 'run-x', approvalRequestId: 'appr-x' });
      fail(`${p}: resume denied throws`, 'did not throw');
    } catch (err) {
      check(
        err instanceof RuntimeAdapterError && err.code === 'NOT_APPROVED',
        `${p}: resume denied → NOT_APPROVED`,
        err instanceof RuntimeAdapterError
          ? `code=${err.code}`
          : String(err),
      );
    }
    await hooks.assertResumeBlocked(p);

    const allowed = hooks.withIsRunApproved(async () => true);
    try {
      await allowed.resumeRun({ runId: 'run-x', approvalRequestId: 'appr-x' });
      pass(`${p}: resume approved succeeds`);
    } catch (err) {
      fail(
        `${p}: resume approved succeeds`,
        err instanceof Error ? err.message : String(err),
      );
    }
    await hooks.assertResumeSuccess(p);
  }

  // 7. getRun unknown → NOT_FOUND
  {
    try {
      await adapter.getRun(hooks.unknownRunId);
      fail(`${p}: getRun unknown throws`, 'did not throw');
    } catch (err) {
      check(
        err instanceof RuntimeAdapterError && err.code === 'NOT_FOUND',
        `${p}: getRun unknown → NOT_FOUND`,
        err instanceof RuntimeAdapterError
          ? `code=${err.code}`
          : String(err),
      );
    }
  }
}

// ─── Native fixtures ─────────────────────────────────────────────────────────

type FakeRun = {
  id: string;
  agentId: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
};

function makeNativeFixture() {
  const runs = new Map<string, FakeRun>();
  let lastRunAgentOpts: RunAgentOptions | null = null;
  let runAgentImpl: (opts: RunAgentOptions) => Promise<RunOutcome> = async (
    opts,
  ) => {
    lastRunAgentOpts = opts;
    const id = opts.runId ?? 'native-run-1';
    return {
      ok: true,
      runId: id,
      runDir: '/tmp/x',
      status: 'SUCCEEDED',
      results: [],
      reworkHistory: [],
    };
  };

  const db = {
    run: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        runs.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: string; finishedAt: Date };
      }) => {
        const r = runs.get(where.id);
        if (!r) throw new Error('missing');
        r.status = data.status;
        r.finishedAt = data.finishedAt;
        return r;
      },
    },
    $queryRaw: async () => [{ '?column?': 1 }],
  };

  // Seed for resume / cancel / getRun tests
  runs.set('run-x', {
    id: 'run-x',
    agentId: 'agent-1',
    status: 'AWAITING_REVIEW',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    finishedAt: null,
  });
  runs.set('run-running', {
    id: 'run-running',
    agentId: 'agent-1',
    status: 'RUNNING',
    startedAt: new Date(),
    finishedAt: null,
  });
  runs.set('run-done', {
    id: 'run-done',
    agentId: 'agent-1',
    status: 'SUCCEEDED',
    startedAt: new Date(),
    finishedAt: new Date(),
  });

  const goodArtifact = { nodes: [], edges: [], name: 'native-flow' };

  function makeAdapter(
    isRunApproved?: (
      runId: string,
      approvalId?: string | null,
    ) => Promise<boolean>,
  ): NativeAdapter {
    return new NativeAdapter({
      runAgent: (opts) => runAgentImpl(opts),
      db,
      isRunApproved: isRunApproved ?? (async () => false),
    });
  }

  return {
    runs,
    db,
    goodArtifact,
    makeAdapter,
    setRunAgentImpl(fn: typeof runAgentImpl) {
      runAgentImpl = fn;
    },
    getLastRunAgentOpts: () => lastRunAgentOpts,
    resetLastRunAgentOpts() {
      lastRunAgentOpts = null;
    },
  };
}

// ─── Langflow mock server ────────────────────────────────────────────────────

type MockHits = {
  resume: number;
  run: number;
  flows: number;
  health: number;
};

async function startLangflowMock(opts?: {
  runDelayMs?: number;
}): Promise<{
  baseUrl: string;
  hits: MockHits;
  close: () => Promise<void>;
  setRunDelayMs: (ms: number) => void;
}> {
  const hits: MockHits = { resume: 0, run: 0, flows: 0, health: 0 };
  let runDelayMs = opts?.runDelayMs ?? 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      hits.health += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (method === 'POST' && (url === '/api/v1/flows/' || url === '/api/v1/flows')) {
      hits.flows += 1;
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'f1' }));
      });
      return;
    }

    if (method === 'POST' && url.startsWith('/api/v1/run/')) {
      hits.run += 1;
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const respond = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          // Ticket 25: valid Langflow contract shape with deliberate wire junk.
          // session_id / wire_only must not leak into NormalizedRunEvent.
          res.end(
            JSON.stringify({
              result: 'ok',
              session_id: 'raw-wire-junk',
              outputs: [
                {
                  wire_only: true,
                  outputs: [{ message: 'ok-result', type: 'text' }],
                },
              ],
            }),
          );
        };
        if (runDelayMs > 0) setTimeout(respond, runDelayMs);
        else respond();
      });
      return;
    }

    if (method === 'POST' && url.startsWith('/api/v1/resume/')) {
      hits.resume += 1;
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
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
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    hits,
    setRunDelayMs(ms: number) {
      runDelayMs = ms;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== t03 adapter contract ===\n');

  // ── Native shared + extras ──
  {
    const fx = makeNativeFixture();
    const adapter = fx.makeAdapter();
    fx.resetLastRunAgentOpts();

    await runSharedContract('NATIVE', adapter, {
      goodArtifact: fx.goodArtifact,
      executeInput: {
        agentId: 'agent-1',
        input: { message: 'hi' },
        triggeredBy: 'test',
      },
      withIsRunApproved: (fn) => {
        fx.resetLastRunAgentOpts();
        return fx.makeAdapter(fn);
      },
      assertResumeBlocked: (p) => {
        check(
          fx.getLastRunAgentOpts() === null,
          `${p}: resume denied zero side effects`,
          'runAgent was called',
        );
      },
      assertResumeSuccess: (p) => {
        const opts = fx.getLastRunAgentOpts();
        check(
          opts?.approvedApprovalId === 'appr-x' &&
            opts?.runId === 'run-x' &&
            opts?.agentId === 'agent-1' &&
            opts?.triggeredBy === 'runtime-adapter-resume',
          `${p}: resume approved calls runAgent with approvedApprovalId`,
          JSON.stringify(opts),
        );
      },
      unknownRunId: 'does-not-exist',
    });

    // Native extras: AWAITING_REVIEW stream
    {
      fx.setRunAgentImpl(async (opts) => ({
        ok: false,
        runId: opts.runId ?? 'r',
        runDir: '/tmp/x',
        status: 'AWAITING_REVIEW',
        results: [],
        reworkHistory: [],
      }));
      const events = await collectEvents(
        fx.makeAdapter().execute({
          agentId: 'agent-1',
          input: {},
          triggeredBy: 'test',
          runId: 'await-1',
        }),
      );
      const types = events.map((e) => e.type);
      check(
        types.includes('approval.required') &&
          types[types.length - 1] === 'run.finished' &&
          events.some(
            (e) =>
              e.type === 'run.finished' && e.status === 'AWAITING_REVIEW',
          ),
        'NATIVE: AWAITING_REVIEW yields approval.required then run.finished',
        types.join(','),
      );
      check(
        events.every(isNormalizedRunEvent),
        'NATIVE: AWAITING_REVIEW events normalized',
        '',
      );
    }

    // Native extras: runAgent throw → run.error, generator no throw
    {
      fx.setRunAgentImpl(async () => {
        throw new Error('boom sk-testsecret12345678');
      });
      let threw = false;
      let events: NormalizedRunEvent[] = [];
      try {
        events = await collectEvents(
          fx.makeAdapter().execute({
            agentId: 'agent-1',
            input: {},
            triggeredBy: 'test',
            runId: 'err-1',
          }),
        );
      } catch {
        threw = true;
      }
      check(!threw, 'NATIVE: runAgent throw does not escape generator', '');
      const last = events[events.length - 1];
      check(
        last?.type === 'run.error' && last.code === 'INTERNAL',
        'NATIVE: runAgent throw → run.error INTERNAL',
        JSON.stringify(last),
      );
      check(
        events.every(isNormalizedRunEvent),
        'NATIVE: error stream normalized',
        '',
      );
    }

    // Native extras: cancel RUNNING → CANCELLED; SUCCEEDED idempotent
    {
      const a = fx.makeAdapter();
      await a.cancelRun('run-running');
      const r = fx.runs.get('run-running');
      check(
        r?.status === 'CANCELLED' && r.finishedAt != null,
        'NATIVE: cancelRun RUNNING → CANCELLED',
        JSON.stringify(r),
      );
      const before = { ...fx.runs.get('run-done')! };
      await a.cancelRun('run-done');
      const after = fx.runs.get('run-done')!;
      check(
        after.status === before.status &&
          String(after.finishedAt) === String(before.finishedAt),
        'NATIVE: cancelRun SUCCEEDED is idempotent',
        JSON.stringify(after),
      );
    }

    // Native validate positive
    {
      const digest = computeArtifactDigest(fx.goodArtifact);
      const v = await fx.makeAdapter().validateArtifact({
        artifactId: 'a1',
        artifactJson: fx.goodArtifact,
        digest,
      });
      check(v.valid === true && v.errors.length === 0, 'NATIVE: validate positive', JSON.stringify(v));
    }
  }

  // ── Langflow shared + extras ──
  {
    const mock = await startLangflowMock();
    try {
      let resumeHitsBeforeDenied = 0;
      const goodArtifact = {
        nodes: [{ id: 'n1' }],
        edges: [],
        data: { v: 1 },
      };

      // Ticket 23: control-plane test key (not a provider credential). Mock accepts any key.
      const TEST_API_KEY = 'sk-test-t03-langflow-control-plane-not-real';
      const makeLf = (
        isRunApproved?: (
          runId: string,
          approvalId?: string | null,
        ) => Promise<boolean>,
      ) =>
        new LangflowAdapter({
          baseUrl: mock.baseUrl,
          apiKey: TEST_API_KEY,
          timeoutMs: 5000,
          isRunApproved: isRunApproved ?? (async () => false),
        });

      const adapter = makeLf();

      await runSharedContract('LANGFLOW', adapter, {
        goodArtifact,
        executeInput: {
          agentId: 'agent-1',
          artifactId: 'flow-1',
          input: { message: 'hi' },
          triggeredBy: 'test',
        },
        withIsRunApproved: (fn) => {
          if (fn.toString().includes('false') || true) {
            // capture hits before denied path is handled inside shared
          }
          resumeHitsBeforeDenied = mock.hits.resume;
          return makeLf(fn);
        },
        assertResumeBlocked: (p) => {
          // denied path must not increment resume hits beyond snapshot
          // Shared calls denied first then allowed; snapshot is taken at withIsRunApproved
          // for denied adapter construction. After denied, hits should equal snapshot.
          // After allowed, hits increase — assert blocked only on denied delta.
          // Re-check: shared calls withIsRunApproved(false) then resume, then assertResumeBlocked,
          // then withIsRunApproved(true), resume, assertResumeSuccess.
          // So at assertResumeBlocked, only denied resume attempted → hits should still equal
          // resumeHitsBeforeDenied (set when building denied adapter, before resume call).
          // Wait — withIsRunApproved is called, then resume is called, then assertResumeBlocked.
          // So hits may have increased if denied still hit server — they must NOT.
          check(
            mock.hits.resume === resumeHitsBeforeDenied,
            `${p}: resume denied sends no HTTP`,
            `hits.resume=${mock.hits.resume} before=${resumeHitsBeforeDenied}`,
          );
        },
        assertResumeSuccess: (p) => {
          check(
            mock.hits.resume >= resumeHitsBeforeDenied + 1,
            `${p}: resume approved hits mock resume endpoint`,
            `hits.resume=${mock.hits.resume}`,
          );
        },
        unknownRunId: 'no-such-langflow-run',
      });

      // deploy positive bindingRef prefix
      {
        const digest = computeArtifactDigest(goodArtifact);
        const binding = await makeLf().deployArtifact({
          artifactId: 'art-1',
          artifactJson: goodArtifact,
          digest,
          environment: 'SANDBOX',
          channel: 'CANARY',
        });
        check(
          binding.kind === 'LANGFLOW' &&
            binding.bindingRef.startsWith('langflow:flow:'),
          'LANGFLOW: deploy bindingRef prefix langflow:flow:',
          binding.bindingRef,
        );
      }

      // wire fields must not appear in events (session_id / outputs)
      {
        const events = await collectEvents(
          makeLf().execute({
            agentId: 'a',
            artifactId: 'flow-1',
            input: {},
            triggeredBy: 't',
          }),
        );
        const blob = JSON.stringify(events);
        check(
          !blob.includes('session_id') &&
            !blob.includes('raw-wire-junk') &&
            !blob.includes('wire_only'),
          'LANGFLOW: wire fields do not leak into events',
          blob,
        );
        check(
          events.every(isNormalizedRunEvent),
          'LANGFLOW: success events normalized',
          '',
        );
      }

      // cancel during slow run
      {
        mock.setRunDelayMs(5000);
        const slow = makeLf();
        const runId = 'cancel-me';
        const t0 = Date.now();
        const execPromise = collectEvents(
          slow.execute({
            runId,
            agentId: 'a',
            artifactId: 'flow-1',
            input: {},
            triggeredBy: 't',
            timeoutMs: 10_000,
          }),
        );
        await new Promise((r) => setTimeout(r, 300));
        await slow.cancelRun(runId);
        const events = await execPromise;
        const elapsed = Date.now() - t0;
        const last = events[events.length - 1];
        check(
          last?.type === 'run.finished' && last.status === 'CANCELLED',
          'LANGFLOW: cancelRun mid-execute → run.finished CANCELLED',
          JSON.stringify(last),
        );
        check(elapsed < 2000, 'LANGFLOW: cancel completes < 2s', `elapsed=${elapsed}ms`);
        mock.setRunDelayMs(0);
      }
    } finally {
      await mock.close();
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
