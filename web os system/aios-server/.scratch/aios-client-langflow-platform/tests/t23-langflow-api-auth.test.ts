/**
 * Ticket 23 — Langflow Production Flow API authentication (x-api-key).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t23-langflow-api-auth.test.ts
 *
 * Covers:
 * - Constructor fail-closed: missing / blank / CRLF / control-char / oversized key → zero network
 * - Shared HTTP helper attaches identical x-api-key on health / deploy / execute / resume
 * - Secret reflection redaction (error body echo of key must not leak)
 * - resolveRuntimeAdapter('LANGFLOW', 'PRODUCTION') requires URL + AIOS_LANGFLOW_PRODUCTION_API_KEY fail-closed
 *
 * Zero new deps. No real secrets. Does not modify .env or migrations.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { computeArtifactDigest, RuntimeAdapterError } from '../../../src/runtime/adapter.js';
import {
  LANGFLOW_API_KEY_MAX_LEN,
  LangflowAdapter,
  normalizeLangflowApiKey,
} from '../../../src/runtime/langflow.js';
import { resolveRuntimeAdapter } from '../../../src/lib/runtimedeployment.js';
import { ApiError } from '../../../src/lib/http.js';

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

/** Deterministic test key (sk- pattern so generic redactor also covers it). Not a real secret. */
const TEST_API_KEY = 'sk-test-t23-langflow-control-plane-not-real-abcdef';

type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
};

