import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatKnowledgeAnswer,
  parseKnowledgeSearchOutput,
  runKnowledgePilot,
  type KnowledgePilotDeps,
} from '../../../src/lib/knowledgepilot.js';

const hit = {
  score: 42.5,
  video_id: 'video-1',
  title: 'PDF 工具實測',
  channel: '測試頻道',
  matched_tools: ['MinerU'],
  matched_concepts: ['文件解析'],
  evidence_kind: 'tool',
  evidence_label: 'MinerU',
  evidence_text: 'MinerU 可把複雜 PDF 解析為 Markdown。',
  timestamp: '02:05',
  evidence_url: 'https://www.youtube.com/watch?v=video-1&t=125s',
  wiki_source: 'wiki/sources/video-1.md',
};

test('parseKnowledgeSearchOutput accepts bounded cited results', () => {
  const parsed = parseKnowledgeSearchOutput(JSON.stringify({
    query: 'PDF 轉文字',
    results: [hit],
  }));
  assert.equal(parsed.results[0]?.title, 'PDF 工具實測');
  assert.equal(parsed.results[0]?.timestamp, '02:05');
});

test('parseKnowledgeSearchOutput rejects malformed or unbounded output', () => {
  assert.throws(() => parseKnowledgeSearchOutput('{"results":"wrong"}'));
  assert.throws(() => parseKnowledgeSearchOutput('x'.repeat(600_000)));
});

test('formatKnowledgeAnswer is grounded and reports evidence gaps', () => {
  const grounded = formatKnowledgeAnswer('PDF 轉文字', [hit]);
  assert.match(grounded.answer, /MinerU/);
  assert.equal(grounded.citations[0]?.url, hit.evidence_url);

  const gap = formatKnowledgeAnswer('不存在的主題', []);
  assert.match(gap.answer, /找不到足夠相關的資料/);
  assert.equal(gap.citations.length, 0);
});

test('runKnowledgePilot requires Langflow to echo the run marker and persists success', async () => {
  const persisted: unknown[] = [];
  const deps: KnowledgePilotDeps = {
    search: async () => ({ query: 'PDF 轉文字', results: [hit] }),
    runtime: {
      kind: 'LANGFLOW',
      async health() { return { kind: 'LANGFLOW', healthy: true, checkedAt: new Date().toISOString(), latencyMs: 2, detail: null }; },
      async validateArtifact() { return { valid: true, errors: [] }; },
      async deployArtifact() { throw new Error('unused'); },
      async *execute(input) {
        yield { type: 'run.started', runId: input.runId!, at: new Date().toISOString() };
        yield { type: 'run.output', runId: input.runId!, at: new Date().toISOString(), output: { results: [{ text: input.runId }] } };
        yield { type: 'run.finished', runId: input.runId!, at: new Date().toISOString(), status: 'SUCCEEDED' };
      },
      async getRun() { throw new Error('unused'); },
      async cancelRun() { throw new Error('unused'); },
      async resumeRun() { throw new Error('unused'); },
    },
    persist: async (record) => { persisted.push(record); },
    audit: async () => undefined,
    now: (() => {
      let tick = 0;
      return () => new Date(1_700_000_000_000 + tick++ * 10);
    })(),
  };

  const record = await runKnowledgePilot({
    question: 'PDF 轉文字',
    limit: 4,
    actorId: 'fde-1',
  }, deps);

  assert.equal(record.status, 'SUCCEEDED');
  assert.equal(record.citations.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(record.trace.at(-1)?.key, 'persist_trace');
});

test('runKnowledgePilot fails closed when Langflow does not prove this run', async () => {
  const persisted: Array<{ status: string }> = [];
  const deps: KnowledgePilotDeps = {
    search: async () => ({ query: 'PDF 轉文字', results: [hit] }),
    runtime: {
      kind: 'LANGFLOW',
      async health() { return { kind: 'LANGFLOW', healthy: true, checkedAt: new Date().toISOString(), latencyMs: 2, detail: null }; },
      async validateArtifact() { return { valid: true, errors: [] }; },
      async deployArtifact() { throw new Error('unused'); },
      async *execute(input) {
        yield { type: 'run.started', runId: input.runId!, at: new Date().toISOString() };
        yield { type: 'run.output', runId: input.runId!, at: new Date().toISOString(), output: { results: [{ text: 'wrong-run' }] } };
        yield { type: 'run.finished', runId: input.runId!, at: new Date().toISOString(), status: 'SUCCEEDED' };
      },
      async getRun() { throw new Error('unused'); },
      async cancelRun() { throw new Error('unused'); },
      async resumeRun() { throw new Error('unused'); },
    },
    persist: async (record) => { persisted.push(record); },
    audit: async () => undefined,
  };

  await assert.rejects(() => runKnowledgePilot({
    question: 'PDF 轉文字', limit: 4, actorId: 'fde-1',
  }, deps), /沒有回傳本次執行識別/);
  assert.equal(persisted.at(-1)?.status, 'FAILED');
});
