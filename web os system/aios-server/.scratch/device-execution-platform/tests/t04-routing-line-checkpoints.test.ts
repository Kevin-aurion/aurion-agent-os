/**
 * Slice 04 — Targeted routing, LINE MCP, confirmation checkpoints.
 * Run: npx tsx .scratch/device-execution-platform/tests/t04-routing-line-checkpoints.test.ts
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
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
  revokeDevice,
  updateDeviceCapabilities,
} from '../../../src/lib/device.js';
import {
  createAndDispatchTask,
  ackDeviceTask,
  reportDeviceTaskProgress,
  completeDeviceTask,
  confirmDeviceTaskCheckpoint,
  rejectDeviceTaskCheckpoint,
  cancelDeviceTask,
} from '../../../src/lib/devicetask.js';
import { uploadDeviceArtifact } from '../../../src/lib/deviceartifact.js';
import { checkDeviceEligibility, listEligibleDevices } from '../../../src/lib/deviceeligibility.js';
import {
  requestLineDesktopInstall,
  LINE_DESKTOP_MANIFEST,
  reconcileDeviceMcpFromCapabilities,
} from '../../../src/lib/devicemcp.js';
import { validateDeviceTaskPayload } from '../../../src/lib/devicetaskpayload.js';
import { createApproval, decideApproval, isRunApproved } from '../../../src/lib/approval.js';
import { isApproved } from '../../../src/engine/codex.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function collect(ws: WebSocket): AwpFrame[] {
  const frames: AwpFrame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString()) as AwpFrame));
  return frames;
}

async function settle(ms = 100) {
  await new Promise((r) => setTimeout(r, ms));
}

const GOOD_CAPS = {
  platform: 'MACOS' as const,
  osVersion: '15.0',
  appVersion: '1.0.0',
  features: {
    computerUse: true,
    screenRecording: true,
    accessibility: true,
    screenshot: true,
      codexApp: true,
      codexCli: false,
      lineDesktop: true,
  },
  mcpServers: [
    {
      name: LINE_DESKTOP_MANIFEST.packageName,
      version: LINE_DESKTOP_MANIFEST.version,
      sha256: LINE_DESKTOP_MANIFEST.sha256,
      tools: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
    },
  ],
  updatedAt: new Date().toISOString(),
};

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need FDE');
  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMember: string | null = null;
  if (!member) {
    createdMember = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMember,
        email: `t04-m-${createdMember.slice(-6)}@test.local`,
        displayName: 'T04 Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const deviceIds: string[] = [];
  const taskIds: string[] = [];

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

  const server = createServer();
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr !== 'string', 'addr');
  const wsBase = `ws://127.0.0.1:${addr.port}`;

  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
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
        slug: `t04-agent-${tag}`,
        name: 'T04 Agent',
        description: 'temp',
        rolePrompt: 'test',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        createdBy: owner.id,
        restrictions: {
          webSearch: false,
          computerUse: true,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
        },
      },
    });

    const dA = await createDevice({
      ownerUserId: owner.id,
      name: `T04-A ${tag}`,
      platform: 'MACOS',
    });
    const dB = await createDevice({
      ownerUserId: owner.id,
      name: `T04-B ${tag}`,
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
    // dB not bound

    // Connect device WS
    const wsA = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${eA.token}` },
    });
    sockets.push(wsA);
    const framesA = collect(wsA);
    await once(wsA, 'open');

    const wsB = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${eB.token}` },
    });
    sockets.push(wsB);
    const framesB = collect(wsB);
    await once(wsB, 'open');
    await settle(120);

    // User WS for public subscriber isolation
    const userTok = await signAccess({
      sub: owner.id,
      email: owner.email,
      role: owner.role,
    });
    const wsUser = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(userTok)}`);
    sockets.push(wsUser);
    const framesUser = collect(wsUser);
    await once(wsUser, 'open');
    wsUser.send(
      JSON.stringify({
        v: 1,
        id: ulid(),
        kind: 'req',
        topic: 'sub',
        ts: new Date().toISOString(),
        payload: { topics: ['*'] },
      }),
    );
    await settle(80);

    await updateDeviceCapabilities(dA.id, GOOD_CAPS);
    // Create READY MCP install row via reconcile
    await prisma.deviceMcpInstallation.create({
      data: {
        id: ulid(),
        deviceId: dA.id,
        mcpKey: LINE_DESKTOP_MANIFEST.mcpKey,
        packageName: LINE_DESKTOP_MANIFEST.packageName,
        version: LINE_DESKTOP_MANIFEST.version,
        sha256: LINE_DESKTOP_MANIFEST.sha256,
        status: 'READY',
        toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
        riskTier: 'high',
        approvalRequired: true,
        installedBy: owner.id,
      },
    });
    await reconcileDeviceMcpFromCapabilities(dA.id, GOOD_CAPS);

    console.log('── [1] target device only for publish ──');
    const task = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's1', instructions: 'click' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `t04-cc-${tag}`,
    });
    taskIds.push(task.id);
    const woke = hub.publishToDevice(dA.id, 'device.task', { taskId: task.id, marker: 'for-a' });
    assert(woke, 'wake a');
    hub.publishToDevice(dB.id, 'device.task', { taskId: 'x', marker: 'for-b' });
    await settle(100);
    assert(
      framesA.some((f) => f.topic === 'device.task' && (f.payload as { marker?: string })?.marker === 'for-a'),
      'A receives',
    );
    assert(
      !framesB.some((f) => (f.payload as { marker?: string })?.marker === 'for-a'),
      'B no leak',
    );
    assert(
      !framesUser.some((f) => f.topic === 'device.task' && (f.payload as { marker?: string })?.marker === 'for-a'),
      'user public sub no device.task',
    );
    console.log('PASS [1] targeted publish');

    console.log('── [2] eligibility fail-closed matrix ──');
    // offline: stop dB and check
    hub.disconnectDevice(dB.id);
    await settle(50);
    const offline = await checkDeviceEligibility({
      deviceId: dB.id,
      agentId,
      requirement: 'computer_use',
    });
    assert(!offline.eligible && offline.reasonCode === 'DEVICE_OFFLINE', 'offline');

    const unbound = await checkDeviceEligibility({
      deviceId: dB.id,
      agentId,
      requirement: 'computer_use',
    });
    // also not bound
    assert(!unbound.eligible, 'unbound or offline');

    const notBoundA = await checkDeviceEligibility({
      deviceId: dA.id,
      agentId: ulid(),
      requirement: 'computer_use',
    });
    assert(!notBoundA.eligible && notBoundA.reasonCode === 'NOT_BOUND', 'not bound agent');

    // feature false — write capabilities JSON directly then re-check
    assert(hub.isDeviceOnline(dA.id), 'A still online before feature test');
    wsA.send(
      JSON.stringify({
        v: 1,
        id: ulid(),
        kind: 'req',
        topic: 'device.heartbeat',
        ts: new Date().toISOString(),
        payload: {},
      }),
    );
    await settle(50);
    await prisma.device.update({
      where: { id: dA.id },
      data: {
        capabilities: {
          platform: 'MACOS',
          osVersion: '15.0',
          appVersion: '1.0.0',
          features: {
            computerUse: false,
            screenRecording: true,
            accessibility: true,
            screenshot: true,
      codexApp: true,
      codexCli: false,
      lineDesktop: true,
          },
          mcpServers: [],
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const feat = await checkDeviceEligibility({
      deviceId: dA.id,
      agentId,
      requirement: 'computer_use',
    });
    assert(
      !feat.eligible && feat.reasonCode === 'FEATURE_MISSING',
      `feature got ${feat.reasonCode} ${feat.reason}`,
    );
    await updateDeviceCapabilities(dA.id, GOOD_CAPS);

    // Ensure install row ready with correct baseline (avoid reconcile overwriting mid-test)
    await prisma.deviceMcpInstallation.updateMany({
      where: { deviceId: dA.id, mcpKey: LINE_DESKTOP_MANIFEST.mcpKey },
      data: {
        version: '0.0.1',
        sha256: LINE_DESKTOP_MANIFEST.sha256,
        toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
        status: 'READY',
      },
    });
    const ver = await checkDeviceEligibility({
      deviceId: dA.id,
      agentId,
      requirement: 'line_desktop',
    });
    assert(
      !ver.eligible && ver.reasonCode === 'MCP_VERSION_MISMATCH',
      `version got ${ver.reasonCode} ${ver.reason}`,
    );

    await prisma.deviceMcpInstallation.updateMany({
      where: { deviceId: dA.id, mcpKey: LINE_DESKTOP_MANIFEST.mcpKey },
      data: {
        version: LINE_DESKTOP_MANIFEST.version,
        sha256: '0'.repeat(64),
        status: 'READY',
      },
    });
    const sha = await checkDeviceEligibility({
      deviceId: dA.id,
      agentId,
      requirement: { kind: 'line_tool', tool: 'send_message_manual' },
    });
    assert(
      !sha.eligible && sha.reasonCode === 'MCP_SHA_MISMATCH',
      `sha got ${sha.reasonCode} ${sha.reason}`,
    );

    await prisma.deviceMcpInstallation.updateMany({
      where: { deviceId: dA.id, mcpKey: LINE_DESKTOP_MANIFEST.mcpKey },
      data: {
        sha256: LINE_DESKTOP_MANIFEST.sha256,
        // missing required tools from pinned allowlist
        toolAllowlist: ['get_line_chatroom_history_default'],
        status: 'READY',
      },
    });
    const toolMiss = await checkDeviceEligibility({
      deviceId: dA.id,
      agentId,
      requirement: { kind: 'line_tool', tool: 'send_message_manual' },
    });
    assert(!toolMiss.eligible, `tool missing got ${toolMiss.reasonCode}`);

    await prisma.deviceMcpInstallation.updateMany({
      where: { deviceId: dA.id, mcpKey: LINE_DESKTOP_MANIFEST.mcpKey },
      data: {
        toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
        status: 'READY',
        version: LINE_DESKTOP_MANIFEST.version,
        sha256: LINE_DESKTOP_MANIFEST.sha256,
      },
    });

    // revoked
    const dRev = await createDevice({
      ownerUserId: owner.id,
      name: `rev ${tag}`,
      platform: 'LINUX',
    });
    deviceIds.push(dRev.id);
    await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: dRev.id, createdBy: owner.id })).code,
    });
    await bindAgentDevice({ agentId, deviceId: dRev.id, boundBy: owner.id });
    await revokeDevice({ deviceId: dRev.id, actorUserId: owner.id });
    const rev = await checkDeviceEligibility({
      deviceId: dRev.id,
      agentId,
      requirement: 'computer_use',
    });
    assert(!rev.eligible && rev.reasonCode === 'DEVICE_NOT_ACTIVE', 'revoked');

    const list = await listEligibleDevices(agentId, 'computer_use');
    assert(list.devices.every((d) => d.online), 'only online');
    assert(list.devices.some((d) => d.id === dA.id), 'A eligible');
    assert(!list.devices.some((d) => d.id === dB.id), 'B not in list');
    console.log('PASS [2] eligibility matrix');

    console.log('── [3] offline wake cancels task ──');
    hub.disconnectDevice(dA.id);
    await settle(40);
    const createOff = await app.inject({
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
        payload: { skillId: 's2', instructions: 'x' },
        idempotencyKey: `off-${tag}`,
      },
    });
    assert(createOff.statusCode === 400, `offline create ${createOff.statusCode} ${createOff.body}`);
    // no executable pending left for that key with DISPATCHED wake — cancelled or never left pending runnable
    const stuck = await prisma.deviceTask.findMany({
      where: { deviceId: dA.id, idempotencyKey: `off-${tag}` },
    });
    for (const t of stuck) {
      taskIds.push(t.id);
      assert(
        t.status === 'CANCELLED' || t.status === 'FAILED' || t.status === 'TIMEOUT',
        `no runnable pending after offline wake, got ${t.status}`,
      );
    }
    // reconnect A
    const wsA2 = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${eA.token}` },
    });
    sockets.push(wsA2);
    await once(wsA2, 'open');
    await settle(80);
    console.log('PASS [3] offline wake');

    console.log('── [4] confirmation checkpoints ──');
    const tConf = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's3', instructions: 'confirm me' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `conf-${tag}`,
    });
    taskIds.push(tConf.id);
    hub.publishToDevice(dA.id, 'device.task', { taskId: tConf.id });
    const ack = await ackDeviceTask({ taskId: tConf.id, deviceId: dA.id, leaseMs: 120_000 });

    // AWAITING_CONFIRM without artifact
    let noArt: unknown;
    try {
      await reportDeviceTaskProgress({
        taskId: tConf.id,
        deviceId: dA.id,
        leaseId: ack.leaseId!,
        progress: { phase: 'checkpoint' },
        status: 'AWAITING_CONFIRM',
      });
    } catch (e) {
      noArt = e;
    }
    assert(noArt instanceof ApiError, 'no artifact reject');

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const art = await uploadDeviceArtifact({
      taskId: tConf.id,
      deviceId: dA.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });

    // wrong artifact task — create another task artifact attempt
    const tOther = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'SCREENSHOT',
      payload: { app: 'x' },
      agentId,
      idempotencyKey: `other-${tag}`,
    });
    taskIds.push(tOther.id);
    await ackDeviceTask({ taskId: tOther.id, deviceId: dA.id });

    let wrongArt: unknown;
    try {
      await reportDeviceTaskProgress({
        taskId: tConf.id,
        deviceId: dA.id,
        leaseId: ack.leaseId!,
        progress: {},
        status: 'AWAITING_CONFIRM',
        confirmationArtifactId: 'not-an-artifact',
      });
    } catch (e) {
      wrongArt = e;
    }
    assert(wrongArt instanceof ApiError, 'bad artifact id');

    await reportDeviceTaskProgress({
      taskId: tConf.id,
      deviceId: dA.id,
      leaseId: ack.leaseId!,
      progress: { phase: 'awaiting' },
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: art.id,
    });

    // wrong user confirm
    const badUser = await app.inject({
      method: 'POST',
      url: `/api/device-tasks/${tConf.id}/confirm`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(badUser.statusCode === 403, `wrong user ${badUser.statusCode}`);

    // expired lease
    await prisma.deviceTask.update({
      where: { id: tConf.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    let expLease: unknown;
    try {
      await confirmDeviceTaskCheckpoint({
        taskId: tConf.id,
        actorUserId: owner.id,
        actorRole: 'OWNER',
      });
    } catch (e) {
      expLease = e;
    }
    assert(expLease instanceof ApiError, 'expired lease confirm');

    // restore lease for success path on new task
    const tConf2 = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's4', instructions: 'ok' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `conf2-${tag}`,
    });
    taskIds.push(tConf2.id);
    const ack2 = await ackDeviceTask({ taskId: tConf2.id, deviceId: dA.id, leaseMs: 120_000 });
    const art2 = await uploadDeviceArtifact({
      taskId: tConf2.id,
      deviceId: dA.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tConf2.id,
      deviceId: dA.id,
      leaseId: ack2.leaseId!,
      progress: {},
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: art2.id,
    });
    const confOk = await app.inject({
      method: 'POST',
      url: `/api/device-tasks/${tConf2.id}/confirm`,
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    assert(confOk.statusCode === 200, `confirm ${confOk.statusCode} ${confOk.body}`);
    const confBody = confOk.json() as { data: { status: string } };
    assert(confBody.data.status === 'RUNNING', 'RUNNING after confirm');

    // reject path
    const tRej = await createAndDispatchTask({
      deviceId: dA.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's5', instructions: 'rej' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `rej-${tag}`,
    });
    taskIds.push(tRej.id);
    const ack3 = await ackDeviceTask({ taskId: tRej.id, deviceId: dA.id });
    const art3 = await uploadDeviceArtifact({
      taskId: tRej.id,
      deviceId: dA.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tRej.id,
      deviceId: dA.id,
      leaseId: ack3.leaseId!,
      progress: {},
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: art3.id,
    });
    const rej = await app.inject({
      method: 'POST',
      url: `/api/device-tasks/${tRej.id}/reject`,
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: { reason: 'nope' },
    });
    assert(rej.statusCode === 200, 'reject');
    const rejRow = await prisma.deviceTask.findUnique({ where: { id: tRej.id } });
    assert(rejRow?.status === 'CANCELLED', 'cancelled');
    console.log('PASS [4] confirmation');

    console.log('── [5] LINE read/send approval ──');
    // read eligible
    const readElig = await checkDeviceEligibility({
      deviceId: dA.id,
      agentId,
      requirement: { kind: 'line_tool', tool: 'get_line_chatroom_history_default' },
    });
    assert(readElig.eligible, `read elig ${readElig.reasonCode}`);

    // send without approval via FDE create
    const sendNo = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: dA.id,
        kind: 'LINE_DESKTOP',
        agentId,
        runId: ulid(),
        payload: { operation: 'send', tool: 'send_message_manual', args: {} },
      },
    });
    assert(sendNo.statusCode === 403 || sendNo.statusCode === 400, `send no approval ${sendNo.statusCode}`);

    // real approval
    const runId = ulid();
    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: owner.id,
        status: 'AWAITING_REVIEW',
        input: {},
        runDir: `/tmp/t04-${runId}`,
      },
    });
    const { id: approvalId } = await createApproval({
      runId,
      agentId,
      reason: 'LINE send test',
      payload: {},
    });
    assert(!(await isRunApproved(runId)), 'not approved yet');
    // fake approval id
    assert(!(await isRunApproved(runId, 'fake-approval-id')), 'fake id');
    await decideApproval(approvalId, true, owner.id);
    assert(await isRunApproved(runId, approvalId), 'real approved');
    assert(await isRunApproved(runId), 'by runId');

    const sendOk = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: dA.id,
        kind: 'LINE_DESKTOP',
        agentId,
        runId,
        payload: { operation: 'send', tool: 'send_message_auto', args: { text: 'hi' } },
        idempotencyKey: `send-${tag}`,
      },
    });
    assert(sendOk.statusCode === 201, `send ok ${sendOk.statusCode} ${sendOk.body}`);
    const sendTaskId = (sendOk.json() as { data: { id: string } }).data.id;
    taskIds.push(sendTaskId);
    console.log('PASS [5] LINE approval');

    console.log('── [6] MCP_INSTALL fixed manifest only ──');
    let badInstall: unknown;
    try {
      validateDeviceTaskPayload('MCP_INSTALL', {
        mcpKey: 'line-desktop-mcp',
        packageName: 'line-desktop-mcp',
        version: '9.9.9',
        sha256: LINE_DESKTOP_MANIFEST.sha256,
        toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
        transport: 'device-local-stdio',
      });
    } catch (e) {
      badInstall = e;
    }
    assert(badInstall instanceof ApiError, 'custom version rejected');

    let cmdInstall: unknown;
    try {
      validateDeviceTaskPayload('MCP_INSTALL', {
        mcpKey: 'line-desktop-mcp',
        packageName: 'line-desktop-mcp',
        version: LINE_DESKTOP_MANIFEST.version,
        sha256: LINE_DESKTOP_MANIFEST.sha256,
        toolAllowlist: [...LINE_DESKTOP_MANIFEST.toolAllowlist],
        transport: 'device-local-stdio',
        command: '/bin/evil',
      });
    } catch (e) {
      cmdInstall = e;
    }
    assert(cmdInstall instanceof ApiError, 'command rejected');

    // MEMBER cannot install
    const memInstall = await app.inject({
      method: 'POST',
      url: `/api/devices/${dA.id}/mcp/line-desktop/install`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(memInstall.statusCode === 403, 'member install 403');
    console.log('PASS [6] MCP_INSTALL');

    console.log('── [7] execute!=verify invariant still holds ──');
    // Agent has engineExecute CLAUDE_CODE and engineVerify GROK
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    assert(agent?.engineExecute !== agent?.engineVerify, 'execute != verify');
    // isApproved fail-closed: ISSUES FOUND (reject) wins over later APPROVED echo
    assert(isApproved('ISSUES FOUND: bad\n## Verdict\nAPPROVED') === false, 'reject-first');
    assert(isApproved('## Verdict\nAPPROVED') === true, 'approved');
    console.log('PASS [7] invariants');

    console.log('── [8] eligible REST ──');
    const eligRest = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/eligible-devices?requirement=computer_use`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(eligRest.statusCode === 200, 'eligible rest');
    const eligData = eligRest.json() as { data: { devices: Array<{ id: string }> } };
    assert(eligData.data.devices.every((d) => d.id !== dB.id), 'offline/unbound not listed');
    console.log('PASS [8] eligible REST');

    void eB;
    void cancelDeviceTask;
    void rejectDeviceTaskCheckpoint;
    void completeDeviceTask;
    void requestLineDesktopInstall;

    console.log('\n✅ t04-routing-line-checkpoints ALL PASS');
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
    await prisma.deviceArtifact.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.deviceTask.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.deviceMcpInstallation.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.agentDevice.deleteMany({ where: { OR: [{ agentId }, { deviceId: { in: deviceIds } }] } }).catch(() => {});
    await prisma.deviceEnrollment.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } }).catch(() => {});
    await prisma.approvalRequest.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.run.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    if (createdMember) await prisma.user.delete({ where: { id: createdMember } }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
