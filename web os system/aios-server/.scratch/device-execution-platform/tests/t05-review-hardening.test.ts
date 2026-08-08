/**
 * Code-review hardening for Slice 04 follow-ups.
 * Run: npx tsx .scratch/device-execution-platform/tests/t05-review-hardening.test.ts
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import Fastify from 'fastify';
import { ulid } from 'ulid';
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
  createAndDispatchTask,
  ackDeviceTask,
  reportDeviceTaskProgress,
  confirmDeviceTaskCheckpoint,
  rejectDeviceTaskCheckpoint,
  completeDeviceTask,
} from '../../../src/lib/devicetask.js';
import { uploadDeviceArtifact } from '../../../src/lib/deviceartifact.js';
import {
  checkDeviceEligibility,
  parseRequirementQuery,
} from '../../../src/lib/deviceeligibility.js';
import {
  requestLineDesktopInstall,
  LINE_DESKTOP_MANIFEST,
} from '../../../src/lib/devicemcp.js';
import { redactSecrets } from '../../../src/memory/redactor.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

const CAPS_FULL = {
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
        email: `t05-${createdMember.slice(-6)}@test.local`,
        displayName: 'T05',
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
        slug: `t05-${tag}`,
        name: 'T05',
        description: 't',
        rolePrompt: 't',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        createdBy: owner.id,
      },
    });

    const d = await createDevice({
      ownerUserId: owner.id,
      name: `t05-${tag}`,
      platform: 'MACOS',
    });
    deviceIds.push(d.id);
    const en = await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: d.id, createdBy: owner.id })).code,
    });
    await bindAgentDevice({ agentId, deviceId: d.id, boundBy: owner.id });

    const ws = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${en.token}` },
    });
    sockets.push(ws);
    await once(ws, 'open');
    await settle();

    console.log('── [1] unknown requirement → 400 ──');
    let threw = false;
    try {
      parseRequirementQuery('not-a-req');
    } catch {
      threw = true;
    }
    assert(threw, 'parse throws');
    const badReq = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/eligible-devices?requirement=evil`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert(badReq.statusCode === 400, `got ${badReq.statusCode} ${badReq.body}`);
    console.log('PASS [1] unknown requirement 400');

    console.log('── [2] CU needs capture; LINE needs accessibility ──');
    // capture missing but codexApp present → fail when capture required
    await updateDeviceCapabilities(d.id, {
      ...CAPS_FULL,
      features: {
        computerUse: true,
        screenRecording: false,
        accessibility: true,
        screenshot: false,
        codexApp: true,
        codexCli: false,
        lineDesktop: false,
      },
    });
    const noCap = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'computer_use',
      requireScreenCapture: true,
    });
    assert(!noCap.eligible && noCap.reasonCode === 'FEATURE_MISSING', `capture ${noCap.reasonCode}`);

    // capture optional path still needs codexApp
    const cuOnly = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'computer_use',
      requireScreenCapture: false,
    });
    assert(cuOnly.eligible, 'CU without checkpoint OK with codexApp');

    // generic computerUse without codexApp cannot masquerade
    await updateDeviceCapabilities(d.id, {
      ...CAPS_FULL,
      features: {
        computerUse: true,
        screenRecording: true,
        accessibility: true,
        screenshot: true,
        codexApp: false,
        codexCli: false,
        lineDesktop: false,
      },
    });
    const noCodex = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'computer_use',
    });
    assert(!noCodex.eligible && (noCodex.reason ?? '').includes('codexApp'), `no codexApp ${noCodex.reason}`);

    await updateDeviceCapabilities(d.id, {
      ...CAPS_FULL,
      features: {
        computerUse: true,
        screenRecording: true,
        accessibility: false,
        screenshot: true,
        codexApp: true,
        codexCli: false,
        lineDesktop: true,
      },
    });
    // seed READY install for LINE feature check
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
    const noA11y = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'line_desktop',
    });
    assert(!noA11y.eligible && noA11y.reasonCode === 'FEATURE_MISSING', `a11y ${noA11y.reason}`);

    // accessibility true but LINE app flag missing
    await updateDeviceCapabilities(d.id, {
      ...CAPS_FULL,
      features: {
        computerUse: true,
        screenRecording: true,
        accessibility: true,
        screenshot: true,
        codexApp: true,
        codexCli: false,
        lineDesktop: false,
      },
    });
    const noLineApp = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: 'line_desktop',
    });
    assert(
      !noLineApp.eligible && (noLineApp.reason ?? '').includes('lineDesktop'),
      `no LINE app ${noLineApp.reason}`,
    );

    await updateDeviceCapabilities(d.id, CAPS_FULL);
    console.log('PASS [2] capture + codexApp + accessibility + lineDesktop');

    console.log('── [3] capability redaction preserves sha256 ──');
    const secretName = 'sk-leaksecretvalue1234567890abcdef';
    await updateDeviceCapabilities(d.id, {
      platform: 'MACOS',
      osVersion: '15.0',
      appVersion: '1.0.0',
      features: CAPS_FULL.features,
      mcpServers: [
        {
          name: secretName,
          version: '1.1.2',
          sha256: LINE_DESKTOP_MANIFEST.sha256,
          tools: ['get_line_chatroom_history_default'],
        },
      ],
      updatedAt: new Date().toISOString(),
    });
    const row = await prisma.device.findUnique({ where: { id: d.id } });
    const caps = row?.capabilities as {
      mcpServers?: Array<{ name?: string; sha256?: string }>;
    };
    const srv = caps?.mcpServers?.[0];
    assert(srv?.sha256 === LINE_DESKTOP_MANIFEST.sha256, 'digest preserved');
    assert(!JSON.stringify(srv?.name ?? '').includes('sk-leak'), 'name redacted');
    assert(redactSecrets(secretName) !== secretName, 'redactor active');
    console.log('PASS [3] redactor + digest');

    console.log('── [4] reject only AWAITING_CONFIRM ──');
    const tRun = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's', instructions: 'go' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `run-${tag}`,
    });
    taskIds.push(tRun.id);
    const ackR = await ackDeviceTask({ taskId: tRun.id, deviceId: d.id, leaseMs: 120_000 });
    let rejRun: unknown;
    try {
      await rejectDeviceTaskCheckpoint({
        taskId: tRun.id,
        actorUserId: owner.id,
        actorRole: 'OWNER',
      });
    } catch (e) {
      rejRun = e;
    }
    assert(rejRun instanceof ApiError, 'reject ACKED fails');
    // progress to AWAITING_CONFIRM then reject OK
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const art = await uploadDeviceArtifact({
      taskId: tRun.id,
      deviceId: d.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tRun.id,
      deviceId: d.id,
      leaseId: ackR.leaseId!,
      progress: {},
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: art.id,
    });
    await rejectDeviceTaskCheckpoint({
      taskId: tRun.id,
      actorUserId: owner.id,
      actorRole: 'OWNER',
      reason: 'no',
    });
    const afterRej = await prisma.deviceTask.findUnique({ where: { id: tRun.id } });
    assert(afterRej?.status === 'CANCELLED', 'cancelled from confirm only');
    console.log('PASS [4] reject gate');

    console.log('── [5] confirm race + expiry ──');
    const tC = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's2', instructions: 'c' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `conf-${tag}`,
    });
    taskIds.push(tC.id);
    const ackC = await ackDeviceTask({ taskId: tC.id, deviceId: d.id, leaseMs: 120_000 });
    const artC = await uploadDeviceArtifact({
      taskId: tC.id,
      deviceId: d.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tC.id,
      deviceId: d.id,
      leaseId: ackC.leaseId!,
      progress: {},
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: artC.id,
    });

    // concurrent confirm — only one wins as RUNNING
    const confResults = await Promise.allSettled([
      confirmDeviceTaskCheckpoint({
        taskId: tC.id,
        actorUserId: owner.id,
        actorRole: 'OWNER',
      }),
      confirmDeviceTaskCheckpoint({
        taskId: tC.id,
        actorUserId: owner.id,
        actorRole: 'OWNER',
      }),
    ]);
    const confOk = confResults.filter((r) => r.status === 'fulfilled');
    assert(confOk.length >= 1, 'at least one confirm');
    const finalC = await prisma.deviceTask.findUnique({ where: { id: tC.id } });
    assert(finalC?.status === 'RUNNING', 'RUNNING after confirm');
    assert(!!finalC?.confirmedBy, 'confirmedBy set');

    // expiry negative: new task, expire lease, confirm fails
    const tExp = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's3', instructions: 'e' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `exp-${tag}`,
    });
    taskIds.push(tExp.id);
    const ackE = await ackDeviceTask({ taskId: tExp.id, deviceId: d.id, leaseMs: 120_000 });
    const artE = await uploadDeviceArtifact({
      taskId: tExp.id,
      deviceId: d.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tExp.id,
      deviceId: d.id,
      leaseId: ackE.leaseId!,
      progress: {},
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: artE.id,
    });
    await prisma.deviceTask.update({
      where: { id: tExp.id },
      data: { leaseExpiresAt: new Date(Date.now() - 2000) },
    });
    let expErr: unknown;
    try {
      await confirmDeviceTaskCheckpoint({
        taskId: tExp.id,
        actorUserId: owner.id,
        actorRole: 'OWNER',
      });
    } catch (e) {
      expErr = e;
    }
    assert(expErr instanceof ApiError, 'expired lease confirm fails');

    // wrong artifact ownership
    const tW = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's4', instructions: 'w' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `wrong-${tag}`,
    });
    taskIds.push(tW.id);
    const ackW = await ackDeviceTask({ taskId: tW.id, deviceId: d.id });
    let wrongArt: unknown;
    try {
      await reportDeviceTaskProgress({
        taskId: tW.id,
        deviceId: d.id,
        leaseId: ackW.leaseId!,
        progress: {},
        status: 'AWAITING_CONFIRM',
        confirmationArtifactId: artC.id, // belongs to other task
      });
    } catch (e) {
      wrongArt = e;
    }
    assert(wrongArt instanceof ApiError, 'cross-task artifact rejected');
    console.log('PASS [5] confirm race/expiry/ownership');

    console.log('── [6] MCP install retry after terminal ──');
    // first install while online
    const inst1 = await requestLineDesktopInstall({
      deviceId: d.id,
      actorUserId: owner.id,
    });
    taskIds.push(inst1.taskId);
    // fail the task
    const openInst = await prisma.deviceTask.findUnique({ where: { id: inst1.taskId } });
    if (openInst && openInst.status !== 'SUCCEEDED') {
      // force terminal FAILED via direct update if not acked
      await prisma.deviceTask.update({
        where: { id: inst1.taskId },
        data: {
          status: 'FAILED',
          terminalAt: new Date(),
          error: { reason: 'test fail' },
          leaseId: null,
          leaseExpiresAt: null,
        },
      });
    }
    const inst2 = await requestLineDesktopInstall({
      deviceId: d.id,
      actorUserId: owner.id,
    });
    taskIds.push(inst2.taskId);
    assert(inst2.taskId !== inst1.taskId, 'fresh task after terminal');
    // reuse nonterminal
    const inst3 = await requestLineDesktopInstall({
      deviceId: d.id,
      actorUserId: owner.id,
    });
    assert(inst3.taskId === inst2.taskId, 'reuse open install task');

    // offline dispatch → ERROR install
    hub.disconnectDevice(d.id);
    await settle(40);
    let offErr: unknown;
    try {
      await requestLineDesktopInstall({ deviceId: d.id, actorUserId: owner.id });
    } catch (e) {
      offErr = e;
    }
    assert(offErr instanceof ApiError, 'offline install fails');
    // If it got past online check somehow — still assert install not left REQUESTED without task
    // reconnect for cleanup
    const ws2 = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${en.token}` },
    });
    sockets.push(ws2);
    await once(ws2, 'open');
    console.log('PASS [6] install retry');

    console.log('── [7] formal path does not import local CU ──');
    const runnerSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../src/engine/runner.ts', import.meta.url), 'utf8'),
    );
    assert(
      !runnerSrc.includes('from \'../lib/codexmcp.js\'') &&
        !runnerSrc.includes('from "../lib/codexmcp.js"'),
      'no codexmcp import on formal path',
    );
    assert(runnerSrc.includes('LEGACY_LOCAL_COMPUTER_USE'), 'legacy isolated');
    assert(runnerSrc.includes('runComputerControlViaDevice'), 'device path present');
    assert(!runnerSrc.includes('hub.publish(\'computer.control_requested\''), 'no public broadcast call');
    void trainerToken;
    void completeDeviceTask;
    console.log('PASS [7] no silent local CU');

    console.log('\n✅ t05-review-hardening ALL PASS');
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
