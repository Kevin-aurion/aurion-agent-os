/**
 * Stage-0 Agent Builder haemostasis: AbortSignal, generatedBy, fallback redact.
 *
 * Run from `web os system/`:
 *   npx tsx aios-server/tests/stage0-builder-fixes/builder-fixes.test.ts
 */
import assert from 'node:assert/strict';
import {
  buildGrillFallbackTurn,
  planAdaptiveInterviewTurn,
} from '../../src/lib/agentbuilder.ts';
import { fallbackPayload } from '../../src/lib/agentbuilderevolution.ts';
import {
  abortBuilderIteration,
  abortBuilderSessionWork,
  beginBuilderIterationCall,
  finishBuilderIterationCall,
} from '../../src/lib/builderabort.ts';
import type { RunClaudeOpts, RunClaudeResult } from '../../src/engine/claude.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const MODEL_TURN = {
  focusKey: 'objective',
  intent: 'explore',
  context: '我理解你想先處理對帳漏帳。',
  whyThisMatters: '先確認真正痛點，才不會把舊流程照搬。',
  recommendation: '從最近一次實際漏帳開始描述。',
  question: '最近一次對帳出錯時，中間發生了什麼？',
  suggestions: ['我可以描述最近一次案例', '我手邊有去識別的對帳單'],
  sourceAdvice: { mode: 'optional', reason: '有範本更好，但不是必須。' },
};

async function sleepUntilAbort(signal: AbortSignal | undefined, ms: number): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ stdout: JSON.stringify(MODEL_TURN) }), ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

const originalAdaptive = process.env.AIOS_BUILDER_ADAPTIVE_MODEL;

await test('abort: runClaude receives signal and finishes within 1.5s', async () => {
  delete process.env.AIOS_BUILDER_ADAPTIVE_MODEL;
  const sessionId = 'sess-abort-builder-fixes';
  let seenSignal: AbortSignal | undefined;
  let entered = false;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });

  const runClaudeFn = async (opts: RunClaudeOpts): Promise<RunClaudeResult> => {
    seenSignal = opts.signal;
    entered = true;
    release();
    return sleepUntilAbort(opts.signal, 30_000);
  };

  const pending = planAdaptiveInterviewTurn({
    key: 'objective',
    brief: { objective: '銀行對帳' },
    sessionId,
    runClaudeFn,
  });

  await withTimeout(started, 1_000, 'runClaude was never entered');
  const t0 = Date.now();
  abortBuilderSessionWork(sessionId);
  const turn = await withTimeout(pending, 1_500, 'aborted runClaude');
  const elapsed = Date.now() - t0;

  assert.equal(entered, true);
  assert.ok(seenSignal, 'runClaude must receive AbortSignal');
  assert.equal(seenSignal!.aborted, true);
  assert.ok(elapsed < 1_500, `abort took ${elapsed}ms`);
  assert.equal(turn.generatedBy, 'fallback');
});

await test('abort: SUPERSEDED iteration controller stops in-flight work within 1.5s', async () => {
  const sessionId = 'sess-iter-abort';
  const iterationId = 'iter-abort-1';
  const controller = beginBuilderIterationCall(sessionId, iterationId);
  const pending = sleepUntilAbort(controller.signal, 30_000);
  const t0 = Date.now();
  abortBuilderIteration(iterationId);
  await assert.rejects(
    () => withTimeout(pending, 1_500, 'aborted evolution'),
    /aborted/,
  );
  assert.ok(Date.now() - t0 < 1_500);
  finishBuilderIterationCall(sessionId, iterationId, controller);
});

await test('generatedBy: questionnaire when AIOS_BUILDER_ADAPTIVE_MODEL=off', async () => {
  process.env.AIOS_BUILDER_ADAPTIVE_MODEL = 'off';
  const turn = await planAdaptiveInterviewTurn({
    key: 'objective',
    brief: { objective: '銀行對帳' },
  });
  assert.equal(turn.generatedBy, 'questionnaire');
  assert.ok(turn.question.length > 8);
});

await test('generatedBy: fallback when the model throws', async () => {
  delete process.env.AIOS_BUILDER_ADAPTIVE_MODEL;
  const turn = await planAdaptiveInterviewTurn({
    key: 'objective',
    brief: { objective: '銀行對帳' },
    runClaudeFn: async () => {
      throw new Error('claude unavailable');
    },
  });
  assert.equal(turn.generatedBy, 'fallback');
});

await test('generatedBy: model when Claude returns a valid turn', async () => {
  delete process.env.AIOS_BUILDER_ADAPTIVE_MODEL;
  let seenSignal: AbortSignal | undefined;
  const turn = await planAdaptiveInterviewTurn({
    key: 'objective',
    brief: { objective: '銀行對帳' },
    runClaudeFn: async (opts) => {
      seenSignal = opts.signal;
      return { stdout: JSON.stringify(MODEL_TURN) };
    },
  });
  assert.equal(turn.generatedBy, 'model');
  assert.equal(turn.question, MODEL_TURN.question);
  assert.equal(seenSignal === undefined || seenSignal instanceof AbortSignal, true);
});

await test('generatedBy: evolution fallbackPayload is fallback (keeps source mark)', () => {
  const payload = fallbackPayload(
    { brief: { objective: '對帳' }, transcript: [] },
    null,
    '請幫我處理銀行對帳',
    'message',
  );
  assert.equal(payload.generatedBy, 'fallback');
  assert.equal(payload.harness.generatedBy, 'fallback');
  assert.match(payload.changes[0]?.summary ?? '', /source:'fallback'/);
  assert.equal(payload.understanding.facts.some((fact) => fact.source === 'fallback'), true);
});

await test('fallback redact: sk- key in uploaded file excerpt is stripped', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const turn = buildGrillFallbackTurn({
    fallbackKey: 'process',
    brief: {
      objective: '對帳',
      sourceFiles: [{
        name: 'notes.txt',
        size: 80,
        content: `API_KEY=${secret}\n第二行線索\n第三行線索`,
        uploadedAt: new Date().toISOString(),
      }],
    },
  });
  const blob = JSON.stringify(turn);
  assert.equal(turn.generatedBy, 'fallback');
  assert.equal(blob.includes(secret), false, `secret leaked: ${blob.slice(0, 240)}`);
  assert.match(blob, /REDACTED_API_KEY/);
});

if (originalAdaptive === undefined) delete process.env.AIOS_BUILDER_ADAPTIVE_MODEL;
else process.env.AIOS_BUILDER_ADAPTIVE_MODEL = originalAdaptive;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
