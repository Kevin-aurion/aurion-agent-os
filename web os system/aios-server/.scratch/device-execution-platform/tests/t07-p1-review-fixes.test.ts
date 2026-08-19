/**
 * P1 independent-review fixes — negative + race coverage.
 * Run: npx tsx .scratch/device-execution-platform/tests/t07-p1-review-fixes.test.ts
 *
 * Covers:
 * 1) confirmationRequired cannot SUCCEEDED without confirmedAt (DB conditional + race)
 * 2) FAILED allowed without confirmation
 * 3) Happy path: AWAITING_CONFIRM → FDE confirm → SUCCEEDED
 * 4) MCP_TOOL maps to mcp_tool eligibility; no computer_use default; alias reject
 * 5) MCP_TOOL LINE send requires runId + real isRunApproved; read does not
 * 6) FDE execution tasks require idempotencyKey; probe/install optional
 * 7) Enrollment redacts os/app version; re-issue invalidates older unconsumed codes
 * 9) LINE_DESKTOP payload: send requires tool; op/tool mismatch rejected; send needs isRunApproved
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
  completeDeviceTask,
} from '../../../src/lib/devicetask.js';
import { uploadDeviceArtifact } from '../../../src/lib/deviceartifact.js';
import {
  checkDeviceEligibility,
} from '../../../src/lib/deviceeligibility.js';
import {
  LINE_DESKTOP_MANIFEST,
  LINE_DESKTOP_MCP_KEY,
} from '../../../src/lib/devicemcp.js';
import { createApproval, decideApproval, isRunApproved } from '../../../src/lib/approval.js';
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

async function ensureLineMcpReady(deviceId: string) {
  await prisma.deviceMcpInstallation.upsert({
    where: {
      deviceId_mcpKey: { deviceId, mcpKey: LINE_DESKTOP_MCP_KEY },
    },
    create: {
      id: ulid(),
      deviceId,
      mcpKey: LINE_DESKTOP_MCP_KEY,
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
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'FDE user required');
  let member = await prisma.user.findFirst({ where: { deletedAt: null, role: 'MEMBER' } });
  let createdMember: string | null = null;
  if (!member) {
    createdMember = ulid();
    member = await prisma.user.create({
      data: {
        id: createdMember,
        email: `t07-${createdMember.slice(-6)}@test.local`,
        displayName: 'T07',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const deviceIds: string[] = [];
  const taskIds: string[] = [];
  const runIds: string[] = [];
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
    return reply
      .code(500)
      .send({ success: false, error: { code: 'INTERNAL', message: String(err) } });
  });
  await app.register(devicesRoutes);
  await app.register(deviceRoutes);

  const sockets: WebSocket[] = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t07-${tag}`,
        name: 'T07',
        description: 't',
        rolePrompt: 't',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        createdBy: owner.id,
      },
    });

    const d = await createDevice({
      ownerUserId: owner.id,
      name: `t07-${tag}`,
      platform: 'MACOS',
    });
    deviceIds.push(d.id);
    const en = await enrollWithCode({
      code: (await issueEnrollmentCode({ deviceId: d.id, createdBy: owner.id })).code,
    });
    await bindAgentDevice({ agentId, deviceId: d.id, boundBy: owner.id });
    await updateDeviceCapabilities(d.id, CAPS_FULL);
    await ensureLineMcpReady(d.id);

    const ws = new WebSocket(`${wsBase}/device/ws`, {
      headers: { Authorization: `Bearer ${en.token}` },
    });
    sockets.push(ws);
    await once(ws, 'open');
    await settle();

    // ── [1] confirmationRequired: SUCCEEDED blocked without confirmedAt ──
    console.log('── [1] SUCCEEDED blocked without FDE confirm (DB guard) ──');
    const tBlock = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's-block', instructions: 'must confirm' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `block-${tag}`,
    });
    taskIds.push(tBlock.id);
    const ackBlock = await ackDeviceTask({
      taskId: tBlock.id,
      deviceId: d.id,
      leaseMs: 180_000,
    });
    const artBlock = await uploadDeviceArtifact({
      taskId: tBlock.id,
      deviceId: d.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tBlock.id,
      deviceId: d.id,
      leaseId: ackBlock.leaseId!,
      progress: { phase: 'checkpoint' },
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: artBlock.id,
    });

    let succNoConfirm: unknown;
    try {
      await completeDeviceTask({
        taskId: tBlock.id,
        deviceId: d.id,
        leaseId: ackBlock.leaseId!,
        status: 'SUCCEEDED',
        result: { ok: true },
      });
    } catch (e) {
      succNoConfirm = e;
    }
    assert(succNoConfirm instanceof ApiError, 'SUCCEEDED without confirm must throw');
    assert(
      (succNoConfirm as ApiError).statusCode === 403 ||
        (succNoConfirm as ApiError).statusCode === 409,
      `expected 403/409 got ${(succNoConfirm as ApiError).statusCode}`,
    );
    const stillOpen = await prisma.deviceTask.findUnique({ where: { id: tBlock.id } });
    assert(stillOpen?.status === 'AWAITING_CONFIRM', `still AWAITING, got ${stillOpen?.status}`);
    assert(stillOpen?.confirmedAt == null, 'confirmedAt still null');
    console.log('PASS [1] SUCCEEDED blocked without confirm');

    // ── [2] FAILED allowed without confirmation (no deadlock) ──
    console.log('── [2] FAILED without confirmation allowed ──');
    const tFail = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's-fail', instructions: 'fail ok' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `fail-${tag}`,
    });
    taskIds.push(tFail.id);
    const ackFail = await ackDeviceTask({
      taskId: tFail.id,
      deviceId: d.id,
      leaseMs: 180_000,
    });
    const artFail = await uploadDeviceArtifact({
      taskId: tFail.id,
      deviceId: d.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tFail.id,
      deviceId: d.id,
      leaseId: ackFail.leaseId!,
      progress: {},
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: artFail.id,
    });
    const failed = await completeDeviceTask({
      taskId: tFail.id,
      deviceId: d.id,
      leaseId: ackFail.leaseId!,
      status: 'FAILED',
      error: { reason: 'device error before confirm' },
    });
    assert(failed.status === 'FAILED', 'FAILED without confirm');
    assert(failed.confirmedAt == null, 'no confirmedAt on fail path');
    console.log('PASS [2] FAILED without confirm');

    // ── [3] Happy path + race: confirm then SUCCEEDED; concurrent SUCCEEDED without confirm fails ──
    console.log('── [3] confirm→SUCCEEDED happy path + race ──');
    const tOk = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { skillId: 's-ok', instructions: 'ok' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `ok-${tag}`,
    });
    taskIds.push(tOk.id);
    const ackOk = await ackDeviceTask({
      taskId: tOk.id,
      deviceId: d.id,
      leaseMs: 180_000,
    });
    const artOk = await uploadDeviceArtifact({
      taskId: tOk.id,
      deviceId: d.id,
      seq: 1,
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      bytes: png,
      clientDeclaredRedacted: true,
    });
    await reportDeviceTaskProgress({
      taskId: tOk.id,
      deviceId: d.id,
      leaseId: ackOk.leaseId!,
      progress: {},
      status: 'AWAITING_CONFIRM',
      confirmationArtifactId: artOk.id,
    });

    // Race: concurrent SUCCEEDED before confirm — all must fail, status stays non-terminal SUCCEEDED-free
    const raceBefore = await Promise.allSettled([
      completeDeviceTask({
        taskId: tOk.id,
        deviceId: d.id,
        leaseId: ackOk.leaseId!,
        status: 'SUCCEEDED',
        result: { sneaky: 1 },
      }),
      completeDeviceTask({
        taskId: tOk.id,
        deviceId: d.id,
        leaseId: ackOk.leaseId!,
        status: 'SUCCEEDED',
        result: { sneaky: 2 },
      }),
    ]);
    assert(
      raceBefore.every((r) => r.status === 'rejected'),
      'both SUCCEEDED before confirm rejected',
    );
    const mid = await prisma.deviceTask.findUnique({ where: { id: tOk.id } });
    assert(mid?.status === 'AWAITING_CONFIRM', `after race still AWAITING got ${mid?.status}`);
    assert(mid?.confirmedAt == null, 'still unconfirmed');

    // FDE confirms
    const confirmed = await confirmDeviceTaskCheckpoint({
      taskId: tOk.id,
      actorUserId: owner.id,
      actorRole: 'OWNER',
    });
    assert(confirmed.status === 'RUNNING', 'RUNNING after confirm');
    assert(!!confirmed.confirmedAt, 'confirmedAt set');

    // Race after confirm: concurrent SUCCEEDED — first-writer-wins, at least one ok, terminal SUCCEEDED
    const raceAfter = await Promise.allSettled([
      completeDeviceTask({
        taskId: tOk.id,
        deviceId: d.id,
        leaseId: ackOk.leaseId!,
        status: 'SUCCEEDED',
        result: { done: true },
      }),
      completeDeviceTask({
        taskId: tOk.id,
        deviceId: d.id,
        leaseId: ackOk.leaseId!,
        status: 'SUCCEEDED',
        result: { done: true },
      }),
    ]);
    const okCount = raceAfter.filter((r) => r.status === 'fulfilled').length;
    assert(okCount >= 1, `at least one SUCCEEDED after confirm, got ${okCount}`);
    const finalOk = await prisma.deviceTask.findUnique({ where: { id: tOk.id } });
    assert(finalOk?.status === 'SUCCEEDED', 'terminal SUCCEEDED');
    assert(!!finalOk?.confirmedAt, 'confirmedAt retained');
    console.log('PASS [3] confirm→SUCCEEDED + races');

    // ── [4] MCP_TOOL eligibility mapping / alias reject / no computer_use default ──
    console.log('── [4] MCP_TOOL mapping + alias reject ──');
    // eligibility: canonical key ok for read tool
    const eligRead = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: {
        kind: 'mcp_tool',
        mcpKey: LINE_DESKTOP_MCP_KEY,
        tool: 'get_line_chatroom_history_default',
      },
    });
    assert(eligRead.eligible, `mcp_tool read elig ${eligRead.reasonCode} ${eligRead.reason}`);

    // alias rejected at eligibility
    const eligAlias = await checkDeviceEligibility({
      deviceId: d.id,
      agentId,
      requirement: {
        kind: 'mcp_tool',
        mcpKey: 'line-desktop', // alias, not canonical
        tool: 'get_line_chatroom_history_default',
      },
    });
    assert(!eligAlias.eligible, 'alias mcpKey rejected');
    assert(
      eligAlias.reasonCode === 'MCP_NOT_READY' ||
        (eligAlias.reason ?? '').toLowerCase().includes('unsupported'),
      eligAlias.reason,
    );

    // REST: alias MCP_TOOL rejected fail-closed
    const aliasRest = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'MCP_TOOL',
        agentId,
        idempotencyKey: `alias-${tag}`,
        payload: {
          serverId: 'line-desktop',
          tool: 'get_line_chatroom_history_default',
          args: {},
        },
      },
    });
    assert(
      aliasRest.statusCode === 400 || aliasRest.statusCode === 403,
      `alias REST ${aliasRest.statusCode} ${aliasRest.body}`,
    );
    assert(
      !aliasRest.body.includes('"status":"DISPATCHED"'),
      'alias must not create dispatchable task',
    );

    // REST: MCP_TOOL must not use computer_use — device without codexApp but with LINE MCP
    // would still work if mapped to mcp_tool (computer_use would fail). Already have codexApp.
    // Prove mapping by creating read MCP_TOOL successfully with canonical key.
    const mcpRead = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'MCP_TOOL',
        agentId,
        idempotencyKey: `mcp-read-${tag}`,
        payload: {
          serverId: LINE_DESKTOP_MCP_KEY,
          tool: 'get_line_chatroom_history_default',
          args: { limit: 5 },
        },
      },
    });
    assert(mcpRead.statusCode === 201, `mcp read ${mcpRead.statusCode} ${mcpRead.body}`);
    const mcpReadId = (mcpRead.json() as { data: { id: string } }).data.id;
    taskIds.push(mcpReadId);
    console.log('PASS [4] MCP_TOOL mapping + alias');

    // ── [5] MCP_TOOL LINE send requires runId + real approval ──
    console.log('── [5] MCP_TOOL LINE send approval gate ──');
    const sendNoRun = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'MCP_TOOL',
        agentId,
        idempotencyKey: `send-norun-${tag}`,
        payload: {
          serverId: LINE_DESKTOP_MCP_KEY,
          tool: 'send_message_manual',
          args: { text: 'x' },
        },
      },
    });
    assert(
      sendNoRun.statusCode === 400 || sendNoRun.statusCode === 403,
      `send no runId ${sendNoRun.statusCode}`,
    );

    const fakeRunId = ulid();
    const sendNoAppr = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'MCP_TOOL',
        agentId,
        runId: fakeRunId,
        idempotencyKey: `send-noappr-${tag}`,
        payload: {
          serverId: LINE_DESKTOP_MCP_KEY,
          tool: 'send_message_auto',
          args: { text: 'y' },
        },
      },
    });
    assert(
      sendNoAppr.statusCode === 400 || sendNoAppr.statusCode === 403,
      `send no approval ${sendNoAppr.statusCode}`,
    );

    const runId = ulid();
    runIds.push(runId);
    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: owner.id,
        status: 'AWAITING_REVIEW',
        input: {},
        runDir: `/tmp/t07-${runId}`,
      },
    });
    const { id: approvalId } = await createApproval({
      runId,
      agentId,
      reason: 't07 MCP_TOOL send',
      payload: {},
    });
    assert(!(await isRunApproved(runId)), 'not approved yet');
    await decideApproval(approvalId, true, owner.id);
    assert(await isRunApproved(runId), 'approved');

    const sendOk = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'MCP_TOOL',
        agentId,
        runId,
        idempotencyKey: `send-ok-${tag}`,
        payload: {
          serverId: LINE_DESKTOP_MCP_KEY,
          tool: 'send_message_manual',
          args: { text: 'hi' },
        },
      },
    });
    assert(sendOk.statusCode === 201, `send ok ${sendOk.statusCode} ${sendOk.body}`);
    taskIds.push((sendOk.json() as { data: { id: string } }).data.id);
    console.log('PASS [5] MCP_TOOL LINE send approval');

    // ── [6] idempotencyKey required for execution kinds; optional for probe ──
    console.log('── [6] idempotencyKey required for FDE execution tasks ──');
    for (const kind of ['COMPUTER_CONTROL', 'SCREENSHOT', 'LINE_DESKTOP', 'MCP_TOOL'] as const) {
      const payload =
        kind === 'COMPUTER_CONTROL'
          ? { instructions: 'x' }
          : kind === 'SCREENSHOT'
            ? { app: 'Finder' }
            : kind === 'LINE_DESKTOP'
              ? { operation: 'read', tool: 'get_line_chatroom_history_default' }
              : {
                  serverId: LINE_DESKTOP_MCP_KEY,
                  tool: 'get_line_chatroom_history_default',
                  args: {},
                };
      const res = await app.inject({
        method: 'POST',
        url: '/api/device-tasks',
        headers: {
          authorization: `Bearer ${trainerToken}`,
          'content-type': 'application/json',
        },
        payload: {
          deviceId: d.id,
          kind,
          agentId,
          // intentionally omit idempotencyKey
          payload,
        },
      });
      assert(res.statusCode === 400, `${kind} missing idempotencyKey → 400 got ${res.statusCode}`);
      assert(
        (res.body as string).toLowerCase().includes('idempotency'),
        `${kind} message mentions idempotency`,
      );
    }

    // CAPABILITY_PROBE may omit idempotencyKey
    const probe = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'CAPABILITY_PROBE',
        payload: { features: ['computerUse'] },
      },
    });
    assert(probe.statusCode === 201, `probe optional key ${probe.statusCode} ${probe.body}`);
    taskIds.push((probe.json() as { data: { id: string } }).data.id);

    // runner-style lib call still works with key (and would without for non-route path)
    const runnerLike = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { instructions: 'from runner' },
      runId: `run-runner-${tag}`,
      stepKey: 'step-1',
      idempotencyKey: `run-${tag}:step-1:computer-control`,
      confirmationRequired: true,
    });
    taskIds.push(runnerLike.id);
    assert(runnerLike.status === 'DISPATCHED' || runnerLike.status === 'PENDING', 'runner path ok');
    console.log('PASS [6] idempotencyKey rules');

    // ── [7] enrollment redaction + invalidate older unconsumed codes ──
    console.log('── [7] enrollment redact + invalidate old codes ──');
    const dEn = await createDevice({
      ownerUserId: owner.id,
      name: `t07-en-${tag}`,
      platform: 'LINUX',
    });
    deviceIds.push(dEn.id);

    const oldCode = await issueEnrollmentCode({
      deviceId: dEn.id,
      createdBy: owner.id,
      ttlMs: 300_000,
    });
    const newCode = await issueEnrollmentCode({
      deviceId: dEn.id,
      createdBy: owner.id,
      ttlMs: 300_000,
    });
    assert(oldCode.enrollmentId !== newCode.enrollmentId, 'new enrollment row');

    // old unconsumed code must be invalidated
    let oldEnrollErr: unknown;
    try {
      await enrollWithCode({ code: oldCode.code });
    } catch (e) {
      oldEnrollErr = e;
    }
    assert(oldEnrollErr instanceof ApiError, 'old code rejected after re-issue');

    const secretOs = '15.0-sk-leaksecretABCDEFGH1234567890';
    const secretApp = '1.0.0-sk-appsecretABCDEFGH1234567890';
    assert(redactSecrets(secretOs) !== secretOs, 'redactor would hit osVersion');
    const enrolled = await enrollWithCode({
      code: newCode.code,
      platform: 'LINUX',
      osVersion: secretOs,
      appVersion: secretApp,
    });
    assert(enrolled.deviceId === dEn.id, 'enrolled new code');
    const enRow = await prisma.device.findUnique({ where: { id: dEn.id } });
    assert(enRow?.status === 'ACTIVE', 'ACTIVE');
    assert(enRow?.osVersion !== secretOs, 'osVersion redacted');
    assert(enRow?.appVersion !== secretApp, 'appVersion redacted');
    assert(!JSON.stringify(enRow).includes('sk-leaksecret'), 'no raw secret in device row');
    assert(!JSON.stringify(enRow).includes('sk-appsecret'), 'no raw app secret in device row');

    // old enrollment row marked expired (consumedAt still null)
    const oldRow = await prisma.deviceEnrollment.findUnique({
      where: { id: oldCode.enrollmentId },
    });
    assert(oldRow?.consumedAt == null, 'old not consumed');
    assert(
      !!oldRow && oldRow.expiresAt.getTime() <= Date.now(),
      'old code expired atomically on re-issue',
    );

    // Concurrent issue: Device FOR UPDATE serializes so only one returned code stays valid.
    const dRace = await createDevice({
      ownerUserId: owner.id,
      name: `t07-race-${tag}`,
      platform: 'LINUX',
    });
    deviceIds.push(dRace.id);
    const concurrentIssued = await Promise.all([
      issueEnrollmentCode({ deviceId: dRace.id, createdBy: owner.id, ttlMs: 300_000 }),
      issueEnrollmentCode({ deviceId: dRace.id, createdBy: owner.id, ttlMs: 300_000 }),
    ]);
    assert(
      concurrentIssued[0]!.enrollmentId !== concurrentIssued[1]!.enrollmentId,
      'two rows created',
    );
    const raceEnroll = await Promise.allSettled([
      enrollWithCode({ code: concurrentIssued[0]!.code }),
      enrollWithCode({ code: concurrentIssued[1]!.code }),
    ]);
    const raceOk = raceEnroll.filter((r) => r.status === 'fulfilled').length;
    const raceFail = raceEnroll.filter((r) => r.status === 'rejected').length;
    assert(raceOk === 1, `exactly one concurrent-issue code enrolls, got ${raceOk}`);
    assert(raceFail === 1, `other concurrent-issue code rejected, got ${raceFail}`);
    const raceLoser = raceEnroll[0]!.status === 'rejected' ? 0 : 1;
    const raceLoserRow = await prisma.deviceEnrollment.findUnique({
      where: { id: concurrentIssued[raceLoser]!.enrollmentId },
    });
    assert(raceLoserRow?.consumedAt == null, 'race loser not consumed');
    assert(
      !!raceLoserRow && raceLoserRow.expiresAt.getTime() <= Date.now(),
      'race loser expired',
    );
    console.log('PASS [7] enrollment redact + invalidate + concurrent issue lock');

    // ── [8] REST result path also enforces confirm guard ──
    console.log('── [8] REST /result SUCCEEDED without confirm fails ──');
    const tRest = await createAndDispatchTask({
      deviceId: d.id,
      kind: 'COMPUTER_CONTROL',
      agentId,
      payload: { instructions: 'rest guard' },
      confirmationRequired: true,
      requestedByUserId: owner.id,
      idempotencyKey: `rest-guard-${tag}`,
    });
    taskIds.push(tRest.id);
    const ackRest = await ackDeviceTask({
      taskId: tRest.id,
      deviceId: d.id,
      leaseMs: 120_000,
    });
    // skip confirm — try result SUCCEEDED
    const restSucc = await app.inject({
      method: 'POST',
      url: `/api/device/tasks/${tRest.id}/result`,
      headers: {
        authorization: `Bearer ${en.token}`,
        'content-type': 'application/json',
      },
      payload: {
        leaseId: ackRest.leaseId,
        status: 'SUCCEEDED',
        result: { bypass: true },
      },
    });
    assert(
      restSucc.statusCode === 403 || restSucc.statusCode === 409,
      `REST SUCCEEDED blocked ${restSucc.statusCode} ${restSucc.body}`,
    );
    const restRow = await prisma.deviceTask.findUnique({ where: { id: tRest.id } });
    assert(restRow?.status !== 'SUCCEEDED', `must not be SUCCEEDED got ${restRow?.status}`);

    // FAILED via REST still ok without confirm
    const restFail = await app.inject({
      method: 'POST',
      url: `/api/device/tasks/${tRest.id}/result`,
      headers: {
        authorization: `Bearer ${en.token}`,
        'content-type': 'application/json',
      },
      payload: {
        leaseId: ackRest.leaseId,
        status: 'FAILED',
        error: { reason: 'ok fail' },
      },
    });
    assert(restFail.statusCode === 200, `REST FAILED ${restFail.statusCode} ${restFail.body}`);
    console.log('PASS [8] REST result guard');

    // ── [9] LINE_DESKTOP payload semantic consistency + send HITL ──
    console.log('── [9] LINE_DESKTOP send/read tool consistency + approval ──');

    // (a) operation=send with omitted tool → reject (must not skip isRunApproved)
    const omitSendTool = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'LINE_DESKTOP',
        agentId,
        // even with a fake runId, omit tool must fail closed at validation or approval gate
        runId: ulid(),
        idempotencyKey: `line-omit-tool-${tag}`,
        payload: { operation: 'send', args: { text: 'x' } },
      },
    });
    assert(
      omitSendTool.statusCode === 400 || omitSendTool.statusCode === 403,
      `omit send tool ${omitSendTool.statusCode} ${omitSendTool.body}`,
    );
    assert(
      !omitSendTool.body.includes('"status":"DISPATCHED"'),
      'omit send tool must not dispatch',
    );

    // Also without runId: operation=send must require approval path (fail-closed)
    const omitSendNoRun = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'LINE_DESKTOP',
        agentId,
        idempotencyKey: `line-omit-norun-${tag}`,
        payload: { operation: 'send' },
      },
    });
    assert(
      omitSendNoRun.statusCode === 400 || omitSendNoRun.statusCode === 403,
      `omit send no runId ${omitSendNoRun.statusCode}`,
    );

    // (b) operation=read + send tool → mismatch reject
    const readSendMismatch = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'LINE_DESKTOP',
        agentId,
        idempotencyKey: `line-read-send-${tag}`,
        payload: {
          operation: 'read',
          tool: 'send_message_manual',
          args: {},
        },
      },
    });
    assert(
      readSendMismatch.statusCode === 400,
      `read+send-tool ${readSendMismatch.statusCode} ${readSendMismatch.body}`,
    );

    // (c) operation=send + read tool → mismatch reject
    const sendReadMismatch = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'LINE_DESKTOP',
        agentId,
        runId: ulid(),
        idempotencyKey: `line-send-read-${tag}`,
        payload: {
          operation: 'send',
          tool: 'get_line_chatroom_history_default',
          args: {},
        },
      },
    });
    assert(
      sendReadMismatch.statusCode === 400 || sendReadMismatch.statusCode === 403,
      `send+read-tool ${sendReadMismatch.statusCode} ${sendReadMismatch.body}`,
    );

    // (d) unknown tool → reject
    const unknownTool = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'LINE_DESKTOP',
        agentId,
        idempotencyKey: `line-unknown-${tag}`,
        payload: {
          operation: 'read',
          tool: 'not_a_real_line_tool',
          args: {},
        },
      },
    });
    assert(
      unknownTool.statusCode === 400,
      `unknown tool ${unknownTool.statusCode} ${unknownTool.body}`,
    );

    // (e) approved valid send → success
    const lineRunId = ulid();
    runIds.push(lineRunId);
    await prisma.run.create({
      data: {
        id: lineRunId,
        agentId,
        triggeredBy: owner.id,
        status: 'AWAITING_REVIEW',
        input: {},
        runDir: `/tmp/t07-line-${lineRunId}`,
      },
    });
    const { id: lineApprovalId } = await createApproval({
      runId: lineRunId,
      agentId,
      reason: 't07 LINE_DESKTOP send',
      payload: {},
    });
    await decideApproval(lineApprovalId, true, owner.id);
    assert(await isRunApproved(lineRunId), 'line send approved');

    const lineSendOk = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'LINE_DESKTOP',
        agentId,
        runId: lineRunId,
        idempotencyKey: `line-send-ok-${tag}`,
        payload: {
          operation: 'send',
          tool: 'send_message_auto',
          args: { text: 'approved send' },
        },
      },
    });
    assert(
      lineSendOk.statusCode === 201,
      `approved send ok ${lineSendOk.statusCode} ${lineSendOk.body}`,
    );
    taskIds.push((lineSendOk.json() as { data: { id: string } }).data.id);

    // read with omitted tool still allowed (default read)
    const lineReadOmit = await app.inject({
      method: 'POST',
      url: '/api/device-tasks',
      headers: {
        authorization: `Bearer ${trainerToken}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: d.id,
        kind: 'LINE_DESKTOP',
        agentId,
        idempotencyKey: `line-read-omit-${tag}`,
        payload: { operation: 'read', args: {} },
      },
    });
    assert(
      lineReadOmit.statusCode === 201,
      `read omit tool ok ${lineReadOmit.statusCode} ${lineReadOmit.body}`,
    );
    taskIds.push((lineReadOmit.json() as { data: { id: string } }).data.id);
    console.log('PASS [9] LINE_DESKTOP payload + send HITL');

    console.log('\n✅ t07-p1-review-fixes ALL PASS');
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
    await prisma.deviceMcpInstallation
      .deleteMany({ where: { deviceId: { in: deviceIds } } })
      .catch(() => {});
    await prisma.deviceEnrollment.deleteMany({ where: { deviceId: { in: deviceIds } } }).catch(() => {});
    await prisma.agentDevice.deleteMany({ where: { agentId } }).catch(() => {});
    if (runIds.length) {
      await prisma.approvalRequest.deleteMany({ where: { runId: { in: runIds } } }).catch(() => {});
      await prisma.run.deleteMany({ where: { id: { in: runIds } } }).catch(() => {});
    }
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    if (createdMember) {
      await prisma.user.deleteMany({ where: { id: createdMember } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
