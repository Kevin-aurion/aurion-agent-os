/**
 * T06 — Live Langflow Sandbox: compile echo graph, create/run/delete by exact id.
 * Run: npx tsx .scratch/graph-engineering/tests/t06-live-sandbox.test.ts
 *
 * If sandbox is absent → BLOCKED (never weaken assertions / fake pass).
 */
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileGraphToLangflow } from '../../../src/graph/compile-langflow.js';
import { LangflowAdapter, parseSafeLangflowFlowId } from '../../../src/runtime/langflow.js';
import {
  blockedMsg,
  check,
  echoGraph,
  fail,
  pass,
  resetCounters,
  summary,
} from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// web os system/.env
loadDotenv({ path: resolve(__dirname, '../../../../.env') });
loadDotenv({ path: resolve(__dirname, '../../../.env') });

const SANDBOX_URL =
  process.env.AIOS_LANGFLOW_SANDBOX_URL?.trim() || 'http://127.0.0.1:7860';
const SANDBOX_KEY =
  process.env.AIOS_LANGFLOW_SANDBOX_API_KEY?.trim() ||
  'sandbox-flow-api-key-not-production-local-only-v1';

function extractOutputText(results: unknown[]): string | null {
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    // Common shapes from normalizeLangflowRunResponse
    if (typeof rec.text === 'string') return rec.text;
    const message = rec.message;
    if (message && typeof message === 'object') {
      const m = message as Record<string, unknown>;
      if (typeof m.text === 'string') return m.text;
      const data = m.data;
      if (data && typeof data === 'object' && typeof (data as { text?: string }).text === 'string') {
        return (data as { text: string }).text;
      }
    }
    const resultsObj = rec.results;
    if (resultsObj && typeof resultsObj === 'object') {
      const msg = (resultsObj as { message?: unknown }).message;
      if (msg && typeof msg === 'object') {
        const data = (msg as { data?: { text?: string }; text?: string }).data;
        if (data && typeof data.text === 'string') return data.text;
        if (typeof (msg as { text?: string }).text === 'string') {
          return (msg as { text: string }).text;
        }
      }
    }
  }
  // Fallback: stringify search
  const blob = JSON.stringify(results);
  return blob.includes('hello-aios-graph-echo') ? 'hello-aios-graph-echo' : null;
}

async function main(): Promise<void> {
  resetCounters();
  console.log('── t06-live-sandbox ──');

  // Health probe
  let healthy = false;
  try {
    const res = await fetch(`${SANDBOX_URL.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    healthy = res.ok;
  } catch {
    healthy = false;
  }

  if (!healthy) {
    blockedMsg('langflow sandbox health', `unreachable at ${SANDBOX_URL}`);
    summary('t06-live-sandbox');
    return;
  }
  pass('sandbox health');

  const adapter = new LangflowAdapter({
    baseUrl: SANDBOX_URL,
    apiKey: SANDBOX_KEY,
    timeoutMs: 60_000,
  });

  let catalogue: unknown;
  try {
    catalogue = await adapter.fetchComponentCatalogue();
    check(
      catalogue !== null && typeof catalogue === 'object',
      'fetched /api/v1/all catalogue',
      '',
    );
  } catch (e) {
    fail('fetch catalogue', e instanceof Error ? e.message : String(e));
    summary('t06-live-sandbox');
    return;
  }

  // Avoid long pure-digit suffixes (redactor treats them as card numbers).
  const tag = `t${Date.now().toString(36)}`;
  const graph = echoGraph({
    id: `g_live_echo_${tag}`,
    name: `aios-graph-echo-${tag}`,
  });
  const compiled = compileGraphToLangflow(graph, catalogue);
  check(compiled.ok === true, 'live catalogue compile echo', JSON.stringify(compiled.issues));
  if (!compiled.ok) {
    summary('t06-live-sandbox');
    return;
  }

  check(
    compiled.catalogueFingerprint !== null && compiled.catalogueFingerprint.length === 64,
    'live catalogue fingerprint',
    compiled.catalogueFingerprint ?? '',
  );

  // Create flow via Flow API (deployArtifact path) with matching digest
  const { computeArtifactDigest } = await import('../../../src/runtime/adapter.js');
  const digest = computeArtifactDigest(compiled.flow.data);
  let flowId: string | null = null;

  try {
    const binding = await adapter.deployArtifact({
      artifactId: graph.name.slice(0, 64),
      artifactJson: compiled.flow.data,
      digest,
      environment: 'SANDBOX',
      channel: 'CANARY',
    });
    const ref = binding.bindingRef; // langflow:flow:<id>
    const m = /^langflow:flow:(.+)$/.exec(ref);
    check(!!m, 'deploy binding ref', ref);
    flowId = m ? parseSafeLangflowFlowId(m[1]) : null;
    check(!!flowId, 'safe flow id', flowId ?? '');
  } catch (e) {
    fail('create flow', e instanceof Error ? e.message : String(e));
    summary('t06-live-sandbox');
    return;
  }

  const INPUT = 'hello-aios-graph-echo';
  try {
    const events = [];
    for await (const ev of adapter.execute({
      agentId: 't06-graph',
      artifactId: flowId!,
      input: { text: INPUT },
      triggeredBy: 't06-live-sandbox',
      timeoutMs: 60_000,
    })) {
      events.push(ev);
    }

    const outputEv = events.find((e) => e.type === 'run.output') as
      | { type: 'run.output'; output: { results?: unknown[] } }
      | undefined;
    const finished = events.find((e) => e.type === 'run.finished') as
      | { type: 'run.finished'; status: string }
      | undefined;

    check(finished?.status === 'SUCCEEDED', 'run succeeded', JSON.stringify(finished));
    check(!!outputEv, 'run.output present', JSON.stringify(events.map((e) => e.type)));

    if (outputEv) {
      const results = Array.isArray(outputEv.output.results) ? outputEv.output.results : [];
      const text = extractOutputText(results);
      // Also accept raw input_value echo buried in structure
      const blob = JSON.stringify(outputEv.output);
      const okText =
        text === INPUT ||
        blob.includes(INPUT) ||
        // execute() stringifies input as JSON — ChatInput may echo that form
        blob.includes(JSON.stringify({ text: INPUT })) ||
        blob.includes(`"text":"${INPUT}"`);
      check(okText, 'echo output contains input', `text=${text} blob=${blob.slice(0, 400)}`);
    }
  } catch (e) {
    fail('execute flow', e instanceof Error ? e.message : String(e));
  } finally {
    // Delete ONLY the temporary test flow by exact id
    if (flowId) {
      try {
        const base = SANDBOX_URL.replace(/\/+$/, '');
        const del = await fetch(`${base}/api/v1/flows/${encodeURIComponent(flowId)}`, {
          method: 'DELETE',
          headers: {
            accept: 'application/json',
            'x-api-key': SANDBOX_KEY,
          },
          signal: AbortSignal.timeout(15_000),
        });
        check(del.ok || del.status === 204 || del.status === 200, 'delete flow by exact id', `status=${del.status} id=${flowId}`);
      } catch (e) {
        fail('delete flow', e instanceof Error ? e.message : String(e));
      }
    }
  }

  summary('t06-live-sandbox');
}

main().catch((e) => {
  fail('main', e instanceof Error ? e.stack ?? e.message : String(e));
  summary('t06-live-sandbox');
  process.exit(1);
});
