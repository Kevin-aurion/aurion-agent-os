import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeArgs } from '../../../src/engine/claude.js';

const base = { prompt: 'test', cwd: '/tmp' };

test('builder sandbox can disable inherited Claude customizations', () => {
  assert.equal(buildClaudeArgs({ ...base, safeMode: true }).includes('--safe-mode'), true);
});

test('ordinary Claude execution remains backward compatible', () => {
  assert.equal(buildClaudeArgs(base).includes('--safe-mode'), false);
});
