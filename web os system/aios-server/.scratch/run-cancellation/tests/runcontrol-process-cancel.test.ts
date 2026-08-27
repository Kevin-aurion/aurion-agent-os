import assert from 'node:assert/strict';
import { execCli } from '../../../src/engine/claude.js';
import {
  cancelActiveRun,
  isActiveRunRegistered,
  registerActiveRun,
  releaseActiveRun,
} from '../../../src/lib/runcontrol.js';

const runId = `cancel-test-${Date.now()}`;
const signal = registerActiveRun(runId);
assert.equal(isActiveRunRegistered(runId), true);

const processResult = execCli(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { signal, timeoutMs: 15_000 },
);

setTimeout(() => {
  assert.equal(cancelActiveRun(runId), true);
}, 150);

const result = await processResult;
assert.equal(result.aborted, true, 'registry cancellation must reach the CLI AbortSignal');
releaseActiveRun(runId);
assert.equal(isActiveRunRegistered(runId), false);
assert.equal(cancelActiveRun(runId), false, 'released run must not report a live process');

console.log('✓ run cancellation registry terminates the live CLI process');
