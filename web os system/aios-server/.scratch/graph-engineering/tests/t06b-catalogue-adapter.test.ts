/**
 * Catalogue adapter unit tests (size/time limits, fail-closed).
 * Run: npx tsx .scratch/graph-engineering/tests/t06b-catalogue-adapter.test.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  LANGFLOW_CATALOGUE_MAX_RESPONSE_BYTES,
  LangflowAdapter,
} from '../../../src/runtime/langflow.js';
import { RuntimeAdapterError } from '../../../src/runtime/adapter.js';
import { check, fail, pass, resetCounters, summary } from './helpers.js';

const KEY = 'sandbox-flow-api-key-not-production-local-only-v1';

async function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function main(): Promise<void> {
  resetCounters();
  console.log('── t06b-catalogue-adapter ──');

  // Happy path catalogue
  {
    const mock = await startMock((req, res) => {
      if (req.url?.startsWith('/api/v1/all')) {
        const key = req.headers['x-api-key'];
        if (key !== KEY) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            input_output: {
              ChatInput: {
                display_name: 'Chat Input',
                template: { _type: 'Component', code: { type: 'code', value: 'pass' } },
                outputs: [{ name: 'message', types: ['Message'] }],
              },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const adapter = new LangflowAdapter({ baseUrl: mock.baseUrl, apiKey: KEY });
      const cat = await adapter.fetchComponentCatalogue();
      check(
        cat !== null &&
          typeof cat === 'object' &&
          (cat as { input_output?: unknown }).input_output !== undefined,
        'catalogue fetch ok',
        '',
      );
    } finally {
      await mock.close();
    }
  }

  // Oversize fail-closed
  {
    const mock = await startMock((req, res) => {
      if (req.url?.startsWith('/api/v1/all')) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(LANGFLOW_CATALOGUE_MAX_RESPONSE_BYTES + 10),
        });
        // Don't actually send huge body if content-length triggers early
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const adapter = new LangflowAdapter({ baseUrl: mock.baseUrl, apiKey: KEY });
      let threw = false;
      try {
        await adapter.fetchComponentCatalogue({ maxBytes: 100 });
      } catch (e) {
        threw = e instanceof RuntimeAdapterError;
      }
      // content-length > max should fail before/during read
      check(threw, 'oversize catalogue fail-closed', '');
    } finally {
      await mock.close();
    }
  }

  // Non-object JSON fail-closed
  {
    const mock = await startMock((req, res) => {
      if (req.url?.startsWith('/api/v1/all')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const adapter = new LangflowAdapter({ baseUrl: mock.baseUrl, apiKey: KEY });
      let code: string | null = null;
      try {
        await adapter.fetchComponentCatalogue();
      } catch (e) {
        if (e instanceof RuntimeAdapterError) code = e.code;
      }
      check(code === 'VALIDATION_FAILED', 'array catalogue rejected', String(code));
    } finally {
      await mock.close();
    }
  }

  summary('t06b-catalogue-adapter');
}

main().catch((e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t06b-catalogue-adapter');
  process.exit(1);
});
