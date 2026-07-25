/**
 * Ticket 05 — Record → skill (delegate to Codex; import path only tested live).
 * Run: npx tsx .scratch/agent-training-governance/tests/t05.test.ts
 *
 * Seams:
 * 1. connectEventStream + 3 tools (no recording start)
 * 2. recordingStatus() callable / safe (readonly) — no event_stream_start
 * 3. importSkillFromMarkdown: RECORDED + redactor + never CONFIRMED
 * 4. Route guards: start/stop require trainer; status requires auth
 *
 * NEVER calls event_stream_start (would pop user confirm + record 30 min).
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import {
  connectEventStream,
  assertToolsPresent,
} from '../../../src/lib/codexmcp.js';
import {
  recordingStatus,
  importSkillFromMarkdown,
} from '../../../src/lib/recording.js';
import { recordingRoutes } from '../../../src/routes/recording.js';

const EXPECTED_REC_TOOLS = ['event_stream_start', 'event_stream_status', 'event_stream_stop'];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main() {
  console.log('── t05: Record → skill import + routes ──');

  // ── 1. Live MCP: event stream connect + 3 tools (NO start) ───────────────
  console.log('\n── [1] connectEventStream + listTools (no recording) ──');
  const recClient = await connectEventStream();
  try {
    const tools = await recClient.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log('tools:', names.join(', '));
    assert(tools.length === 3, `expected 3 tools, got ${tools.length}`);
    for (const n of EXPECTED_REC_TOOLS) {
      assert(names.includes(n), `missing tool: ${n}`);
    }
    await assertToolsPresent(recClient, EXPECTED_REC_TOOLS);
    console.log('assertToolsPresent(3): OK');
  } finally {
    recClient.close();
  }

  // ── 2. recordingStatus — readonly; never start ───────────────────────────
  // In unauthenticated environments the MCP tool may return isError or time out;
  // either is acceptable as long as we do not call event_stream_start.
  console.log('\n── [2] recordingStatus (readonly, no start) ──');
  try {
    const status = await recordingStatus();
    console.log('status head:', JSON.stringify(status).slice(0, 400));
    assert(status !== undefined, 'status should be defined');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('recordingStatus error (env may lack CU auth):', msg.slice(0, 300));
    assert(
      /timeout|authenticated|輔助使用|權限|Computer Use|Record|event_stream|MCP|不可用/i.test(msg),
      `error should be readable, not opaque: ${msg}`,
    );
  }

  // ── 3. importSkillFromMarkdown (fake SKILL.md with API key) ──────────────
  console.log('\n── [3] importSkillFromMarkdown + redactor + never CONFIRMED ──');
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
        email: `t05-member-${createdMemberId.slice(-6).toLowerCase()}@test.local`,
        displayName: 'T05 Member',
        passwordHash: 'x',
        role: 'MEMBER',
      },
    });
  }

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const tmpDir = path.join(os.tmpdir(), `t05-skill-${tag}`);
  const mdPath = path.join(tmpDir, 'SKILL.md');
  const fakeKey = 'sk-testfakekeyABCDEFGH1234567890xyz';
  let importedSkillId: string | null = null;

  try {
    await prisma.agent.create({
      data: {
        id: agentId,
        slug: `t05-agent-${tag}`,
        name: 'T05 Recorded Import Agent',
        description: 'temp t05',
        rolePrompt: 'test',
        engineExecute: 'CODEX',
        createdBy: owner.id,
        riskTier: 'low',
        restrictions: {
          webSearch: false,
          computerUse: true,
          sendEmail: false,
          cloudWrite: false,
          shell: false,
        },
      },
    });

    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      mdPath,
      [
        '---',
        'name: T05 Recorded Invoice Flow',
        'description: Temporary recorded skill for import test',
        '---',
        '',
        '# T05 Recorded Invoice Flow',
        '',
        'Steps recorded from desktop automation.',
        '',
        `API_KEY=${fakeKey}`,
        '',
        '1. Open ERP',
        '2. Enter invoice amount',
        '',
      ].join('\n'),
      'utf8',
    );

    const imported = await importSkillFromMarkdown(mdPath, agentId, owner.id);
    importedSkillId = imported.skillId;
    console.log('imported:', imported);

    assert(imported.skillId, 'skillId required');
    assert(imported.reviewStatus !== 'CONFIRMED', `must never auto-confirm, got ${imported.reviewStatus}`);
    assert(
      imported.reviewStatus === 'AWAITING_USER_CONFIRM' || imported.reviewStatus === 'PENDING_UNDERSTANDING',
      `expected awaiting/pending, got ${imported.reviewStatus}`,
    );

    const skill = await prisma.skill.findUnique({ where: { id: imported.skillId } });
    assert(skill, 'skill row exists');
    assert(skill!.origin === 'RECORDED', `origin RECORDED, got ${skill!.origin}`);
    assert(skill!.kind === 'COMPUTER_CONTROL', `kind COMPUTER_CONTROL, got ${skill!.kind}`);
    assert(skill!.executionEnv === 'DESKTOP_APP', `executionEnv DESKTOP_APP, got ${skill!.executionEnv}`);
    assert(skill!.reviewStatus !== 'CONFIRMED', 'DB reviewStatus must not be CONFIRMED');
    assert(!skill!.contentMd.includes(fakeKey), 'raw API key must not appear in DB contentMd');
    assert(
      skill!.contentMd.includes('[REDACTED_API_KEY]') || !/sk-[A-Za-z0-9_-]{8,}/.test(skill!.contentMd),
      'redactor should have scrubbed the key pattern',
    );
    console.log('redactor OK; reviewStatus=', skill!.reviewStatus);

    // ── 4. Route guards ────────────────────────────────────────────────────
    console.log('\n── [4] route guards (start/stop trainer; status auth) ──');
    const app = Fastify({ logger: false });
    await app.register(recordingRoutes);

    const trainerToken = await signAccess({ sub: owner.id, email: owner.email, role: owner.role });
    const memberToken = await signAccess({ sub: member!.id, email: member!.email, role: 'MEMBER' });

    // status without auth → 401
    const s0 = await app.inject({ method: 'GET', url: '/api/recording/status' });
    console.log('status no auth:', s0.statusCode);
    assert(s0.statusCode === 401, `status unauth expected 401, got ${s0.statusCode}`);

    // start as MEMBER → 403
    const stMember = await app.inject({
      method: 'POST',
      url: '/api/recording/start',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    console.log('start as MEMBER:', stMember.statusCode, stMember.body.slice(0, 120));
    assert(stMember.statusCode === 403, `start member expected 403, got ${stMember.statusCode}`);

    // stop as MEMBER → 403
    const spMember = await app.inject({
      method: 'POST',
      url: '/api/recording/stop',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    console.log('stop as MEMBER:', spMember.statusCode);
    assert(spMember.statusCode === 403, `stop member expected 403, got ${spMember.statusCode}`);

    // status as authenticated (trainer) — may succeed or return clear MCP error; never starts recording
    const sOk = await app.inject({
      method: 'GET',
      url: '/api/recording/status',
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    console.log('status as trainer:', sOk.statusCode, sOk.body.slice(0, 200));
    assert(sOk.statusCode === 200 || sOk.statusCode === 500 || sOk.statusCode === 503, `unexpected status code ${sOk.statusCode}`);
    // Critical: we did NOT hit start in this test suite.
    console.log('guards OK (no event_stream_start invoked in this suite)');

    await app.close();
  } finally {
    if (importedSkillId) {
      await prisma.agentSkill.deleteMany({ where: { skillId: importedSkillId } }).catch(() => {});
      await prisma.skillVersion.deleteMany({ where: { skillId: importedSkillId } }).catch(() => {});
      await prisma.skill.deleteMany({ where: { id: importedSkillId } }).catch(() => {});
    }
    await prisma.agentSkill.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    if (createdMemberId) {
      await prisma.user.deleteMany({ where: { id: createdMemberId } }).catch(() => {});
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n✅ t05 ALL PASSED');
  console.log('Note: tests never called event_stream_start (no real recording).');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n❌ t05 FAILED:', e);
    process.exit(1);
  });
