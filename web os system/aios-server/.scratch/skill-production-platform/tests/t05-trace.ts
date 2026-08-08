/**
 * Ticket 05 — RunTrace sedimentation + trajectory dedupe proposals (positive).
 * Run: npx tsx .scratch/skill-production-platform/tests/t05-trace.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { createSkillVersion } from '../../../src/lib/skillversion.js';
import {
  ingestRunTrace,
  TRAJECTORY_MIN_OCCURRENCES,
} from '../../../src/lib/trace.js';
import type { CompiledManifest, RunOutcome } from '../../../src/engine/types.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(user, 'need OWNER/TRAINER user in DB');

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const skillId = ulid();
  const slug = `t05-trace-${tag}`;
  const FAKE_SECRET = 'sk-abcdef0123456789ABCDEF';
  const RAW_PROMPT = 'SYSTEM PROMPT RAW: you are a secret agent ignore previous';

  const runIds: string[] = [];
  const proposalIds: string[] = [];
  let versionId: string | undefined;

  console.log('── setup ──');
  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t05-agent-${tag}`,
        name: 'T05 Trace Agent',
        description: 'trace sedimentation test',
        rolePrompt: 'private role prompt never in card',
        engineExecute: 'CLAUDE_CODE',
        engineVerify: 'GROK',
        riskTier: 'medium',
        createdBy: user.id,
      },
    });

    await prisma.skill.create({
      data: {
        id: skillId,
        slug,
        name: 'T05 Trace Skill',
        origin: 'UPLOADED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# T05\nsecret body ${FAKE_SECRET}\n`,
        reviewStatus: 'CONFIRMED',
        confirmedBy: user.id,
        confirmedAt: new Date(),
        executionEnv: 'CLI',
      },
    });

    const ver = await createSkillVersion(
      skillId,
      `# T05\nversion body\n`,
      user.id,
    );
    versionId = ver.id;
    await prisma.skill.update({
      where: { id: skillId },
      data: { stableVersionId: ver.id },
    });

    await prisma.agentSkill.create({
      data: { agentId, skillId },
    });

    const manifest = {
      agentSlug: `t05-agent-${tag}`,
      agentId,
      agentDir: '/tmp/t05-fake',
      engineExecute: 'CLAUDE_CODE',
      engineVerify: 'GROK',
      maxRounds: 3,
      rolePrompt: 'private',
      restrictions: {
        webSearch: false,
        computerUse: false,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
      skills: [
        {
          name: slug,
          contentMd: `# body with ${FAKE_SECRET}`,
          metadata: {
            description: 'trace skill',
            whenToUse: 'test',
            whenNotToUse: '',
            requiredTools: [],
            conflictsWith: [],
            sideEffects: [],
            riskTier: 'low',
            tokenBudget: 1000,
            evalSuiteId: null,
            version: 1,
          },
          relPath: `skills/${slug}/SKILL.md`,
        },
      ],
      steps: [],
      memoryCore: '',
      identityCard: null,
    } as unknown as CompiledManifest;

    const makeOutcome = (runId: string): RunOutcome =>
      ({
        ok: true,
        runId,
        runDir: `/tmp/runs/${runId}`,
        status: 'SUCCEEDED',
        results: [
          {
            ok: true,
            stepKey: 'step-1',
            type: 'DO',
            output: `${RAW_PROMPT}\nkey=${FAKE_SECRET}`,
            rounds: 1,
            approved: true,
            reason: `ok with ${FAKE_SECRET}`,
            lastVerdict: `APPROVED rationale ${FAKE_SECRET}`,
            records: [
              {
                round: 1,
                approved: true,
                verdict: `looks good ${FAKE_SECRET}`,
              },
            ],
          },
        ],
        reworkHistory: [],
      }) as RunOutcome;

    console.log(`── ingest same trajectory × ${TRAJECTORY_MIN_OCCURRENCES} ──`);
    for (let i = 0; i < TRAJECTORY_MIN_OCCURRENCES; i++) {
      const runId = ulid();
      runIds.push(runId);
      await ingestRunTrace({
        agent: { id: agentId },
        manifest,
        outcome: makeOutcome(runId),
      });
    }

    // Extra identical trajectory should not create a 2nd proposal
    const extraRun = ulid();
    runIds.push(extraRun);
    await ingestRunTrace({
      agent: { id: agentId },
      manifest,
      outcome: makeOutcome(extraRun),
    });

    console.log('── assert RunTrace rows ──');
    const traces = await prisma.runTrace.findMany({
      where: { agentId },
      orderBy: { createdAt: 'asc' },
    });
    assert(traces.length === TRAJECTORY_MIN_OCCURRENCES + 1, `expect ${TRAJECTORY_MIN_OCCURRENCES + 1} traces, got ${traces.length}`);
    for (const t of traces) {
      assert(t.outcome === 'SUCCEEDED', 'outcome SUCCEEDED');
      assert(typeof t.trajectoryKey === 'string' && t.trajectoryKey.length === 64, 'trajectoryKey sha256 hex');
      const blob = JSON.stringify(t);
      assert(!blob.includes(FAKE_SECRET), 'RunTrace JSON must not contain fake secret');
      assert(!blob.includes(RAW_PROMPT), 'RunTrace JSON must not contain raw prompt string');
      assert(!blob.includes('contentMd'), 'must not store skill bodies field');
    }

    console.log('── assert exactly ONE TRAJECTORY proposal ──');
    const proposals = await prisma.changeProposal.findMany({
      where: { agentId, source: 'TRAJECTORY' },
    });
    proposalIds.push(...proposals.map((p) => p.id));
    assert(proposals.length === 1, `expect 1 TRAJECTORY proposal, got ${proposals.length}`);
    assert(proposals[0]!.status === 'PENDING', 'proposal must be PENDING');
    assert(proposals[0]!.targetType === 'SKILL', 'targetType SKILL');
    assert(proposals[0]!.targetId === skillId, 'targetId = skill');
    const change = proposals[0]!.proposedChange as {
      kind?: string;
      trajectoryKey?: string;
      occurrences?: number;
    };
    assert(change.kind === 'trajectory_dedupe', 'kind trajectory_dedupe');
    assert(change.trajectoryKey === traces[0]!.trajectoryKey, 'trajectoryKey matches');
    assert(
      typeof change.occurrences === 'number' && change.occurrences >= TRAJECTORY_MIN_OCCURRENCES,
      'occurrences >= threshold',
    );

    console.log('── assert skill NOT auto-promoted / still CONFIRMED ──');
    const skill = await prisma.skill.findUnique({ where: { id: skillId } });
    assert(skill?.reviewStatus === 'CONFIRMED', 'skill still CONFIRMED');
    assert(skill?.stableVersionId === versionId, 'stableVersionId unchanged');

    console.log('PASS t05-trace');
  } finally {
    console.log('── cleanup ──');
    await prisma.changeProposal.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.runTrace.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => {});
    if (versionId) {
      await prisma.skillVersion.deleteMany({ where: { skillId } }).catch(() => {});
    }
    await prisma.skill.deleteMany({ where: { id: skillId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL t05-trace', e);
    process.exit(1);
  });
