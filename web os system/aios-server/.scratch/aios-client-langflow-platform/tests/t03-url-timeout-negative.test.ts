/**
 * Ticket 03 — LangflowAdapter URL / timeout / outage negative tests.
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t03-url-timeout-negative.test.ts
 *
 * Zero new deps. No docker compose up. Live section may BLOCKED.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RuntimeAdapterError } from '../../../src/runtime/adapter.js';
import { LangflowAdapter } from '../../../src/runtime/langflow.js';
import type { NormalizedRunEvent } from '../../../src/runtime/adapter.js';

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

async function collectEvents(
  iter: AsyncIterable<NormalizedRunEvent>,
): Promise<NormalizedRunEvent[]> {
  const out: NormalizedRunEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

/** Bind ephemeral 127.0.0.1 port then close — leaves a dead address. */
async function ephemeralDeadPort(): Promise<{ host: string; port: number; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  // Give OS a moment to release
  await new Promise((r) => setTimeout(r, 50));
  return {
    host: '127.0.0.1',
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
  };
}

async function main(): Promise<void> {
  console.log('=== t03 url/timeout negative ===\n');

  // Ticket 23: control-plane test key required by LangflowAdapter (not a provider credential).
  const TEST_API_KEY = 'sk-test-t03-langflow-control-plane-not-real';

  // ── A. Deterministic URL fail-closed at construct ──────────────────────────
  console.log('--- A. URL construction ---');

  const rejectUrls = [
    'http://10.0.0.0:7860',
    'http://127.0.0.1.evil.com:7860',
    'http://0.0.0.0:7860',
    'http://localhost.evil.com:7860',
    'ftp://127.0.0.1:7860',
    'http://192.168.1.10:7860',
    '',
  ];

  for (const url of rejectUrls) {
    let threw = false;
    try {
      new LangflowAdapter({ baseUrl: url, apiKey: TEST_API_KEY });
    } catch {
      threw = true;
    }
    check(threw, `construct rejects ${JSON.stringify(url)}`, 'did not throw');
  }

  const acceptUrls = [
    'http://127.0.0.1:7860',
    'http://localhost:7860',
    'http://[::1]:7860',
  ];

  for (const url of acceptUrls) {
    let threw = false;
    try {
      new LangflowAdapter({
        baseUrl: url,
        apiKey: TEST_API_KEY,
        isRunApproved: async () => false,
      });
    } catch (err) {
      threw = true;
      fail(
        `construct accepts ${JSON.stringify(url)}`,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!threw) pass(`construct accepts ${JSON.stringify(url)}`);
  }

  // ── B. Downtime / timeout bounded ─────────────────────────────────────────
  console.log('\n--- B. timeout / outage ---');

  // B1. dead port health
  {
    const dead = await ephemeralDeadPort();
    const adapter = new LangflowAdapter({
      baseUrl: dead.url,
      apiKey: TEST_API_KEY,
      timeoutMs: 1000,
      isRunApproved: async () => false,
    });
    const t0 = Date.now();
    let threw = false;
    let h;
    try {
      h = await adapter.health();
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - t0;
    check(!threw, 'B1 health never throws', 'threw');
    check(h?.healthy === false, 'B1 health healthy:false', JSON.stringify(h));
    check(
      elapsed < 1000 + 2000,
      'B1 health elapsed < timeoutMs+2s',
      `elapsed=${elapsed}ms`,
    );
  }

  // B2. dead port execute → run.error RUNTIME_UNREACHABLE
  {
    const dead = await ephemeralDeadPort();
    const adapter = new LangflowAdapter({
      baseUrl: dead.url,
      apiKey: TEST_API_KEY,
      timeoutMs: 1000,
      isRunApproved: async () => false,
    });
    const t0 = Date.now();
    let threw = false;
    let events: NormalizedRunEvent[] = [];
    try {
      events = await collectEvents(
        adapter.execute({
          agentId: 'a',
          artifactId: 'f',
          input: {},
          triggeredBy: 't',
        }),
      );
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - t0;
    const last = events[events.length - 1];
    check(!threw, 'B2 execute does not throw out of generator', 'threw');
    check(
      last?.type === 'run.error' && last.code === 'RUNTIME_UNREACHABLE',
      'B2 execute terminal RUNTIME_UNREACHABLE',
      JSON.stringify(last),
    );
    check(
      elapsed < 1000 + 2000,
      'B2 execute bounded',
      `elapsed=${elapsed}ms`,
    );
  }

  // B3. black hole (no response) → TIMEOUT ~1s
  {
    const server = http.createServer((_req, _res) => {
      // intentionally never respond
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const adapter = new LangflowAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: TEST_API_KEY,
      timeoutMs: 1000,
      isRunApproved: async () => false,
    });
    const t0 = Date.now();
    let events: NormalizedRunEvent[] = [];
    try {
      events = await collectEvents(
        adapter.execute({
          agentId: 'a',
          artifactId: 'f',
          input: {},
          triggeredBy: 't',
          timeoutMs: 1000,
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const elapsed = Date.now() - t0;
    const last = events[events.length - 1];
    check(
      last?.type === 'run.error' && last.code === 'TIMEOUT',
      'B3 black hole → run.error TIMEOUT',
      JSON.stringify(last),
    );
    check(
      elapsed >= 800 && elapsed < 3000,
      'B3 TIMEOUT elapsed ~1s and <3s',
      `elapsed=${elapsed}ms`,
    );
  }

  // B4. mid-run socket.destroy → RUNTIME_UNREACHABLE
  {
    const server = http.createServer((req, res) => {
      // destroy after headers partially accepted
      req.on('data', () => {});
      req.on('end', () => {
        res.socket?.destroy();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const adapter = new LangflowAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: TEST_API_KEY,
      timeoutMs: 3000,
      isRunApproved: async () => false,
    });
    const t0 = Date.now();
    let events: NormalizedRunEvent[] = [];
    try {
      events = await collectEvents(
        adapter.execute({
          agentId: 'a',
          artifactId: 'f',
          input: {},
          triggeredBy: 't',
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const elapsed = Date.now() - t0;
    const last = events[events.length - 1];
    check(
      last?.type === 'run.error' && last.code === 'RUNTIME_UNREACHABLE',
      'B4 mid-run destroy → RUNTIME_UNREACHABLE',
      JSON.stringify(last),
    );
    check(elapsed < 5000, 'B4 mid-run destroy bounded', `elapsed=${elapsed}ms`);
  }

  // ── C. Live optional ──────────────────────────────────────────────────────
  console.log('\n--- C. live (optional) ---');
  {
    const liveUrl = 'http://127.0.0.1:7860';
    let reachable = false;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3000);
      try {
        const res = await fetch(`${liveUrl}/health`, { signal: ac.signal });
        reachable = res.ok || res.status < 500;
      } finally {
        clearTimeout(t);
      }
    } catch {
      reachable = false;
    }

    if (!reachable) {
      blockedMsg('live: langflow sandbox not running', 'skip real health (not FAIL)');
    } else {
      try {
        const adapter = new LangflowAdapter({
          baseUrl: liveUrl,
          apiKey: TEST_API_KEY,
          timeoutMs: 5000,
          isRunApproved: async () => false,
        });
        const h = await adapter.health();
        check(
          h.healthy === true && h.kind === 'LANGFLOW',
          'live health healthy:true',
          JSON.stringify(h),
        );
      } catch (err) {
        fail(
          'live health',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // silence unused import warning path for RuntimeAdapterError in some branches
  void RuntimeAdapterError;

  console.log(
    `\n=== summary: PASS=${passed} FAIL=${failed} BLOCKED=${blocked} ===`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
