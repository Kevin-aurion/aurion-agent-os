/**
 * Slice 01 — Device registry & enrollment (+ concurrent consume).
 * Run: npx tsx .scratch/device-execution-platform/tests/t01-enrollment.test.ts
 */
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { devicesRoutes } from '../../../src/routes/devices.js';
import { deviceRoutes } from '../../../src/routes/device.js';
import {
  createDevice,
  issueEnrollmentCode,
  enrollWithCode,
  revokeDevice,
  rotateDeviceToken,
  bindAgentDevice,
  assertNoPlainSecretsInRow,
  authenticateDeviceToken,
} from '../../../src/lib/device.js';
import { sha256 } from '../../../src/lib/crypto.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function expectStatus(
  app: Awaited<ReturnType<typeof Fastify>>,
  opts: { method: 'GET' | 'POST' | 'DELETE'; url: string; headers?: Record<string, string>; payload?: unknown },
  status: number,
  label: string,
) {
  const res = await app.inject({
    method: opts.method,
    url: opts.url,
    headers: opts.headers,
    payload: opts.payload as any,
  });
  assert(res.statusCode === status, `${label}: expected ${status}, got ${res.statusCode} body=${res.body}`);
  return res;
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need OWNER/TRAINER user');

  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMemberId: string | null = null;
  if (!member) {
    createdMemberId = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMemberId,
        email: `dev-member-${createdMemberId.slice(-6).toLowerCase()}@test.local`,
        displayName: 'Device Test Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const deviceIds: string[] = [];

  const trainerToken = await signAccess({
    sub: owner.id,
    email: owner.email,
    role: owner.role,
  });
  const memberToken = await signAccess({
    sub: member.id,
    email: member.email,
    role: 'MEMBER',
  });

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 400) {
      return reply.code(anyErr.statusCode).send({
        success: false,
        error: { code: anyErr.code ?? 'ERROR', message: anyErr.message ?? 'error' },
      });
    }
    return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(devicesRoutes);
  await app.register(deviceRoutes);

  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `dev-enroll-agent-${tag}`,
        name: 'Device Enroll Agent',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
      },
    });

    console.log('── [1] create device ──');
    const device = await createDevice({
      ownerUserId: owner.id,
      name: `Test Mac ${tag}`,
      platform: 'MACOS',
    });
    deviceIds.push(device.id);
    assert(device.status === 'PENDING_ENROLLMENT', 'status PENDING_ENROLLMENT');

    await expectStatus(
      app,
      { method: 'GET', url: '/api/devices', headers: { authorization: `Bearer ${trainerToken}` } },
      200,
      'list devices trainer',
    );
    console.log('PASS [1] create + list');

    console.log('── [2] non-FDE rejected ──');
    await expectStatus(
      app,
      {
        method: 'POST',
        url: '/api/devices',
        headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' },
        payload: { name: 'nope', platform: 'MACOS' },
      },
      403,
      'member create',
    );
    console.log('PASS [2] non-FDE rejected');

    console.log('── [3] enroll happy path ──');
    const issued = await issueEnrollmentCode({
      deviceId: device.id,
      createdBy: owner.id,
      ttlMs: 60_000,
    });
    const enrolled = await enrollWithCode({ code: issued.code, osVersion: '15.0', appVersion: '1.0.0' });
    assert(enrolled.deviceId === device.id, 'deviceId');
    const row = await prisma.device.findUnique({ where: { id: device.id } });
    assert(row?.status === 'ACTIVE', 'ACTIVE');
    assert(row?.tokenHash === sha256(enrolled.token), 'hash matches');
    assertNoPlainSecretsInRow(
      { tokenHash: row?.tokenHash, tokenPrefix: row?.tokenPrefix },
      [enrolled.token, issued.code],
    );
    const dump = JSON.stringify(row);
    assert(!dump.includes(enrolled.token), 'plaintext token not in DB');
    assert(!dump.includes(issued.code), 'plaintext code not in DB');
    console.log('PASS [3] enroll + no plaintext');

    console.log('── [4] reuse rejected ──');
    let reuseErr: unknown;
    try {
      await enrollWithCode({ code: issued.code });
    } catch (e) {
      reuseErr = e;
    }
    assert(reuseErr instanceof ApiError, 'reuse throws');
    console.log('PASS [4] reuse');

    console.log('── [5] expired ──');
    const issued2 = await issueEnrollmentCode({
      deviceId: device.id,
      createdBy: owner.id,
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 20));
    let expErr: unknown;
    try {
      await enrollWithCode({ code: issued2.code });
    } catch (e) {
      expErr = e;
    }
    assert(expErr instanceof ApiError, 'expired throws');
    console.log('PASS [5] expired');

    console.log('── [6] concurrent consume — only one wins ──');
    const dConc = await createDevice({
      ownerUserId: owner.id,
      name: `Conc ${tag}`,
      platform: 'LINUX',
    });
    deviceIds.push(dConc.id);
    const codeConc = await issueEnrollmentCode({
      deviceId: dConc.id,
      createdBy: owner.id,
      ttlMs: 120_000,
    });
    const results = await Promise.allSettled([
      enrollWithCode({ code: codeConc.code }),
      enrollWithCode({ code: codeConc.code }),
      enrollWithCode({ code: codeConc.code }),
    ]);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    const failCount = results.filter((r) => r.status === 'rejected').length;
    assert(okCount === 1, `exactly one enroll success, got ${okCount}`);
    assert(failCount === 2, `two fail-closed, got ${failCount}`);
    const enRow = await prisma.deviceEnrollment.findUnique({ where: { id: codeConc.enrollmentId } });
    assert(!!enRow?.consumedAt, 'consumed exactly once');
    const active = await prisma.device.findUnique({ where: { id: dConc.id } });
    assert(active?.status === 'ACTIVE' && !!active.tokenHash, 'device active with one token');
    console.log('PASS [6] concurrent enroll atomic');

    console.log('── [6b] concurrent issueEnrollmentCode — only one code remains valid ──');
    const dIssue = await createDevice({
      ownerUserId: owner.id,
      name: `IssueRace ${tag}`,
      platform: 'LINUX',
    });
    deviceIds.push(dIssue.id);
    // Two concurrent issuers: without Device FOR UPDATE both could leave valid codes.
    const issuedPair = await Promise.all([
      issueEnrollmentCode({ deviceId: dIssue.id, createdBy: owner.id, ttlMs: 300_000 }),
      issueEnrollmentCode({ deviceId: dIssue.id, createdBy: owner.id, ttlMs: 300_000 }),
    ]);
    assert(issuedPair[0]!.enrollmentId !== issuedPair[1]!.enrollmentId, 'two distinct enrollment rows');
    const enrollResults = await Promise.allSettled([
      enrollWithCode({ code: issuedPair[0]!.code }),
      enrollWithCode({ code: issuedPair[1]!.code }),
    ]);
    const enrollOk = enrollResults.filter((r) => r.status === 'fulfilled').length;
    const enrollFail = enrollResults.filter((r) => r.status === 'rejected').length;
    assert(enrollOk === 1, `exactly one of two concurrent-issue codes enrolls, got ${enrollOk}`);
    assert(enrollFail === 1, `other code rejected, got fail=${enrollFail}`);
    // Loser enrollment row must be expired (not consumable), not both live.
    const loserIdx = enrollResults[0]!.status === 'rejected' ? 0 : 1;
    const loserRow = await prisma.deviceEnrollment.findUnique({
      where: { id: issuedPair[loserIdx]!.enrollmentId },
    });
    assert(!!loserRow, 'loser row exists');
    assert(loserRow!.consumedAt == null, 'loser not consumed');
    assert(
      loserRow!.expiresAt.getTime() <= Date.now(),
      'loser code expired by the other concurrent issuer',
    );
    const winnerIdx = 1 - loserIdx;
    const winnerRow = await prisma.deviceEnrollment.findUnique({
      where: { id: issuedPair[winnerIdx]!.enrollmentId },
    });
    assert(!!winnerRow?.consumedAt, 'winner consumed');
    console.log('PASS [6b] concurrent issue serializes via FOR UPDATE');

    console.log('── [7] revoke ──');
    await authenticateDeviceToken(enrolled.token);
    await revokeDevice({ deviceId: device.id, actorUserId: owner.id });
    let revErr: unknown;
    try {
      await authenticateDeviceToken(enrolled.token);
    } catch (e) {
      revErr = e;
    }
    assert(revErr instanceof ApiError, 'revoked token throws');
    console.log('PASS [7] revoke');

    console.log('── [8] rotate ──');
    const d2 = await createDevice({
      ownerUserId: owner.id,
      name: `Rotate ${tag}`,
      platform: 'LINUX',
    });
    deviceIds.push(d2.id);
    const c2 = await issueEnrollmentCode({ deviceId: d2.id, createdBy: owner.id });
    const e2 = await enrollWithCode({ code: c2.code });
    const rotated = await rotateDeviceToken({ deviceId: d2.id, actorUserId: owner.id });
    let oldErr: unknown;
    try {
      await authenticateDeviceToken(e2.token);
    } catch (e) {
      oldErr = e;
    }
    assert(oldErr instanceof ApiError, 'old token dead');
    await authenticateDeviceToken(rotated.token);
    console.log('PASS [8] rotate');

    console.log('── [9] bind ACTIVE only ──');
    await bindAgentDevice({ agentId, deviceId: d2.id, boundBy: owner.id });
    let bindErr: unknown;
    try {
      await bindAgentDevice({ agentId, deviceId: device.id, boundBy: owner.id });
    } catch (e) {
      bindErr = e;
    }
    assert(bindErr instanceof ApiError, 'revoked bind throws');
    console.log('PASS [9] bind');

    console.log('── [10] REST enroll ──');
    const d3 = await createDevice({
      ownerUserId: owner.id,
      name: `REST ${tag}`,
      platform: 'WINDOWS',
    });
    deviceIds.push(d3.id);
    const codeRes = await expectStatus(
      app,
      {
        method: 'POST',
        url: `/api/devices/${d3.id}/enroll-code`,
        headers: { authorization: `Bearer ${trainerToken}`, 'content-type': 'application/json' },
        payload: {},
      },
      200,
      'enroll-code REST',
    );
    const codeBody = codeRes.json() as { data: { code: string } };
    await expectStatus(
      app,
      {
        method: 'POST',
        url: '/api/device/enroll',
        headers: { 'content-type': 'application/json' },
        payload: { code: codeBody.data.code, platform: 'WINDOWS', appVersion: '0.1' },
      },
      200,
      'device enroll REST',
    );
    console.log('PASS [10] REST enroll');

    console.log('\n✅ t01-enrollment ALL PASS');
  } finally {
    await app.close();
    await prisma.deviceArtifact.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.deviceTask.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.agentDevice.deleteMany({ where: { OR: [{ agentId }, { deviceId: { in: deviceIds } }] } }).catch(() => {});
    await prisma.deviceEnrollment.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    if (createdMemberId) {
      await prisma.user.delete({ where: { id: createdMemberId } }).catch(() => {});
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
