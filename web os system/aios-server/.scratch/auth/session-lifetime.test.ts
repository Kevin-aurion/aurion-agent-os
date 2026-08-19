/**
 * Auth session lifetime + refresh rotation acceptance tests.
 * Run: npx tsx .scratch/auth/session-lifetime.test.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../src/lib/db.js';
import {
  createSession,
  rotateSession,
  SESSION_TTL_MS,
} from '../../src/lib/auth.js';
import { sha256 } from '../../src/lib/crypto.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

async function main() {
  const userId = ulid();
  await prisma.user.create({
    data: {
      id: userId,
      email: `auth-session-${userId.slice(-8).toLowerCase()}@test.local`,
      displayName: 'Auth Session Test',
      passwordHash: 'not-used',
      role: 'MEMBER',
    },
  });

  try {
    const issuedAt = Date.now();
    const firstRaw = await createSession(userId, 'test');
    const first = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: sha256(firstRaw) },
    });
    const ttl = first.expiresAt.getTime() - issuedAt;
    assert(ttl <= SESSION_TTL_MS, 'session cannot exceed three days');
    assert(ttl >= SESSION_TTL_MS - 2_000, 'session should last approximately three days');

    const rotated = await rotateSession(firstRaw, 'test');
    const oldAfter = await prisma.session.findUniqueOrThrow({ where: { id: first.id } });
    const second = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: sha256(rotated.refresh) },
    });
    assert(oldAfter.revokedAt != null, 'rotation revokes the previous refresh token');
    assert(
      second.expiresAt.getTime() === first.expiresAt.getTime(),
      'rotation preserves the original absolute deadline',
    );

    const third = await rotateSession(rotated.refresh, 'test');
    const thirdRow = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: sha256(third.refresh) },
    });
    assert(
      thirdRow.expiresAt.getTime() === first.expiresAt.getTime(),
      'repeated activity does not slide the three-day deadline',
    );

    const concurrentRaw = await createSession(userId, 'concurrency');
    const attempts = await Promise.allSettled([
      rotateSession(concurrentRaw, 'concurrency-a'),
      rotateSession(concurrentRaw, 'concurrency-b'),
    ]);
    assert(
      attempts.filter((attempt) => attempt.status === 'fulfilled').length === 1,
      'a refresh token can be claimed only once under concurrency',
    );
    assert(
      attempts.filter((attempt) => attempt.status === 'rejected').length === 1,
      'the racing refresh fails closed',
    );

    const legacyRaw = await createSession(
      userId,
      'legacy-policy',
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    );
    const legacy = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: sha256(legacyRaw) },
    });
    const capped = await rotateSession(legacyRaw, 'legacy-policy');
    const cappedRow = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: sha256(capped.refresh) },
    });
    assert(
      cappedRow.expiresAt.getTime() === legacy.createdAt.getTime() + SESSION_TTL_MS,
      'old 30-day sessions are capped at three days from original login',
    );

    console.log('✓ three-day absolute session lifetime');
    console.log('✓ rotation preserves deadline and revokes old token');
    console.log('✓ concurrent rotation fails closed');
    console.log('✓ legacy 30-day session is capped');
  } finally {
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
