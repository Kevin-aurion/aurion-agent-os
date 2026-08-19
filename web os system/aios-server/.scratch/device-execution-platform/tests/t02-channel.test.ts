/**
 * Slice 02 — Device WebSocket channel (Bearer-only, revoke/rotate disconnect).
 * Run: npx tsx .scratch/device-execution-platform/tests/t02-channel.test.ts
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { Hub, type AwpFrame } from '../../../src/ws/hub.js';
import {
  createDevice,
  issueEnrollmentCode,
  enrollWithCode,
  revokeDevice,
  rotateDeviceToken,
  authenticateDeviceToken,
} from '../../../src/lib/device.js';
import { deviceRoutes } from '../../../src/routes/device.js';
import { devicesRoutes } from '../../../src/routes/devices.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function collect(ws: WebSocket): AwpFrame[] {
  const frames: AwpFrame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString()) as AwpFrame));
  return frames;
}

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

async function expectWsReject(url: string, opts?: ConstructorParameters<typeof WebSocket>[1]): Promise<void> {
  const ws = new WebSocket(url, opts as any);
  try {
    await Promise.race([
      once(ws, 'open').then(() => {
        throw new Error('should not open');
      }),
      once(ws, 'unexpected-response'),
      once(ws, 'error'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting reject')), 3000)),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message === 'should not open') throw err;
    // error/unexpected-response is success
  } finally {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need FDE user');
  const trainerToken = await signAccess({
    sub: owner.id,
    email: owner.email,
    role: owner.role,
  });

  const tag = ulid().slice(-8).toLowerCase();
  const deviceIds: string[] = [];

  // Shared hub for WS + routes (revoke/rotate must cut live sockets).
  const hub = new Hub();
  // Patch module singleton used by routes by attaching same methods — routes import hub from module.
  // Use real module hub for route disconnect tests:
  const { hub: moduleHub, disconnectDevice } = await import('../../../src/ws/hub.js');

  const server = createServer();
  moduleHub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string', 'tcp address');
  const port = address.port;
  const wsBase = `ws://127.0.0.1:${port}`;

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
  await app.register(deviceRoutes);
  await app.register(devicesRoutes);

  const sockets: WebSocket[] = [];

  try {
    const d1 = await createDevice({
      ownerUserId: owner.id,
      name: `WS A ${tag}`,
      platform: 'MACOS',
    });
    deviceIds.push(d1.id);
    const c1 = await issueEnrollmentCode({ deviceId: d1.id, createdBy: owner.id });
    const e1 = await enrollWithCode({ code: c1.code });

    console.log('── [1] query / subprotocol credential rejected ──');
    await expectWsReject(`${wsBase}/device/ws?token=${encodeURIComponent(e1.token)}`);
    await expectWsReject(`${wsBase}/device/ws`, {
      headers: { 'Sec-WebSocket-Protocol': `aios-device.${e1.token}` },
    } as any);
    await expectWsReject(`${wsBase}/device/ws`, {
      headers: { 'Sec-WebSocket-Protocol': `aios-device, ${e1.token}` },
    } as any);
    // Protocol-only without Bearer
    await expectWsReject(`${wsBase}/device/ws`, {
      headers: { 'Sec-WebSocket-Protocol': 'aios-device' },
    } as any);
    console.log('PASS [1] query/subprotocol credential rejected');

    console.log('── [2] bearer connect + hello ──');
    const ws1 = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${e1.token}` },
    });
    sockets.push(ws1);
    const frames1 = collect(ws1);
    await once(ws1, 'open');
    await settle(100);
    assert(
      frames1.some((f) => f.kind === 'event' && f.topic === 'device.hello'),
      'device.hello',
    );
    assert(moduleHub.isDeviceOnline(d1.id), 'online with fresh pong');
    console.log('PASS [2] bearer + hello');

    console.log('── [3] wrong token rejected ──');
    await expectWsReject(`${wsBase}/device/ws`, {
      headers: { Authorization: 'Bearer deadbeefdeadbeefdeadbeefdeadbeef' },
    } as any);
    console.log('PASS [3] wrong token');

    console.log('── [4] publish isolation + second device ──');
    const d3 = await createDevice({
      ownerUserId: owner.id,
      name: `WS C ${tag}`,
      platform: 'LINUX',
    });
    deviceIds.push(d3.id);
    const e3 = await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: d3.id, createdBy: owner.id })).code,
    });
    const ws3 = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${e3.token}` },
    });
    sockets.push(ws3);
    const frames3 = collect(ws3);
    await once(ws3, 'open');
    await settle(80);

    assert(moduleHub.publishToDevice(d1.id, 'device.task', { marker: 'only-1' }), 'pub1');
    assert(moduleHub.publishToDevice(d3.id, 'device.task', { marker: 'only-3' }), 'pub3');
    await settle(100);
    const p1 = frames1
      .filter((f) => f.topic === 'device.task')
      .map((f) => (f.payload as { marker?: string })?.marker);
    const p3 = frames3
      .filter((f) => f.topic === 'device.task')
      .map((f) => (f.payload as { marker?: string })?.marker);
    assert(p1.includes('only-1') && !p1.includes('only-3'), 'd1 isolation');
    assert(p3.includes('only-3') && !p3.includes('only-1'), 'd3 isolation');
    console.log('PASS [4] isolation');

    console.log('── [5] no user ring bleed ──');
    moduleHub.publish('chat.message', { marker: 'user-public' });
    await settle(80);
    assert(
      !frames1.some((f) => f.topic === 'chat.message'),
      'device must not receive user events',
    );
    console.log('PASS [5] no ring bleed');

    console.log('── [6] capabilities + query REST ──');
    const goodCap = {
      platform: 'MACOS',
      osVersion: '15.1',
      appVersion: '2.0.0',
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
    };
    const capOk = await app.inject({
      method: 'PUT',
      url: '/api/device/capabilities',
      headers: {
        authorization: `Bearer ${e1.token}`,
        'content-type': 'application/json',
      },
      payload: goodCap,
    });
    assert(capOk.statusCode === 200, `cap ok ${capOk.statusCode}`);
    const qTok = await app.inject({
      method: 'GET',
      url: `/api/device/me?token=${encodeURIComponent(e1.token)}`,
    });
    assert(qTok.statusCode === 401, 'query token REST rejected');
    console.log('PASS [6] capabilities');

    console.log('── [7] revoke disconnects WS ──');
    const beforeRev = frames1.length;
    const revRes = await app.inject({
      method: 'POST',
      url: `/api/devices/${d1.id}/revoke`,
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    assert(revRes.statusCode === 200, `revoke ${revRes.statusCode}`);
    await settle(150);
    assert(!moduleHub.isDeviceOnline(d1.id), 'offline after revoke');
    assert(
      !moduleHub.publishToDevice(d1.id, 'device.task', { marker: 'after-revoke' }),
      'publish false after revoke',
    );
    assert(ws1.readyState === WebSocket.CLOSED || ws1.readyState === WebSocket.CLOSING, 'socket closed');
    // no new task frames
    assert(
      !frames1.slice(beforeRev).some((f) => (f.payload as { marker?: string })?.marker === 'after-revoke'),
      'no event after revoke',
    );
    void disconnectDevice;
    console.log('PASS [7] revoke disconnect');

    console.log('── [8] rotate disconnects old WS ──');
    const dRot = await createDevice({
      ownerUserId: owner.id,
      name: `RotWS ${tag}`,
      platform: 'MACOS',
    });
    deviceIds.push(dRot.id);
    const eRot = await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: dRot.id, createdBy: owner.id })).code,
    });
    const wsRot = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${eRot.token}` },
    });
    sockets.push(wsRot);
    await once(wsRot, 'open');
    await settle(80);
    assert(moduleHub.isDeviceOnline(dRot.id), 'rot online');
    const rotRes = await app.inject({
      method: 'POST',
      url: `/api/devices/${dRot.id}/rotate`,
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    assert(rotRes.statusCode === 200, 'rotate ok');
    await settle(150);
    assert(!moduleHub.isDeviceOnline(dRot.id), 'offline until reconnect');
    assert(!moduleHub.publishToDevice(dRot.id, 'device.task', { marker: 'old' }), 'publish false');
    assert(wsRot.readyState === WebSocket.CLOSED || wsRot.readyState === WebSocket.CLOSING, 'old closed');
    const newTok = (rotRes.json() as { data: { token: string } }).data.token;
    const wsNew = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${newTok}` },
    });
    sockets.push(wsNew);
    await once(wsNew, 'open');
    await settle(80);
    assert(moduleHub.isDeviceOnline(dRot.id), 'online with new token');
    console.log('PASS [8] rotate disconnect + reconnect');

    console.log('── [9] user JWT not device token ──');
    let jwtRejected = false;
    try {
      await authenticateDeviceToken(trainerToken);
    } catch {
      jwtRejected = true;
    }
    assert(jwtRejected, 'user JWT rejected');
    // stale hub instance unused
    void hub;
    void revokeDevice;
    void rotateDeviceToken;
    console.log('PASS [9] user JWT');

    console.log('\n✅ t02-channel ALL PASS');
  } finally {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    moduleHub.stop();
    server.close();
    await app.close();
    await prisma.deviceEnrollment.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
