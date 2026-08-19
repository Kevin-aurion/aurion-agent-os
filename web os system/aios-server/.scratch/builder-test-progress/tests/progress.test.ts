import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveBuilderTestProgress } from '../../../src/lib/buildertestprogress.js';

const startedAt = new Date('2026-08-09T17:01:19.000Z');
const now = new Date('2026-08-09T17:03:19.000Z');

test('shows the first execution round before any verifier record exists', () => {
  const progress = deriveBuilderTestProgress({
    run: { id: 'run-1', status: 'RUNNING', startedAt, finishedAt: null, stoppedAt: null },
    steps: [],
    maxRounds: 5,
    now,
  });
  assert.equal(progress.stage, 'EXECUTING');
  assert.equal(progress.currentRound, 1);
  assert.equal(progress.elapsedSeconds, 120);
  assert.equal(progress.latestMessage, '第 1 輪正在執行測試工作');
});

test('shows rework after a rejected verifier round', () => {
  const progress = deriveBuilderTestProgress({
    run: { id: 'run-1', status: 'RUNNING', startedAt, finishedAt: null, stoppedAt: null },
    steps: [{
      round: 1,
      status: 'rejected',
      approved: false,
      verdict: '## Verdict\nISSUES FOUND\n缺少時程表。',
      startedAt: new Date('2026-08-09T17:02:00.000Z'),
      endedAt: new Date('2026-08-09T17:02:40.000Z'),
    }],
    maxRounds: 5,
    now,
  });
  assert.equal(progress.stage, 'REWORKING');
  assert.equal(progress.currentRound, 2);
  assert.equal(progress.rounds[0]?.summary, 'ISSUES FOUND 缺少時程表。');
});

test('returns a completed approved result with safe round history', () => {
  const progress = deriveBuilderTestProgress({
    run: { id: 'run-1', status: 'SUCCEEDED', startedAt, finishedAt: now, stoppedAt: null },
    steps: [{
      round: 1,
      status: 'approved',
      approved: true,
      verdict: 'APPROVED — 所有驗收條件均符合。',
      startedAt,
      endedAt: now,
    }],
    maxRounds: 3,
    now,
  });
  assert.equal(progress.stage, 'COMPLETED');
  assert.equal(progress.status, 'SUCCEEDED');
  assert.equal(progress.rounds[0]?.approved, true);
  assert.equal(progress.finishedAt, now.toISOString());
});

test('redacts secrets from the verifier summary', () => {
  const progress = deriveBuilderTestProgress({
    run: { id: 'run-1', status: 'FAILED', startedAt, finishedAt: now, stoppedAt: 'chat' },
    steps: [{
      round: 1,
      status: 'rejected',
      approved: false,
      verdict: 'token: sk-abcdefghijklmnopqrstuvwxyz123456',
      startedAt,
      endedAt: now,
    }],
    maxRounds: 1,
    now,
  });
  assert.doesNotMatch(progress.rounds[0]?.summary ?? '', /sk-/);
});
