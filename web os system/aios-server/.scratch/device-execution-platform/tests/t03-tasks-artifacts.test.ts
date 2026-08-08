/**
 * Slice 03 — Durable tasks/artifacts (+ concurrent terminal, lease, redaction, payload).
 * Run: npx tsx .scratch/device-execution-platform/tests/t03-tasks-artifacts.test.ts
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { ulid } from 'ulid';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { hub } from '../../../src/ws/hub.js';
import { devicesRoutes } from '../../../src/routes/devices.js';
import { deviceRoutes } from '../../../src/routes/device.js';
import {
  createDevice,
  issueEnrollmentCode,
  enrollWithCode,
  bindAgentDevice,
  updateDeviceCapabilities,
} from '../../../src/lib/device.js';
import {
  createDeviceTask,
  createAndDispatchTask,
  ackDeviceTask,
  renewDeviceTaskLease,
  completeDeviceTask,
  getTaskForDeviceOrThrow,
  reclaimIfExpired,
  stableJson,
} from '../../../src/lib/devicetask.js';
import {
  uploadDeviceArtifact,
  cleanupExpiredArtifacts,
  artifactsRoot,
  MAX_ARTIFACT_TTL_MS,
  resolveArtifactPath,
} from '../../../src/lib/deviceartifact.js';
import { assertInsideRoot } from '../../../src/lib/safepath.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need FDE');

  const tag = ulid().slice(-8).toLowerCase();
  const deviceIds: string[] = [];
  const taskIds: string[] = [];
  const agentId = ulid();

  const trainerToken = await signAccess({
    sub: owner.id,
    email: owner.email,
    role: owner.role,
  });

  const server = createServer();
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr !== 'string', 'tcp');
  const wsBase = `ws://127.0.0.1:${addr.port}`;
  let deviceWs: WebSocket | null = null;

  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ZodError') {
      return reply.code(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: (err as Error).message },
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
        slug: `task-agent-${tag}`,
        name: 'Task Agent',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        createdBy: owner.id,
      },
    });

    const dA = await createDevice({
      ownerUserId: owner.id,
      name: `TaskA ${tag}`,
      platform: 'MACOS',
    });
    const dB = await createDevice({
      ownerUserId: owner.id,
      name: `TaskB ${tag}`,
      platform: 'MACOS',
    });
    deviceIds.push(dA.id, dB.id);
    const eA = await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: dA.id, createdBy: owner.id })).code,
    });
    const eB = await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: dB.id, createdBy: owner.id })).code,
    });
    await bindAgentDevice({ agentId, deviceId: dA.id, boundBy: owner.id });

    console.log('── [1] typed payload + reject shell ──');
    let shellErr: unknown;
    try {
      await createDeviceTask({
        deviceId: dA.id,
        kind: 'COMPUTER_CONTROL',
        agentId,
        payload: { command: 'rm -rf /', skillId: 'x' },
        actorUserId: owner.id,
      });
    } catch (e) {
      shellErr = e;
    }
    assert(shellErr instanceof ApiError, 'shell field rejected');

    let noBind: unknown;
    try {
      await createDeviceTask({
        deviceId: dB.id,
        kind: 'MCP_TOOL',
        agentId,
        payload: { serverId: 's', tool: 't' },
      });
    } catch (e) {
      noBind = e;
    }
    assert(noBind instanceof ApiError, 'unbound agent rejected');

    let noAgent: unknown;
    try {
      await createDeviceTask({
        deviceId: dA.id,
        kind: 'COMPUTER_CONTROL',
        payload: { instructions: 'click ok' },
      });
    } catch (e) {
      noAgent = e;
    }
    assert(noAgent instanceof ApiError, 'COMPUTER_CONTROL requires agentId');
    console.log('PASS [1] payload allowlist + binding');

    console.log('── [2] idempotency ──');
    const t1 = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { instructions: 'click', skillId: 'sk-skill-id-not-secret' },
      idempotencyKey: `idem-${tag}`,
      actorUserId: owner.id,
    });
    taskIds.push(t1.id);
    const t1b = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { instructions: 'other' },
      idempotencyKey: `idem-${tag}`,
    });
    assert(t1b.id === t1.id, 'idempotent');
    console.log('PASS [2] idempotency');

    console.log('── [3] cross-device ──');
    let crossErr: unknown;
    try {
      await getTaskForDeviceOrThrow(t1.id, dB.id);
    } catch (e) {
      crossErr = e;
    }
    assert(crossErr instanceof ApiError && (crossErr as ApiError).statusCode === 404, '404');
    console.log('PASS [3] cross-device');

    console.log('── [4] lease: no result without ACK; wrong/expired; second ACK ──');
    // No lease → cannot SUCCEEDED
    let noLease: unknown;
    try {
      await completeDeviceTask({
        taskId: t1.id,
        deviceId: dA.id,
        leaseId: 'nope',
        status: 'SUCCEEDED',
        result: { a: 1 },
      });
    } catch (e) {
      noLease = e;
    }
    assert(noLease instanceof ApiError, 'no lease fail-closed');

    const acked = await ackDeviceTask({ taskId: t1.id, deviceId: dA.id, leaseMs: 60_000 });
    assert(acked.status === 'ACKED' && !!acked.leaseId, 'ACKED');

    // Second ACK while lease active
    let secondAck: unknown;
    try {
      await ackDeviceTask({ taskId: t1.id, deviceId: dA.id });
    } catch (e) {
      secondAck = e;
    }
    assert(secondAck instanceof ApiError, 'second ACK rejected');

    // Wrong lease
    let wrongLease: unknown;
    try {
      await completeDeviceTask({
        taskId: t1.id,
        deviceId: dA.id,
        leaseId: 'wrong-lease-id',
        status: 'SUCCEEDED',
        result: { a: 1 },
      });
    } catch (e) {
      wrongLease = e;
    }
    assert(wrongLease instanceof ApiError, 'wrong lease');

    // Omit lease via REST
    const omitLease = await app.inject({
      method: 'POST',
      url: `/api/device/tasks/${t1.id}/result`,
      headers: {
        authorization: `Bearer ${eA.token}`,
        'content-type': 'application/json',
      },
      payload: { status: 'SUCCEEDED', result: { x: 1 } },
    });
    assert(
      omitLease.statusCode === 400 || omitLease.statusCode === 403 || omitLease.statusCode === 500,
      `omit lease rejected got ${omitLease.statusCode} ${omitLease.body}`,
    );

    // Expired lease → TIMEOUT then result fails
    await prisma.deviceTask.update({
      where: { id: t1.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    let expLease: unknown;
    try {
      await completeDeviceTask({
        taskId: t1.id,
        deviceId: dA.id,
        leaseId: acked.leaseId!,
        status: 'SUCCEEDED',
        result: { a: 1 },
      });
    } catch (e) {
      expLease = e;
    }
    assert(expLease instanceof ApiError, 'expired lease fail-closed');
    const afterExp = await prisma.deviceTask.findUnique({ where: { id: t1.id } });
    assert(afterExp?.status === 'TIMEOUT', `timeout after expire got ${afterExp?.status}`);
    console.log('PASS [4] lease guards');

    console.log('── [5] concurrent terminal first-writer-wins ──');
    const tConc = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'SCREENSHOT',
      payload: { app: 'Finder' },
      idempotencyKey: `conc-${tag}`,
    });
    taskIds.push(tConc.id);
    const aConc = await ackDeviceTask({ taskId: tConc.id, deviceId: dA.id, leaseMs: 120_000 });
    const outcomes = await Promise.allSettled([
      completeDeviceTask({
        taskId: tConc.id,
        deviceId: dA.id,
        leaseId: aConc.leaseId!,
        status: 'SUCCEEDED',
        result: { winner: 'A', n: 1 },
      }),
      completeDeviceTask({
        taskId: tConc.id,
        deviceId: dA.id,
        leaseId: aConc.leaseId!,
        status: 'SUCCEEDED',
        result: { winner: 'B', n: 2 },
      }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof completeDeviceTask>>
    >[];
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    // One may win; the other conflicts OR both return same if identical — they differ so one conflict.
    assert(fulfilled.length >= 1, 'at least one success');
    assert(rejected.length >= 1 || fulfilled.every((f) => stableJson(f.value.result) === stableJson(fulfilled[0]!.value.result)), 'loser conflicts or same');
    const final = await prisma.deviceTask.findUnique({ where: { id: tConc.id } });
    assert(final?.status === 'SUCCEEDED', 'SUCCEEDED');
    const w = (final?.result as { winner?: string })?.winner;
    assert(w === 'A' || w === 'B', 'exactly one result');
    // Retry different content → conflict, DB unchanged
    let overwrite: unknown;
    try {
      await completeDeviceTask({
        taskId: tConc.id,
        deviceId: dA.id,
        leaseId: aConc.leaseId!,
        status: 'FAILED',
        error: { reason: 'nope' },
      });
    } catch (e) {
      overwrite = e;
    }
    assert(overwrite instanceof ApiError, 'overwrite conflict');
    const again = await prisma.deviceTask.findUnique({ where: { id: tConc.id } });
    assert(stableJson(again?.result) === stableJson(final?.result), 'DB never changes after terminal');
    console.log('PASS [5] concurrent terminal');

    console.log('── [6] happy lease renew + result ──');
    const t2 = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'CAPABILITY_PROBE',
      payload: {},
    });
    taskIds.push(t2.id);
    const a2 = await ackDeviceTask({ taskId: t2.id, deviceId: dA.id });
    await renewDeviceTaskLease({
      taskId: t2.id,
      deviceId: dA.id,
      leaseId: a2.leaseId!,
    });
    const done = await completeDeviceTask({
      taskId: t2.id,
      deviceId: dA.id,
      leaseId: a2.leaseId!,
      status: 'SUCCEEDED',
      result: { ok: true },
    });
    assert(done.status === 'SUCCEEDED', 'ok');
    // idempotent same
    const done2 = await completeDeviceTask({
      taskId: t2.id,
      deviceId: dA.id,
      leaseId: a2.leaseId!,
      status: 'SUCCEEDED',
      result: { ok: true },
    });
    assert(done2.id === done.id, 'idempotent same payload');
    console.log('PASS [6] renew + result');

    console.log('── [7] artifacts redaction / magic / TTL ──');
    const tArt = await createDeviceTask({
      deviceId: dA.id,
      kind: 'SCREENSHOT',
      payload: { window: 'LINE' },
    });
    taskIds.push(tArt.id);
    await ackDeviceTask({ taskId: tArt.id, deviceId: dA.id });

    // Text LOG with secret — server redacts
    const secret = 'sk-testsecretvalue1234567890abcdef';
    const logArt = await uploadDeviceArtifact({
      taskId: tArt.id,
      deviceId: dA.id,
      seq: 10,
      kind: 'LOG',
      mimeType: 'text/plain',
      bytes: Buffer.from(`line1\napiKey=${secret}\nline3\n`, 'utf8'),
      clientDeclaredRedacted: false,
    });
    assert(logArt.redacted === true, 'server redacted flag');
    const metaLog = logArt.meta as { redactionMode?: string; serverProcessed?: boolean };
    assert(metaLog.redactionMode === 'server', 'server mode');
    assert(metaLog.serverProcessed === true, 'serverProcessed');
    const absLog = await resolveArtifactPath(logArt);
    const stored = await readFile(absLog, 'utf8');
    assert(!stored.includes(secret), 'secret not in file');
    assert(stored.includes('[REDACTED'), 'redaction marker in file');

    // PNG magic disguised as application/octet-stream without attestation → reject
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    let pngErr: unknown;
    try {
      await uploadDeviceArtifact({
        taskId: tArt.id,
        deviceId: dA.id,
        seq: 11,
        kind: 'BINARY',
        mimeType: 'application/octet-stream',
        bytes: png,
        clientDeclaredRedacted: false,
      });
    } catch (e) {
      pngErr = e;
    }
    assert(pngErr instanceof ApiError, 'png spoof rejected');

    // With attestation OK
    const pngOk = await uploadDeviceArtifact({
      taskId: tArt.id,
      deviceId: dA.id,
      seq: 12,
      kind: 'SCREENSHOT',
      mimeType: 'application/octet-stream',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    assert((pngOk.meta as { redactionMode?: string }).redactionMode === 'client-attested', 'client-attested');

    // TTL too long
    let ttlErr: unknown;
    try {
      await uploadDeviceArtifact({
        taskId: tArt.id,
        deviceId: dA.id,
        seq: 13,
        kind: 'LOG',
        mimeType: 'text/plain',
        bytes: Buffer.from('ok'),
        clientDeclaredRedacted: false,
        ttlMs: MAX_ARTIFACT_TTL_MS + 1,
      });
    } catch (e) {
      ttlErr = e;
    }
    assert(ttlErr instanceof ApiError, 'TTL cap');

    // Wrong device
    let wrongDev: unknown;
    try {
      await uploadDeviceArtifact({
        taskId: tArt.id,
        deviceId: dB.id,
        seq: 14,
        kind: 'LOG',
        mimeType: 'text/plain',
        bytes: Buffer.from('x'),
        clientDeclaredRedacted: false,
      });
    } catch (e) {
      wrongDev = e;
    }
    assert(wrongDev instanceof ApiError, 'wrong device');
    assertInsideRoot(artifactsRoot(), path.join(artifactsRoot(), pngOk.storageRelPath));
    console.log('PASS [7] artifacts');

    console.log('── [8] REST task flow ──');
    // FDE create for agent-bound kinds requires online + capabilities + binding.
    await bindAgentDevice({ agentId, deviceId: dA.id, boundBy: owner.id });
    await updateDeviceCapabilities(dA.id, {
      platform: 'MACOS',
      osVersion: '15',
      appVersion: '1',
      features: {
        computerUse: true,
        screenRecording: true,
        accessibility: true,
        screenshot: true,
      codexApp: true,
      codexCli: false,
      lineDesktop: true,
      },
      mcpServers: [],
      updatedAt: new Date().toISOString(),
    });
    deviceWs = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${eA.token}` },
    });
    await once(deviceWs, 'open');
    await new Promise((r) => setTimeout(r, 80));

    // CAPABILITY_PROBE: management kind — no confirmationRequired, optional idempotencyKey.
    // (SCREENSHOT/COMPUTER_CONTROL require FDE confirm before SUCCEEDED — covered in t07.)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: dA.id,
        kind: 'CAPABILITY_PROBE',
        payload: { features: ['computerUse'] },
        idempotencyKey: `rest-${tag}`,
      },
    });
    assert(createRes.statusCode === 201, `create ${createRes.statusCode} ${createRes.body}`);
    const created = createRes.json() as { data: { id: string } };
    taskIds.push(created.data.id);

    // Reject shell via REST (include idempotencyKey so fail is payload, not missing key)
    const shellRest = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: dA.id,
        kind: 'COMPUTER_CONTROL',
        agentId,
        idempotencyKey: `shell-${tag}`,
        payload: { shell: 'whoami', instructions: 'x' },
      },
    });
    assert(shellRest.statusCode === 400, `shell rest ${shellRest.statusCode}`);

    // Execution kind without idempotencyKey → 400
    const noIdem = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: dA.id,
        kind: 'SCREENSHOT',
        agentId,
        payload: { app: 'Finder' },
      },
    });
    assert(noIdem.statusCode === 400, `missing idempotencyKey ${noIdem.statusCode}`);

    const ackRes = await app.inject({
      method: 'POST',
      url: `/api/device/tasks/${created.data.id}/ack`,
      headers: {
        authorization: `Bearer ${eA.token}`,
        'content-type': 'application/json',
      },
      payload: {},
    });
    assert(ackRes.statusCode === 200, 'ack');
    const leaseId = (ackRes.json() as { data: { leaseId: string } }).data.leaseId;
    const resultRes = await app.inject({
      method: 'POST',
      url: `/api/device/tasks/${created.data.id}/result`,
      headers: {
        authorization: `Bearer ${eA.token}`,
        'content-type': 'application/json',
      },
      payload: {
        leaseId,
        status: 'SUCCEEDED',
        result: { tools: ['list_chats'] },
      },
    });
    assert(resultRes.statusCode === 200, `result ${resultRes.statusCode}`);
    console.log('PASS [8] REST');

    console.log('── [9] cleanup ──');
    await prisma.deviceArtifact.update({
      where: { id: logArt.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const cleaned = await cleanupExpiredArtifacts(50);
    assert(cleaned.deleted >= 1, 'cleaned');
    void eB;
    void reclaimIfExpired;
    console.log('PASS [9] cleanup');

    console.log('\n✅ t03-tasks-artifacts ALL PASS');
  } finally {
    try {
      deviceWs?.close();
    } catch {
      /* ignore */
    }
    hub.stop();
    server.close();
    await app.close();
    await prisma.deviceArtifact.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.deviceTask.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.agentDevice.deleteMany({ where: { OR: [{ agentId }, { deviceId: { in: deviceIds } }] } }).catch(() => {});
    await prisma.deviceEnrollment.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
