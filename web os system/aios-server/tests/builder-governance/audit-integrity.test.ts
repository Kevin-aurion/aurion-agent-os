/**
 * AuditLog hash / redaction integrity.
 *
 * Hash must use the same already-redacted, JSON-normalized detail that Prisma
 * persists. Object undefined is omitted (not hashed as null); array undefined
 * becomes null. Secrets in detail are always deep-redacted.
 *
 * Append-only: this test never deletes AuditLog rows.
 *
 * Run from `web os system/aios-server/`:
 *   npx tsx tests/builder-governance/audit-integrity.test.ts
 */
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { audit, computeAuditHash } from '../../src/lib/audit.ts';
import { prisma, disconnectDb } from '../../src/lib/db.ts';

const TEST_PREFIX = 'gov-audit-integrity-';
const AUDIT_ACTION = 'test.audit.integrity';
const AUDIT_ENTITY = 'AuditIntegrityTest';

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

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'detail must be a JSON object');
  return value as Record<string, unknown>;
}

try {
  await test('persisted detail is redacted, drops object undefined, nulls array holes, and self-hashes', async () => {
    const entityId = `${TEST_PREFIX}${ulid()}`;
    const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const email = 'alice.audit-integrity@example.com';
    const card = '4111111111111111';

    await audit(null, AUDIT_ACTION, AUDIT_ENTITY, entityId, {
      apiKey,
      email,
      card,
      keep: 'visible',
      optional: undefined,
      nested: {
        skip: undefined,
        note: 'ok',
      },
      holes: [1, undefined, 'keep-hole', undefined],
    });

    const row = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTION, entity: AUDIT_ENTITY, entityId },
    });
    assert.ok(row, 'audit() must persist a row even with secrets / undefined fields');
    assert.ok(row.hash, 'persisted row must have a hash');

    const stored = asRecord(row.detail);
    const storedJson = JSON.stringify(stored);

    assert.equal(storedJson.includes(apiKey), false, 'API key must not land in AuditLog.detail');
    assert.equal(storedJson.includes(email), false, 'email must not land in AuditLog.detail');
    assert.equal(storedJson.includes(card), false, 'credit card must not land in AuditLog.detail');
    assert.equal(stored.apiKey, '[REDACTED_API_KEY]');
    assert.equal(stored.email, '[REDACTED_EMAIL]');
    assert.equal(stored.card, '[REDACTED_CARD]');
    assert.equal(stored.keep, 'visible');

    assert.equal('optional' in stored, false, 'object undefined must be omitted, not stored as null');
    assert.notEqual(stored.optional, null);

    const nested = asRecord(stored.nested);
    assert.equal('skip' in nested, false, 'nested object undefined must be omitted');
    assert.equal(nested.note, 'ok');

    assert.ok(Array.isArray(stored.holes), 'array field must remain an array');
    assert.deepEqual(stored.holes, [1, null, 'keep-hole', null], 'array undefined must become null');

    const expectedHash = computeAuditHash({
      prevHash: row.prevHash,
      id: row.id,
      userId: row.userId,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      detail: row.detail,
      createdAt: row.createdAt,
    });
    assert.equal(row.hash, expectedHash, 'computeAuditHash must be self-consistent with the DB row');
  });
} finally {
  await disconnectDb();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
