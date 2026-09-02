import assert from 'node:assert/strict';
import type { AgentBuildSession } from '../src/types.ts';
import {
  readinessFor,
  summarizeAgentBuildForResume,
  summarizeAgentBuildSession,
} from '../src/tools/agentbuilder.ts';

const session: AgentBuildSession = {
  id: 'session-1',
  status: 'ACTIVE',
  brief: { large: 'private discovery payload' },
  plan: { large: 'private capability plan' },
  strategy: 'create',
  targetAgentId: 'agent-1',
  builtAgentId: 'agent-1',
  agentId: 'agent-1',
  draftSkillIds: ['skill-1'],
  hasTestData: false,
  testResult: { large: 'private result' },
  lastRunId: null,
  transcript: [
    { role: 'user', content: 'large training turn', at: '2026-08-30T00:00:00.000Z' },
    { role: 'assistant', content: 'large answer', at: '2026-08-30T00:00:01.000Z' },
  ],
  iterations: [{
    id: 'iteration-1',
    sequence: 1,
    triggerKind: 'EXTERNAL_SNAPSHOT',
    triggerSummary: 'large trigger',
    status: 'READY',
    understanding: { large: 'private graph' },
    changes: [],
    harness: { large: 'private artifact' },
    userSummary: 'ready',
    fdeSummary: null,
    error: null,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:01.000Z',
  }],
  latestIteration: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:01.000Z',
};

const summary = summarizeAgentBuildSession(session);
assert.equal(summary.id, session.id);
assert.equal(summary.transcriptCount, 2);
assert.equal(summary.iterationCount, 1);
assert.equal('transcript' in summary, false);
assert.equal('iterations' in summary, false);
assert.equal('brief' in summary, false);
assert.equal('plan' in summary, false);
assert.equal('testResult' in summary, false);

console.log('ok - Agent Builder write responses omit repeated history payloads');

const resumable = summarizeAgentBuildForResume({
  ...session,
  transcript: Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `turn-${index + 1}`,
    at: `2026-08-30T00:00:${String(index).padStart(2, '0')}.000Z`,
  })),
  latestIteration: session.iterations[0]!,
});
assert.equal((resumable.transcript as unknown[]).length, 6);
assert.equal((resumable.transcript as Array<{ content: string }>)[0]?.content, 'turn-7');
assert.equal((resumable.iterations as unknown[]).length, 1);
assert.equal(
  ((resumable.latestIteration as Record<string, unknown>).harness as Record<string, unknown>).large,
  'private artifact',
  'resume payload must retain the latest complete artifact',
);

console.log('ok - Agent Builder resume response keeps only recent turns and the latest complete snapshot');

const firstReady = readinessFor(session, 'PM 專案進度小幫手', true);
assert.equal(firstReady.readyForUse, true);
assert.equal(firstReady.becameReady, true);
assert.match(firstReady.userNotice, /已經建立完成，現在就可以開始使用/);
assert.match(firstReady.userNotice, /請叫 PM 專案進度小幫手/);

const updated = readinessFor(session, 'PM 專案進度小幫手', false);
assert.equal(updated.readyForUse, true);
assert.equal(updated.becameReady, false);
assert.match(updated.userNotice, /最新訓練內容已更新完成/);

console.log('ok - Agent Builder responses contain an explicit plain-language ready notice');
