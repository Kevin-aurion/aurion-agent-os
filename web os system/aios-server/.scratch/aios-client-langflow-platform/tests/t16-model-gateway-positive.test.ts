/**
 * Ticket 16 — AIOS Model Gateway positive paths (Phase 1: RED expected).
 *
 * Run:
 *   npx tsx .scratch/aios-client-langflow-platform/tests/t16-model-gateway-positive.test.ts
 *
 * Zero new deps. Real DB via prisma singleton. Fastify inject (no live :8700).
 * Cleanup deletes only test-owned rows.
 *
 * Phase 1: src/lib/modelgateway.ts / src/routes/modelgateway.ts do not exist yet
 * → import failure is the expected RED.
 */
import path from 'node:path';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import { createFlowArtifact } from '../../../src/lib/flowartifact.js';
import { sendError } from '../../../src/lib/http.js';
import { paths } from '../../../src/config.js';

let failed = 0;
let passed = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

async function costCount(agentId: string): Promise<number> {
  return prisma.costLog.count({ where: { agentId } });
}

async function main(): Promise<void> {
  console.log('── t16-model-gateway-positive ──');

  const tag = ulid().slice(-8).toLowerCase();
  const TOKEN = `t16-secret-${tag}`;
  const prevToken = process.env.AIOS_MODEL_GATEWAY_TOKEN;
  process.env.AIOS_MODEL_GATEWAY_TOKEN = TOKEN;

  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const deploymentId = ulid();
  const runId = ulid();
  const runVerifyFailId = ulid();
  const runVerifyFailClosedId = ulid();

  let skillVersionId = '';
  let artifactId = '';

  const contentMd = `# t16 model gateway positive ${tag}\n`;
  const trackedRunIds = [runId, runVerifyFailId, runVerifyFailClosedId];
  const stepKey = `t16-step-${tag}`;

  type DispatchArgs = {
    engine: string;
    kind: 'execute' | 'verify';
    prompt: string;
    cwd: string;
    timeoutMs: number;
    restrictions: unknown;
    threadId?: string | null;
  };

  const spyCalls: DispatchArgs[] = [];
  let spyText = '## done';
  const spyDispatch = async (args: DispatchArgs) => {
    spyCalls.push(args);
    return {
      text: spyText,
      threadId: args.kind === 'verify' ? 'thread-t16' : null,
      costInput: args.prompt,
    };
  };

  try {
    // ── Fixtures ──────────────────────────────────────────────────────────
    console.log('── setup fixtures ──');
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t16-pos-owner-${tag}@aios.test`,
        displayName: 'T16 Pos Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });

    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t16-pos-agent-${tag}`,
        name: `T16 Pos Agent ${tag}`,
        description: 't16 positive',
        rolePrompt: 't16 positive agent',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: null,
        restrictions: null,
        costPolicy: null,
        createdBy: ownerId,
        riskTier: 'low',
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug: `t16-pos-skill-${tag}`,
        name: `T16 Pos Skill ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, contentMd, ownerId);
    skillVersionId = sv.id;

    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 't16-pos-langflow',
      compilerVersion: `t16-pos-${tag}`,
      artifactJson: { nodes: [{ id: 'n1' }], edges: [], kind: 'langflow', tag },
      createdBy: ownerId,
    });
    artifactId = art.id;
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: { status: 'VALIDATED' },
    });

    await prisma.runtimeDeployment.create({
      data: {
        id: deploymentId,
        artifactId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        runtimeBinding: {},
        active: true,
        deployedBy: ownerId,
      },
    });

    const goodRunDir = path.join(paths.runs, runId);
    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: goodRunDir,
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });

    await prisma.run.create({
      data: {
        id: runVerifyFailId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runVerifyFailId),
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });

    await prisma.run.create({
      data: {
        id: runVerifyFailClosedId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runVerifyFailClosedId),
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });

    // ── Dynamic import (expected RED in Phase 1) ─────────────────────────
    let gatewayExecute: typeof import('../../../src/lib/modelgateway.js').gatewayExecute;
    let gatewayVerify: typeof import('../../../src/lib/modelgateway.js').gatewayVerify;
    let modelGatewayRoutes: typeof import('../../../src/routes/modelgateway.js').modelGatewayRoutes;

    try {
      const lib = await import('../../../src/lib/modelgateway.js');
      gatewayExecute = lib.gatewayExecute;
      gatewayVerify = lib.gatewayVerify;
    } catch (e) {
      fail('import src/lib/modelgateway.js', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit: missing lib module) ──`);
      return;
    }

    try {
      const routes = await import('../../../src/routes/modelgateway.js');
      modelGatewayRoutes = routes.modelGatewayRoutes;
    } catch (e) {
      fail('import src/routes/modelgateway.js', String(e));
      console.log(`\n── summary: ${passed} passed, ${failed} failed (early exit: missing routes module) ──`);
      return;
    }

    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => sendError(reply, err));
    await app.register(modelGatewayRoutes);
    await app.ready();

    const secretKey = 'sk-abcdef1234567890';
    const costBefore = await costCount(agentId);

    // ── [1] gatewayExecute: redact + CostLog + family + spy args ─────────
    console.log('\n── [1] gatewayExecute redact + cost + family ──');
    {
      spyCalls.length = 0;
      spyText = `hello ${secretKey} ## done`;
      const res = await gatewayExecute(
        {
          runId,
          deploymentId,
          agentId,
          prompt: 'execute please',
          stepKey,
        },
        { dispatch: spyDispatch as never },
      );

      check(
        res.text.includes('[REDACTED_API_KEY]') && !res.text.includes(secretKey),
        '1a text redacted (no raw key)',
        `text=${res.text.slice(0, 200)}`,
      );
      check(res.engine === 'CLAUDE_CODE', '1b engine CLAUDE_CODE', `engine=${res.engine}`);
      check(res.modelFamily === 'anthropic', '1c modelFamily anthropic', `family=${res.modelFamily}`);
      check(res.stepKey === stepKey, '1d stepKey echoed', `stepKey=${res.stepKey}`);
      check(res.runId === runId, '1e runId echoed', `runId=${res.runId}`);

      const costAfter = await costCount(agentId);
      check(costAfter === costBefore + 1, '1f CostLog +1', `before=${costBefore} after=${costAfter}`);

      const lastCost = await prisma.costLog.findFirst({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
      });
      check(lastCost?.engine === 'CLAUDE_CODE', '1g CostLog engine CLAUDE_CODE', `engine=${lastCost?.engine}`);
      check(lastCost?.stepKey === stepKey, '1h CostLog stepKey', `stepKey=${lastCost?.stepKey}`);

      const runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      check(
        runRow.executionModelFamily === 'anthropic',
        '1i run.executionModelFamily=anthropic',
        `got ${runRow.executionModelFamily}`,
      );

      const call = spyCalls[0];
      check(Boolean(call), '1j spy called once', `len=${spyCalls.length}`);
      if (call) {
        check(call.cwd === goodRunDir, '1k spy cwd===run.runDir', `cwd=${call.cwd}`);
        check(call.kind === 'execute', '1l spy kind=execute', `kind=${call.kind}`);
        check(call.engine === 'CLAUDE_CODE', '1m spy engine=CLAUDE_CODE', `engine=${call.engine}`);
        check(
          call.restrictions != null && typeof call.restrictions === 'object',
          '1n spy restrictions is object',
          `restrictions=${JSON.stringify(call.restrictions)}`,
        );
      }
    }

    // ── [2] gatewayVerify APPROVED → families differ ─────────────────────
    console.log('\n── [2] gatewayVerify APPROVED ──');
    {
      const costMid = await costCount(agentId);
      spyCalls.length = 0;
      spyText = '## Verdict\nAPPROVED';
      const res = await gatewayVerify(
        {
          runId,
          deploymentId,
          agentId,
          artifact: 'artifact body',
          rubric: 'must pass',
          sourceOfTruth: 'truth',
        },
        { dispatch: spyDispatch as never },
      );

      check(res.approved === true, '2a approved=true', `approved=${res.approved}`);
      check(res.engine === 'CODEX', '2b verify engine=CODEX', `engine=${res.engine}`);
      check(res.modelFamily === 'openai', '2c modelFamily=openai', `family=${res.modelFamily}`);
      check(
        res.executionModelFamily === 'anthropic',
        '2d executionModelFamily=anthropic',
        `got ${res.executionModelFamily}`,
      );
      check(
        res.modelFamily !== res.executionModelFamily,
        '2e execute≠verify family evidence',
        `exec=${res.executionModelFamily} verify=${res.modelFamily}`,
      );

      const costAfter = await costCount(agentId);
      check(costAfter === costMid + 1, '2f CostLog +1 (verify)', `before=${costMid} after=${costAfter}`);

      const runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      check(
        runRow.verificationModelFamily === 'openai',
        '2g run.verificationModelFamily=openai',
        `got ${runRow.verificationModelFamily}`,
      );
      check(
        runRow.executionModelFamily === 'anthropic' &&
          runRow.verificationModelFamily === 'openai' &&
          runRow.executionModelFamily !== runRow.verificationModelFamily,
        '2h DB families differ execute≠verify',
        `exec=${runRow.executionModelFamily} verify=${runRow.verificationModelFamily}`,
      );
    }

    // ── [3] ISSUES FOUND → approved=false ────────────────────────────────
    console.log('\n── [3] gatewayVerify ISSUES FOUND → false ──');
    {
      spyCalls.length = 0;
      spyText = 'ISSUES FOUND: bad';
      const res = await gatewayVerify(
        {
          runId: runVerifyFailId,
          deploymentId,
          agentId,
          artifact: 'bad artifact',
        },
        { dispatch: spyDispatch as never },
      );
      check(res.approved === false, '3 approved=false on ISSUES FOUND', `approved=${res.approved}`);
    }

    // ── [4] APPROVED + ISSUES FOUND → fail-closed false ──────────────────
    console.log('\n── [4] fail-closed: APPROVED + ISSUES FOUND → false ──');
    {
      spyCalls.length = 0;
      spyText = '## Verdict\nAPPROVED\nISSUES FOUND: still bad';
      const res = await gatewayVerify(
        {
          runId: runVerifyFailClosedId,
          deploymentId,
          agentId,
          artifact: 'mixed',
        },
        { dispatch: spyDispatch as never },
      );
      check(
        res.approved === false,
        '4 approved=false (fail-closed oracle)',
        `approved=${res.approved} text=${res.text.slice(0, 80)}`,
      );
    }

    // ── [5] GET /internal/model/health ───────────────────────────────────
    console.log('\n── [5] health route ──');
    {
      const r = await app.inject({
        method: 'GET',
        url: '/internal/model/health',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      check(r.statusCode === 200, '5a health HTTP 200', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      let body: { success?: boolean; data?: { ok?: boolean; at?: string } } = {};
      try {
        body = JSON.parse(r.body) as typeof body;
      } catch {
        /* ignore */
      }
      check(body.success === true, '5b body.success===true', `body=${r.body.slice(0, 200)}`);
      check(body.data?.ok === true, '5c data.ok===true', `data=${JSON.stringify(body.data)}`);
      check(
        typeof body.data?.at === 'string' && body.data.at.length > 0,
        '5d data.at ISO string',
        `at=${body.data?.at}`,
      );
    }

    // ── [6] route maps lib notFound → envelope 404 ───────────────────────
    console.log('\n── [6] forged runId via route → 404 envelope ──');
    {
      const r = await app.inject({
        method: 'POST',
        url: '/internal/model/execute',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          runId: ulid(),
          deploymentId,
          agentId,
          prompt: 'forged',
        },
      });
      check(r.statusCode === 404, '6a forged runId HTTP 404', `got ${r.statusCode} body=${r.body.slice(0, 200)}`);
      let body: { success?: boolean; error?: { code?: string } } = {};
      try {
        body = JSON.parse(r.body) as typeof body;
      } catch {
        /* ignore */
      }
      check(body.success === false, '6b success=false envelope', `body=${r.body.slice(0, 200)}`);
      check(
        body.error?.code === 'NOT_FOUND' || /not\s*found/i.test(r.body),
        '6c error code NOT_FOUND',
        `body=${r.body.slice(0, 200)}`,
      );
    }

    await app.close().catch(() => undefined);
  } finally {
    console.log('\n── cleanup test-owned rows only ──');
    if (prevToken === undefined) delete process.env.AIOS_MODEL_GATEWAY_TOKEN;
    else process.env.AIOS_MODEL_GATEWAY_TOKEN = prevToken;

    await prisma.costLog.deleteMany({ where: { agentId } }).catch(() => undefined);
    if (trackedRunIds.length) {
      await prisma.run.deleteMany({ where: { id: { in: trackedRunIds } } }).catch(() => undefined);
    }
    await prisma.runtimeDeployment.deleteMany({ where: { id: deploymentId } }).catch(() => undefined);
    await prisma.runtimeDeployment.deleteMany({ where: { skillId } }).catch(() => undefined);
    if (skillVersionId) {
      await prisma.flowArtifact.deleteMany({ where: { skillVersionId } }).catch(() => undefined);
    }
    await prisma.skillVersion.deleteMany({ where: { skillId } }).catch(() => undefined);
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('FATAL', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