async function startAuthMock(opts?: {
  /** When true, non-2xx body deliberately echoes the received x-api-key. */
  echoKeyOnError?: boolean;
  requireKey?: string;
}): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
  networkCallCount: () => number;
}> {
  const requests: RecordedRequest[] = [];
  const requireKey = opts?.requireKey ?? TEST_API_KEY;
  const echoKeyOnError = opts?.echoKeyOnError ?? false;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const headers: RecordedRequest['headers'] = {
      'x-api-key': req.headers['x-api-key'],
      accept: req.headers['accept'],
      'content-type': req.headers['content-type'],
    };
    requests.push({ method, url, headers });

    const receivedKey = String(req.headers['x-api-key'] ?? '');
    const authorized = receivedKey === requireKey;

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

    if (method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      // Mirror production: health may be open; still record header for adapter contract.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (method === 'POST' && (url === '/api/v1/flows/' || url === '/api/v1/flows')) {
      drain(() => {
        if (!authorized) {
          const msg = echoKeyOnError
            ? `forbidden: invalid key ${receivedKey || '(missing)'}`
            : 'forbidden';
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: msg }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'flow-t23-1' }));
      });
      return;
    }

    if (method === 'POST' && url.startsWith('/api/v1/run/')) {
      drain(() => {
        if (!authorized) {
          const msg = echoKeyOnError
            ? `unauthorized key=${receivedKey}`
            : 'unauthorized';
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: msg }));
          return;
        }
        // Ticket 25: valid effective-output shape so execute can succeed when authorized.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            session_id: 't23',
            outputs: [{ outputs: [{ ok: true }] }],
          }),
        );
      });
      return;
    }

    if (method === 'POST' && url.startsWith('/api/v1/resume/')) {
      drain(() => {
        if (!authorized) {
          const msg = echoKeyOnError
            ? `not allowed: ${receivedKey}`
            : 'not allowed';
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: msg }));
          return;
        }
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
    requests,
    networkCallCount: () => requests.length,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function collectEvents(
  iter: AsyncIterable<unknown>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function envSnapshot(
  keys: string[],
): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(
  snap: Record<string, string | undefined>,
): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function main(): Promise<void> {
  console.log('=== t23 langflow API auth ===\n');

  // ── A. normalizeLangflowApiKey pure fail-closed ──────────────────────────
  console.log('--- A. normalizeLangflowApiKey ---');

  {
    try {
      const out = normalizeLangflowApiKey(`  ${TEST_API_KEY}  `);
      check(out === TEST_API_KEY, 'normalize trims whitespace', `got ${JSON.stringify(out)}`);
    } catch (e) {
      fail('normalize trims whitespace', e instanceof Error ? e.message : String(e));
    }
  }

  const badKeys: Array<{ label: string; value: unknown }> = [
    { label: 'missing (undefined)', value: undefined },
    { label: 'null', value: null },
    { label: 'blank empty string', value: '' },
    { label: 'blank whitespace only', value: '   \t  ' },
    { label: 'CRLF key', value: `good-key\r\ninjected` },
    { label: 'LF only', value: `good\nkey` },
    { label: 'NUL control', value: `good\u0000key` },
    { label: 'DEL control', value: `good\u007fkey` },
    // C1 controls U+0080–U+009F + Unicode line/paragraph separators
    { label: 'C1 PAD U+0080', value: `good\u0080key` },
    { label: 'C1 CSI U+009B', value: `good\u009Bkey` },
    { label: 'line separator U+2028', value: `good\u2028key` },
    { label: 'paragraph separator U+2029', value: `good\u2029key` },
    { label: 'oversized', value: 'k'.repeat(LANGFLOW_API_KEY_MAX_LEN + 1) },
    { label: 'number', value: 12345 },
  ];

  for (const { label, value } of badKeys) {
    let threw = false;
    let code: string | undefined;
    let msg = '';
    try {
      normalizeLangflowApiKey(value);
    } catch (e) {
      threw = true;
      if (e instanceof RuntimeAdapterError) {
        code = e.code;
        msg = e.message;
      } else {
        msg = e instanceof Error ? e.message : String(e);
      }
    }
    check(
      threw && code === 'VALIDATION_FAILED',
      `normalize rejects ${label}`,
      `threw=${threw} code=${code} msg=${msg}`,
    );
    // Must never echo the bad key material (esp. CRLF payloads) into the error.
    if (typeof value === 'string' && value.length > 0 && value.includes('\r')) {
      check(
        !msg.includes('\r') && !msg.includes(value),
        `normalize ${label}: error does not reflect raw key`,
        msg,
      );
    }
  }

  // ── B. Constructor fail-closed + zero network ────────────────────────────
  console.log('\n--- B. constructor fail-closed (zero network) ---');

  {
    const mock = await startAuthMock();
    try {
      const cases: Array<{ label: string; apiKey: unknown }> = [
        { label: 'missing apiKey field', apiKey: undefined },
        { label: 'blank apiKey', apiKey: '' },
        { label: 'whitespace apiKey', apiKey: '  \n  ' },
        { label: 'CRLF apiKey', apiKey: 'abc\r\ndef' },
      ];

      for (const c of cases) {
        const before = mock.networkCallCount();
        let threw = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          new LangflowAdapter({
            baseUrl: mock.baseUrl,
            apiKey: c.apiKey as string,
          } as { baseUrl: string; apiKey: string });
        } catch {
          threw = true;
        }
        const after = mock.networkCallCount();
        check(threw, `construct rejects ${c.label}`, 'did not throw');
        check(
          after === before,
          `construct ${c.label}: zero network call`,
          `before=${before} after=${after}`,
        );
      }

      // Valid construct does not call network until first method.
      const beforeOk = mock.networkCallCount();
      const adapter = new LangflowAdapter({
        baseUrl: mock.baseUrl,
        apiKey: TEST_API_KEY,
        isRunApproved: async () => true,
      });
      check(
        mock.networkCallCount() === beforeOk,
        'valid construct: zero network until use',
        `calls=${mock.networkCallCount() - beforeOk}`,
      );
      void adapter;
    } finally {
      await mock.close();
    }
  }

  // ── C. Header propagation on shared HTTP paths ───────────────────────────
  console.log('\n--- C. x-api-key header on health/deploy/execute/resume ---');

  {
    const mock = await startAuthMock({ requireKey: TEST_API_KEY });
    try {
      const adapter = new LangflowAdapter({
        baseUrl: mock.baseUrl,
        apiKey: `  ${TEST_API_KEY}  `, // must trim before send
        timeoutMs: 5000,
        isRunApproved: async () => true,
      });

      const goodArtifact = { nodes: [{ id: 'n1' }], edges: [] };
      const digest = computeArtifactDigest(goodArtifact);

      await adapter.health();
      await adapter.deployArtifact({
        artifactId: 'art-t23',
        artifactJson: goodArtifact,
        digest,
        environment: 'SANDBOX',
        channel: 'CANARY',
      });
      await collectEvents(
        adapter.execute({
          agentId: 'a',
          artifactId: 'flow-t23-1',
          input: { m: 1 },
          triggeredBy: 't23',
          runId: 'run-t23-header',
        }),
      );
      await adapter.resumeRun({
        runId: 'run-t23-header',
        approvalRequestId: 'appr-t23',
      });

      const paths = mock.requests.map((r) => `${r.method} ${r.url.split('?')[0]}`);
      check(
        mock.requests.some((r) => r.method === 'GET' && r.url.startsWith('/health')),
        'health issued HTTP GET /health',
        paths.join(', '),
      );
      check(
        mock.requests.some(
          (r) =>
            r.method === 'POST' &&
            (r.url === '/api/v1/flows/' || r.url === '/api/v1/flows'),
        ),
        'deploy issued POST /api/v1/flows/',
        paths.join(', '),
      );
      check(
        mock.requests.some((r) => r.method === 'POST' && r.url.startsWith('/api/v1/run/')),
        'execute issued POST /api/v1/run/',
        paths.join(', '),
      );
      check(
        mock.requests.some((r) => r.method === 'POST' && r.url.startsWith('/api/v1/resume/')),
        'resume issued POST /api/v1/resume/',
        paths.join(', '),
      );

      let allHaveKey = true;
      let allMatch = true;
      for (const r of mock.requests) {
        const k = r.headers['x-api-key'];
        const val = Array.isArray(k) ? k[0] : k;
        if (val == null || val === '') allHaveKey = false;
        if (val !== TEST_API_KEY) allMatch = false;
      }
      check(
        mock.requests.length >= 4 && allHaveKey,
        'every request carries x-api-key header',
        `count=${mock.requests.length} allHaveKey=${allHaveKey}`,
      );
      check(
        allMatch,
        'every x-api-key equals trimmed control-plane key',
        JSON.stringify(
          mock.requests.map((r) => r.headers['x-api-key']),
        ),
      );
    } finally {
      await mock.close();
    }
  }

  // ── D. Secret reflection redaction ───────────────────────────────────────
  console.log('\n--- D. secret reflection redaction ---');

  {
    // Use a key that is unique and present in error body when echoKeyOnError.
    const secretKey = 'sk-test-t23-reflect-secret-key-zzzz9999';
    const mock = await startAuthMock({
      requireKey: 'different-expected-key-not-matching',
      echoKeyOnError: true,
    });
    try {
      const adapter = new LangflowAdapter({
        baseUrl: mock.baseUrl,
        apiKey: secretKey,
        timeoutMs: 5000,
        isRunApproved: async () => true,
      });
      const goodArtifact = { nodes: [], edges: [] };
      const digest = computeArtifactDigest(goodArtifact);

      let deployMsg = '';
      try {
        await adapter.deployArtifact({
          artifactId: 'art-reflect',
          artifactJson: goodArtifact,
          digest,
          environment: 'SANDBOX',
          channel: 'CANARY',
        });
        fail('deploy with wrong-auth mock throws', 'did not throw');
      } catch (e) {
        deployMsg = e instanceof Error ? e.message : String(e);
        check(
          e instanceof RuntimeAdapterError,
          'deploy auth failure is RuntimeAdapterError',
          String(e),
        );
      }

      check(
        !deployMsg.includes(secretKey),
        'deploy error does not leak apiKey (reflection redacted)',
        deployMsg,
      );
      check(
        deployMsg.includes('[REDACTED_API_KEY]') ||
          deployMsg.includes('HTTP 403'),
        'deploy error is redacted/status-safe',
        deployMsg,
      );

      const events = await collectEvents(
        adapter.execute({
          agentId: 'a',
          artifactId: 'f',
          input: {},
          triggeredBy: 't',
          runId: 'run-reflect',
        }),
      );
      const blob = JSON.stringify(events);
      check(
        !blob.includes(secretKey),
        'execute events do not leak apiKey',
        blob.slice(0, 400),
      );

      try {
        await adapter.resumeRun({
          runId: 'run-reflect',
          approvalRequestId: 'appr',
        });
        fail('resume with wrong-auth mock throws', 'did not throw');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        check(
          !msg.includes(secretKey),
          'resume error does not leak apiKey',
          msg,
        );
      }
    } finally {
      await mock.close();
    }
  }

  // ── E. resolveRuntimeAdapter production fail-closed ──────────────────────
  // Ticket 25: environment must be explicit (PRODUCTION); no implicit default.
  console.log('\n--- E. resolveRuntimeAdapter fail-closed ---');

  {
    const keys = [
      'AIOS_LANGFLOW_RUNTIME_URL',
      'AIOS_LANGFLOW_PRODUCTION_API_KEY',
    ];
    const snap = envSnapshot(keys);

    try {
      // Missing environment entirely
      process.env.AIOS_LANGFLOW_RUNTIME_URL = 'http://127.0.0.1:7861';
      process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY = TEST_API_KEY;
      {
        let threw = false;
        try {
          resolveRuntimeAdapter('LANGFLOW');
        } catch {
          threw = true;
        }
        check(threw, 'resolver missing environment → fail-closed', 'did not throw');
      }

      // Missing URL
      delete process.env.AIOS_LANGFLOW_RUNTIME_URL;
      process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY = TEST_API_KEY;
      let threw = false;
      let err: unknown;
      try {
        resolveRuntimeAdapter('LANGFLOW', 'PRODUCTION');
      } catch (e) {
        threw = true;
        err = e;
      }
      check(
        threw &&
          err instanceof ApiError &&
          err.statusCode === 409 &&
          !String(err.message).includes(TEST_API_KEY),
        'resolver missing URL → conflict fail-closed, no key leak',
        err instanceof Error ? err.message : String(err),
      );

      // Missing API key
      process.env.AIOS_LANGFLOW_RUNTIME_URL = 'http://127.0.0.1:7861';
      delete process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY;
      threw = false;
      err = undefined;
      try {
        resolveRuntimeAdapter('LANGFLOW', 'PRODUCTION');
      } catch (e) {
        threw = true;
        err = e;
      }
      check(
        threw &&
          err instanceof ApiError &&
          err.statusCode === 409 &&
          /API key|fail-closed/i.test(String((err as Error).message)),
        'resolver missing AIOS_LANGFLOW_PRODUCTION_API_KEY → conflict fail-closed',
        err instanceof Error ? err.message : String(err),
      );

      // Blank API key
      process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY = '   ';
      threw = false;
      try {
        resolveRuntimeAdapter('LANGFLOW', 'PRODUCTION');
      } catch {
        threw = true;
      }
      check(threw, 'resolver blank API key → fail-closed', 'did not throw');

      // Both present + explicit PRODUCTION → constructs (no network)
      process.env.AIOS_LANGFLOW_RUNTIME_URL = 'http://127.0.0.1:7861';
      process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY = TEST_API_KEY;
      try {
        const adapter = resolveRuntimeAdapter('LANGFLOW', 'PRODUCTION');
        check(
          adapter.kind === 'LANGFLOW',
          'resolver with URL+key returns LANGFLOW adapter',
          `kind=${adapter.kind}`,
        );
      } catch (e) {
        fail(
          'resolver with URL+key returns LANGFLOW adapter',
          e instanceof Error ? e.message : String(e),
        );
      }
    } finally {
      restoreEnv(snap);
    }
  }

  // ── F. Optional live production probe (never fake-pass) ──────────────────
  console.log('\n--- F. live production (optional) ---');
  {
    const liveUrl =
      process.env.AIOS_LANGFLOW_RUNTIME_URL?.trim() || 'http://127.0.0.1:7861';
    const liveKey = process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY?.trim();

    let healthOk = false;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      try {
        const res = await fetch(`${liveUrl.replace(/\/+$/, '')}/health`, {
          signal: ac.signal,
        });
        healthOk = res.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      healthOk = false;
    }

    if (!healthOk) {
      blockedMsg(
        'live production Flow API auth',
        'production runtime not reachable on /health — skip 403/2xx contrast (not FAIL)',
      );
    } else if (!liveKey) {
      blockedMsg(
        'live production Flow API auth',
        'AIOS_LANGFLOW_PRODUCTION_API_KEY unset in process env — skip live key probe (not FAIL; do not invent secrets)',
      );
    } else {
      try {
        const base = liveUrl.replace(/\/+$/, '');
        const noKey = await fetch(`${base}/api/v1/flows/`, {
          method: 'GET',
        });
        check(
          noKey.status === 403 || noKey.status === 401,
          'live Flow API without header → 401/403',
          `HTTP ${noKey.status}`,
        );

        const withKey = await fetch(`${base}/api/v1/flows/`, {
          method: 'GET',
          headers: { 'x-api-key': liveKey },
        });
        check(
          withKey.status >= 200 && withKey.status < 300,
          'live Flow API with x-api-key → 2xx',
          `HTTP ${withKey.status}`,
        );
        // Never print liveKey
      } catch (e) {
        fail(
          'live Flow API auth contrast',
          e instanceof Error ? e.message : String(e),
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
