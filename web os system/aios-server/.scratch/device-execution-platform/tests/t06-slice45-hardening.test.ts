/**
 * Slice 4.5 — capability flags, FDE task list, user-hub lifecycle events.
 * Run: npx tsx .scratch/device-execution-platform/tests/t06-slice45-hardening.test.ts
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { ApiError } from '../../../src/lib/http.js';
import { hub, type AwpFrame } from '../../../src/ws/hub.js';
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
  createAndDispatchTask,
  ackDeviceTask,
} from '../../../src/lib/devicetask.js';
import { checkDeviceEligibility } from '../../../src/lib/deviceeligibility.js';
import {
  deviceTaskLifecyclePayload,
  publishDeviceTaskLifecycle,
} from '../../../src/lib/devicetaskevents.js';
import { LINE_DESKTOP_MANIFEST } from '../../../src/lib/devicemcp.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

const FULL = {
  platform: 'MACOS' as const,
  osVersion: '15',
  appVersion: '1',
  features: {
    computerUse: true,
    screenRecording: true,
    accessibility: true,
    screenshot: true,
    codexApp: true,
    codexCli: true,
    lineDesktop: true,
  },
  mcpServers: [] as Array<{ name: string; version: string; sha256?: string; tools: string[] }>,
  updatedAt: new Date().toISOString(),
};

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'FDE');
  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMember: string | null = null;
  if (!member) {
    createdMember = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMember,
        email: `t06-${createdMember.slice(-6)}@t.local`,
        displayName: 'T06',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const deviceIds: string[] = [];
  const taskIds: string[] = [];
  const trainerTok = await signAccess({
    sub: owner.id,
    email: owner.email,
    role: owner.role,
  });
  const memberTok = await signAccess({
    sub: member.id,
    email: member.email,
    role: 'MEMBER',
  });

  const server = createServer();
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr !== 'string', 'addr');
  const wsBase = `ws://127.0.0.1:${addr.port}`;

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(devicesRoutes);
  await app.register(deviceRoutes);

  const sockets: WebSocket[] = [];

  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t06-${tag}`,
        name: 'T06',
        description: 't',
        rolePrompt: 't',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        createdBy: owner.id,
      },
    });

    const d = await createDevice({
      ownerUserId: owner.id,
      name: `t06-${tag}`,
      platform: 'MACOS',
    });
    deviceIds.push(d.id);
    const en = await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: d.id, createdBy: owner.id })).code,
    });
    await bindAgentDevice({ agentId, deviceId: d.id, boundBy: owner.id });

    const dws = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${en.token}` },
    });
    sockets.push(dws);
    await once(dws, 'open');
    await settle();

    console.log('── [1] codexApp / lineDesktop negative eligibility ──');
    // wire default: omit new flags → false
    await prisma.device.update({
      where: { id: d.id },
      data: {
        capabilities: {
          platform: 'MACOS',
          osVersion: '15',
          appVersion: '1',
          features: {
            computerUse: true,
            screenRecording: true,
            accessibility: true,
            screenshot: true,
            // codexApp/lineDesktop omitted
          },
          mcpServers: [],
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const noCodex = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'computer_use',
    });
    assert(!noCodex.eligible, 'generic computerUse without codexApp rejected');
    assert((noCodex.reason ?? '').toLowerCase().includes('codexapp'), noCodex.reason);

    await prisma.deviceMcpInstallation.upsert({
      where: {
        deviceId_mcpKey: { deviceId: d.id, mcpKey: LINE_DESKTOP_MANIFEST.mcpKey },
      },
      create: {
        id: ulid(),
        deviceId: d.id,
        mcpKey: LINE_DESKTOP_MANIFEST.mcpKey,
        packageName: LINE_DESKTOP_MANIFEST.packageName,
        version: LINE_DESKTOP_MANIFEST.version,
        sha256: LINE_DESKTOP_MANIFEST.sha256,
        status: 'READY',
        toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
        riskTier: 'high',
        approvalRequired: true,
      },
      update: {
        status: 'READY',
        version: LINE_DESKTOP_MANIFEST.version,
        sha256: LINE_DESKTOP_MANIFEST.sha256,
        toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
      },
    });
    const noLine = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'line_desktop',
    });
    assert(!noLine.eligible, 'missing lineDesktop flag rejected');
    assert((noLine.reason ?? '').toLowerCase().includes('linedesktop'), noLine.reason);

    await updateDeviceCapabilities(d.id, FULL);
    const okCu = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'computer_use',
    });
    assert(okCu.eligible && okCu.device?.features?.codexApp === true, 'codexApp exposed');
    console.log('PASS [1] feature flags');

    console.log('── [2] FDE task list auth + filters ──');
    const t1 = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'SCREENSHOT',
      agentId,
      payload: { app: 'a' },
      idempotencyKey: `t06-a-${tag}`,
      requestedByUserId: owner.id,
    });
    const t2 = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'CAPABILITY_PROBE',
      payload: {},
      idempotencyKey: `t06-b-${tag}`,
      requestedByUserId: owner.id,
    });
    taskIds.push(t1.id, t2.id);

    const memList = await app.inject({
      method: 'GET',
      url: '/api/device-tasks',
      headers: { authorization: `Bearer ${memberTok}` },
    });
    assert(memList.statusCode === 403, `member list ${memList.statusCode}`);

    const list = await app.inject({
      method: 'GET',
      url: `/api/device-tasks?deviceId=${d.id}&limit=10`,
      headers: { authorization: `Bearer ${trainerTok}` },
    });
    assert(list.statusCode === 200, list.body);
    const body = list.json() as { data: Array<Record<string, unknown>> };
    assert(Array.isArray(body.data), 'array');
    assert(body.data.length >= 2, 'has tasks');
    assert(body.data[0]!.createdAt >= body.data[1]!.createdAt || body.data.length === 1, 'newest-ish');
    for (const row of body.data) {
      assert(typeof row.id === 'string', 'id');
      assert(typeof row.deviceId === 'string', 'deviceId');
      assert(typeof row.status === 'string', 'status');
      assert(!('payload' in row), 'no payload');
      assert(!('result' in row), 'no result');
      assert(!('error' in row), 'no error');
      assert(!('tokenHash' in row), 'no token');
      assert(typeof row.hasLease === 'boolean', 'hasLease not leaseId secret');
    }

    const filt = await app.inject({
      method: 'GET',
      url: `/api/device-tasks?agentId=${agentId}&status=DISPATCHED`,
      headers: { authorization: `Bearer ${trainerTok}` },
    });
    assert(filt.statusCode === 200, filt.body);
    const filtBody = filt.json() as { data: Array<{ agentId: string; status: string }> };
    assert(filtBody.data.every((r) => r.agentId === agentId && r.status === 'DISPATCHED'), 'filter');
    console.log('PASS [2] task list');

    console.log('── [3] user-hub lifecycle payload ──');
    const userTok = await signAccess({
      sub: owner.id,
      email: owner.email,
      role: owner.role,
    });
    const uws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(userTok)}`);
    sockets.push(uws);
    const frames: AwpFrame[] = [];
    uws.on('message', (data) => frames.push(JSON.parse(data.toString()) as AwpFrame));
    await once(uws, 'open');
    uws.send(
      JSON.stringify({
        v: 1,
        id: ulid(),
        kind: 'req',
        topic: 'sub',
        ts: new Date().toISOString(),
        payload: { topics: ['device.task.*'] },
      }),
    );
    await settle();

    const safe = deviceTaskLifecyclePayload({
      id: t1.id,
      deviceId: d.id,
      status: 'ACKED',
      runId: 'run-x',
      agentId,
    });
    assert(Object.keys(safe).sort().join() === 'agentId,deviceId,runId,status,taskId', 'keys only');
    publishDeviceTaskLifecycle('device.task.create', {
      id: t1.id,
      deviceId: d.id,
      status: 'DISPATCHED',
      runId: null,
      agentId,
    });
    await settle(100);
    const createEv = frames.find((f) => f.topic === 'device.task.create');
    assert(!!createEv, 'user hub received create');
    const pl = createEv!.payload as Record<string, unknown>;
    assert(pl.taskId === t1.id && pl.deviceId === d.id, 'ids');
    assert(!('result' in pl) && !('payload' in pl) && !('error' in pl), 'no secrets');

    // device route ack also publishes
    const ack = await ackDeviceTask({ taskId: t1.id, deviceId: d.id });
    // publish manually to mirror route (lib path) — route path:
    const ackRes = await app.inject({
      method: 'POST',
      url: `/api/device/tasks/${t2.id}/ack`,
      headers: {
        authorization: `Bearer ${en.token}`,
        'content-type': 'application/json',
      },
      payload: {},
    });
    assert(ackRes.statusCode === 200, ackRes.body);
    await settle(100);
    const ackEv = frames.find((f) => f.topic === 'device.task.ack');
    assert(!!ackEv, 'ack event on user hub');
    // device socket must not be the user hub — device frames not asserted here
    void ack;
    console.log('PASS [3] lifecycle events');

    console.log('\n✅ t06-slice45-hardening ALL PASS');
  } finally {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    hub.stop();
    server.close();
    await app.close();
    await prisma.deviceTask.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.deviceMcpInstallation.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.agentDevice.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.deviceEnrollment.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    if (createdMember) await prisma.user.delete({ where: { id: createdMember } }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
