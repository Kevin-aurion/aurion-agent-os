import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from './api';

test('ApiError exposes structured detail without breaking code/message', () => {
  const detail = {
    issues: [{ code: 'SCHEMA_INVALID', path: 'nodes', message: 'bad' }],
    nodeMapping: [{ aiosNodeId: 'n1', status: 'unsupported' }],
  };
  const err = new ApiError('BAD_REQUEST', 'Graph validation failed', detail);
  assert.equal(err.code, 'BAD_REQUEST');
  assert.equal(err.message, 'Graph validation failed');
  assert.deepEqual(err.detail, detail);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ApiError);

  const plain = new ApiError('FORBIDDEN', 'Forbidden');
  assert.equal(plain.detail, undefined);
  assert.equal(plain.code, 'FORBIDDEN');
});
