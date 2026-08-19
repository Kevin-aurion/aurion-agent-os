/**
 * Ticket 21 — Service identity + environment binding (Phase 6).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t21-service-identity.test.ts
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
  console.log('── t21-service-identity ──');

  const tag = ulid().slice(-8).toLowerCase();
  const LEGACY = `t21-legacy-${tag}`;
  const KID = `kid-${tag}`;
  const SECRET = `sec-${tag}`;
  const KID_PROD = `kid-prod-${tag}`;
  const SECRET_PROD = `sec-prod-${tag}`;

  const prevToken = process.env.AIOS_MODEL_GATEWAY_TOKEN;
  const prevKeys = process.env.AIOS_SERVICE_IDENTITY_KEYS;
  process.env.AIOS_MODEL_GATEWAY_TOKEN = LEGACY;
  delete process.env.AIOS_SERVICE_IDENTITY_KEYS;

  const ownerId = ulid();
  const agentId = ulid();
  const skillId = ulid();
  const deploymentSandboxId = ulid();
  const deploymentProdId = ulid();
  const runId = ulid();
  const runProdId = ulid();
  const trackedRunIds: string[] = [];
  const trackedDeploymentIds = [deploymentSandboxId, deploymentProdId];
  let skillVersionId = '';
  let artifactId = '';
  let artifactProdId = '';

  const spyCalls: unknown[] = [];
  const spyDispatch = async (args: { prompt: string }) => {
    spyCalls.push(args);
    return {
      text: '## Verdict\nAPPROVED',
      threadId: null as string | null,
      costInput: args.prompt,
    };
  };

  try {
    const {
      verifyServiceIdentity,
      assertEnvironmentBinding,
    } = await import('../../../src/lib/serviceidentity.js');
    const {
      assertServiceRequest,
      gatewayExecute,
    } = await import('../../../src/lib/modelgateway.js');
    const { modelGatewayRoutes } = await import(
      '../../../src/routes/modelgateway.js'
    );

    await prisma.user.create({
      data: {
        id: ownerId,
        email: `t21-si-owner-${tag}@aios.test`,
        displayName: 'T21 SI Owner',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t21-si-agent-${tag}`,
        name: `T21 SI ${tag}`,
        description: 't21',
        rolePrompt: 't21',
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
        slug: `t21-si-skill-${tag}`,
        name: `T21 SI Skill ${tag}`,
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# t21 ${tag}`,
        reviewStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: ownerId,
        executionEnv: 'CLI',
      },
    });
    const sv = await createSkillVersion(skillId, `# t21 ${tag}`, ownerId);
    skillVersionId = sv.id;
    const art = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 't21-si',
      compilerVersion: `t21-si-${tag}`,
      artifactJson: { nodes: [], edges: [], tag },
      createdBy: ownerId,
    });
    artifactId = art.id;
    await prisma.flowArtifact.update({
      where: { id: artifactId },
      data: { status: 'VALIDATED' },
    });
    const artProd = await createFlowArtifact({
      skillVersionId,
      runtimeKind: 'LANGFLOW',
      template: 't21-si-prod',
      compilerVersion: `t21-si-prod-${tag}`,
      artifactJson: { nodes: [{ id: 'p' }], edges: [], tag },
      createdBy: ownerId,
    });
    artifactProdId = artProd.id;
    await prisma.flowArtifact.update({
      where: { id: artifactProdId },
      data: { status: 'VALIDATED' },
    });

    await prisma.runtimeDeployment.create({
      data: {
        id: deploymentSandboxId,
        artifactId,
        skillId,
        environment: 'SANDBOX',
        channel: 'CANARY',
        runtimeBinding: {},
        active: true,
        deployedBy: ownerId,
      },
    });
    await prisma.runtimeDeployment.create({
      data: {
        id: deploymentProdId,
        artifactId: artifactProdId,
        skillId,
        environment: 'PRODUCTION',
        channel: 'CANARY',
        runtimeBinding: {},
        active: true,
        deployedBy: ownerId,
      },
    });
    await prisma.run.create({
      data: {
        id: runId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runId),
        runtimeKind: 'LANGFLOW',
        artifactId,
      },
    });
    trackedRunIds.push(runId);
    await prisma.run.create({
      data: {
        id: runProdId,
        agentId,
        triggeredBy: 'test',
        status: 'RUNNING',
        input: {},
        runDir: path.join(paths.runs, runProdId),
        runtimeKind: 'LANGFLOW',
        artifactId: artifactProdId,
      },
    });
    trackedRunIds.push(runProdId);

    // ── Lib: legacy mode (KEYS unset) ───────────────────────────────────
    console.log('\n── legacy mode ──');
    try {
      verifyServiceIdentity({ remoteAddress: '127.0.0.1' });
      fail('legacy no auth throws', 'no throw');
    } catch (e: unknown) {
      const sc = (e as { statusCode?: number }).statusCode;
      check(sc === 401, 'legacy missing auth → 401', `got ${sc}`);
    }
    try {
      verifyServiceIdentity({
        authorization: 'Bearer wrong',
        remoteAddress: '127.0.0.1',
      });
      fail('legacy wrong token throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'legacy wrong token → 403',
        String(e),
      );
    }
    const legacyId = verifyServiceIdentity({
      authorization: `Bearer ${LEGACY}`,
      remoteAddress: '127.0.0.1',
    });
    check(legacyId.kind === 'legacy', 'legacy identity kind', JSON.stringify(legacyId));
    // assertServiceRequest thin wrapper
    assertServiceRequest({
      authorization: `Bearer ${LEGACY}`,
      remoteAddress: '127.0.0.1',
    });
    pass('assertServiceRequest legacy wrapper ok');

    try {
      verifyServiceIdentity({
        authorization: `Bearer ${LEGACY}`,
        remoteAddress: '10.0.0.1',
      });
      fail('non-loopback throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'non-loopback → 403',
        String(e),
      );
    }

    // ── Keyed mode ──────────────────────────────────────────────────────
    console.log('\n── keyed mode ──');
    process.env.AIOS_SERVICE_IDENTITY_KEYS = JSON.stringify([
      {
        kid: KID,
        secret: SECRET,
        environment: 'SANDBOX',
      },
      {
        kid: KID_PROD,
        secret: SECRET_PROD,
        environment: 'PRODUCTION',
      },
      {
        kid: `exp-${tag}`,
        secret: 'expired-secret',
        environment: 'SANDBOX',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    ]);

    try {
      verifyServiceIdentity({ remoteAddress: '127.0.0.1' });
      fail('keyed no auth throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 401,
        'keyed no auth → 401',
        String(e),
      );
    }

    try {
      verifyServiceIdentity({
        authorization: `Bearer ${LEGACY}`,
        remoteAddress: '127.0.0.1',
      });
      fail('keyed rejects legacy token', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'KEYS set → legacy token 403',
        String(e),
      );
    }

    try {
      verifyServiceIdentity({
        authorization: `Bearer unknown.${SECRET}`,
        remoteAddress: '127.0.0.1',
      });
      fail('unknown kid throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'unknown kid → 403',
        String(e),
      );
    }

    try {
      verifyServiceIdentity({
        authorization: `Bearer ${KID}.wrong-secret`,
        remoteAddress: '127.0.0.1',
      });
      fail('wrong secret throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'wrong secret → 403',
        String(e),
      );
    }

    try {
      verifyServiceIdentity({
        authorization: `Bearer exp-${tag}.expired-secret`,
        remoteAddress: '127.0.0.1',
      });
      fail('expired throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'expiresAt past → 403',
        String(e),
      );
    }

    const keyed = verifyServiceIdentity({
      authorization: `Bearer ${KID}.${SECRET}`,
      remoteAddress: '127.0.0.1',
    });
    check(
      keyed.kind === 'keyed' &&
        keyed.kid === KID &&
        keyed.environment === 'SANDBOX',
      'keyed identity ok',
      JSON.stringify(keyed),
    );

    // environment binding
    try {
      assertEnvironmentBinding(keyed, 'PRODUCTION');
      fail('wrong env binding throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'SANDBOX identity vs PRODUCTION → 403',
        String(e),
      );
    }
    assertEnvironmentBinding(keyed, 'SANDBOX');
    pass('matching env binding ok');
    assertEnvironmentBinding({ kind: 'legacy' }, 'PRODUCTION');
    pass('legacy unbound env ok');

    // ── Route: wrong env fail-closed ────────────────────────────────────
    console.log('\n── route wrong-env ──');
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => sendError(reply, err));
    await app.register(modelGatewayRoutes);
    await app.ready();

    const baselineCost = await costCount(agentId);
    spyCalls.length = 0;

    // Patch gateway via lib call with spy for env binding
    try {
      await gatewayExecute(
        {
          runId: runProdId,
          deploymentId: deploymentProdId,
          agentId,
          prompt: 'should not dispatch',
          identity: keyed, // SANDBOX vs PRODUCTION deployment
        },
        { dispatch: spyDispatch },
      );
      fail('gatewayExecute wrong env throws', 'no throw');
    } catch (e: unknown) {
      check(
        (e as { statusCode?: number }).statusCode === 403,
        'gatewayExecute wrong-env → 403',
        String(e),
      );
    }
    check(spyCalls.length === 0, 'wrong-env: spy dispatch zero calls', `n=${spyCalls.length}`);
    check(
      (await costCount(agentId)) === baselineCost,
      'wrong-env: CostLog zero add',
      `before=${baselineCost} after=${await costCount(agentId)}`,
    );

    // Route inject: SANDBOX key → PRODUCTION run
    const rWrong = await app.inject({
      method: 'POST',
      url: '/internal/model/execute',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${KID}.${SECRET}` },
      payload: {
        runId: runProdId,
        deploymentId: deploymentProdId,
        agentId,
        prompt: 'route wrong env',
      },
    });
    check(
      rWrong.statusCode === 403,
      'route SANDBOX key → PRODUCTION deploy 403',
      `got ${rWrong.statusCode} ${rWrong.body.slice(0, 200)}`,
    );

    // Positive: matching env reaches dispatch (lib with spy)
    spyCalls.length = 0;
    const okRes = await gatewayExecute(
      {
        runId,
        deploymentId: deploymentSandboxId,
        agentId,
        prompt: 'ok path',
        identity: keyed,
      },
      { dispatch: spyDispatch },
    );
    check(spyCalls.length === 1, 'matching env: dispatch called once', `n=${spyCalls.length}`);
    check(typeof okRes.text === 'string', 'matching env: returned text', okRes.text?.slice(0, 40));

    // Positive route preHandler with matching sandbox key
    // (route uses real dispatch; may fail later on engine — preHandler+binding is what we care for identity)
    const rOkAuth = await app.inject({
      method: 'GET',
      url: '/internal/model/health',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${KID}.${SECRET}` },
    });
    check(
      rOkAuth.statusCode === 200,
      'keyed identity health 200',
      `got ${rOkAuth.statusCode} ${rOkAuth.body.slice(0, 120)}`,
    );

    // Legacy zero-regression: KEYS unset
    delete process.env.AIOS_SERVICE_IDENTITY_KEYS;
    process.env.AIOS_MODEL_GATEWAY_TOKEN = LEGACY;
    const rLegacy = await app.inject({
      method: 'GET',
      url: '/internal/model/health',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${LEGACY}` },
    });
    check(
      rLegacy.statusCode === 200,
      'KEYS unset: legacy token still works (zero-regression)',
      `got ${rLegacy.statusCode}`,
    );

    await app.close();
  } catch (e) {
    fail('suite error', String(e));
    console.error(e);
  } finally {
    if (prevToken === undefined) delete process.env.AIOS_MODEL_GATEWAY_TOKEN;
    else process.env.AIOS_MODEL_GATEWAY_TOKEN = prevToken;
    if (prevKeys === undefined) delete process.env.AIOS_SERVICE_IDENTITY_KEYS;
    else process.env.AIOS_SERVICE_IDENTITY_KEYS = prevKeys;

    try {
      await prisma.costLog.deleteMany({ where: { agentId } });
      await prisma.run.deleteMany({ where: { id: { in: trackedRunIds } } });
      await prisma.runtimeDeployment.deleteMany({
        where: { id: { in: trackedDeploymentIds } },
      });
      if (artifactId) await prisma.flowArtifact.deleteMany({ where: { id: artifactId } });
      if (artifactProdId)
        await prisma.flowArtifact.deleteMany({ where: { id: artifactProdId } });
      if (skillVersionId)
        await prisma.skillVersion.deleteMany({ where: { id: skillVersionId } });
      await prisma.skill.deleteMany({ where: { id: skillId } });
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
    } catch (ce) {
      console.warn('cleanup warning', ce);
    }
  }

  console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
