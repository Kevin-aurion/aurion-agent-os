/**
 * Ticket 04 — positive durable RecordingService (fake MCP deps, real DB).
 * Run: npx tsx .scratch/skill-production-platform/tests/t04-recording.ts
 */
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import {
  RecordingService,
  type RecordingDeps,
} from '../../../src/lib/recording.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function isOpaqueId(v: string | null | undefined): boolean {
  if (!v || typeof v !== 'string') return false;
  // Must not look like a filesystem path
  if (v.includes('/') || v.includes('\\') || v.startsWith('.')) return false;
  return v.length >= 10;
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(user, 'need OWNER/TRAINER user in DB');

  const tag = ulid().slice(-8).toLowerCase();
  const agentId = ulid();
  const createdSkillIds: string[] = [];
  const createdSessionIds: string[] = [];

  let stopCalls = 0;
  const fakeMeta = '/tmp/fake/session.json';
  const fakeEvents = '/tmp/fake/events.jsonl';

  const fakeDeps: RecordingDeps = {
    startRecording: async () => ({ sessionActive: true, raw: { ok: true } }),
    recordingStatus: async () => ({ status: 'recording' }),
    stopRecording: async () => {
      stopCalls += 1;
      return { metadataPath: fakeMeta, eventsPath: fakeEvents, raw: {} };
    },
    buildSkillFromRecording: async (args) => {
      const skillId = ulid();
      const slug = `t04-rec-${tag}-${skillId.slice(-6).toLowerCase()}`;
      await prisma.skill.create({
        data: {
          id: skillId,
          slug,
          name: `T04 Recorded ${tag}`,
          origin: 'RECORDED',
          kind: 'COMPUTER_CONTROL',
          contentMd: '---\nname: t04-recorded\n---\n# Recorded skill\nsteps: redacted-looking\n',
          generator: 'record-and-replay',
          reviewStatus: 'AWAITING_USER_CONFIRM',
          executionEnv: 'DESKTOP_APP',
        },
      });
      await prisma.agentSkill.upsert({
        where: { agentId_skillId: { agentId: args.agentId, skillId } },
        create: { agentId: args.agentId, skillId },
        update: {},
      });
      createdSkillIds.push(skillId);
      return { skillId, reviewStatus: 'AWAITING_USER_CONFIRM' };
    },
  };

  console.log('── setup agent ──');
  await prisma.agent.create({
    data: {
      id: agentId,
      slug: `t04-rec-${tag}`,
      name: 'T04 Recording Agent',
      description: 'recording service test',
      rolePrompt: 'test',
      engineExecute: 'CODEX',
      restrictions: {
        webSearch: false,
        computerUse: true,
        sendEmail: false,
        cloudWrite: false,
        shell: false,
      },
      riskTier: 'low',
      createdBy: user.id,
    },
  });

  const svc = new RecordingService(fakeDeps);

  // ── start ──
  console.log('── start ──');
  const started = await svc.start(user.id, agentId);
  assert(typeof started.sessionId === 'string', 'sessionId is string');
  assert(isOpaqueId(started.sessionId), `sessionId opaque, got ${started.sessionId}`);
  assert(started.status === 'RECORDING', `status RECORDING, got ${started.status}`);
  createdSessionIds.push(started.sessionId);

  // ── status: no path leak ──
  console.log('── status (no path leak) ──');
  const st = await svc.status(user.id, started.sessionId);
  assert(st.session, 'session present');
  assert(st.session!.id === started.sessionId, 'session id matches');
  assert(st.session!.agentId === agentId, 'session is bound to selected agent');
  assert(st.session!.status === 'RECORDING', 'session status RECORDING');
  const sessionJson = JSON.stringify(st.session);
  assert(!sessionJson.includes('metadataPath'), 'safe session has no metadataPath');
  assert(!sessionJson.includes('eventsPath'), 'safe session has no eventsPath');
  assert(!sessionJson.includes('/tmp/fake'), 'safe session has no fake path');
  assert(st.live != null, 'live probe present while RECORDING');

  // ── stop ──
  console.log('── stop ──');
  const stopped = await svc.stop(user.id, started.sessionId);
  assert(stopped.status === 'STOPPED', `stop status STOPPED, got ${stopped.status}`);
  assert(isOpaqueId(stopped.artifactId), `artifactId opaque, got ${stopped.artifactId}`);
  assert(stopCalls === 1, `stopRecording called once, got ${stopCalls}`);

  const dbRow = await prisma.recordingSession.findUnique({
    where: { id: started.sessionId },
  });
  assert(dbRow, 'db row exists');
  assert(dbRow!.status === 'STOPPED', 'db status STOPPED');
  assert(dbRow!.metadataPath === fakeMeta, `internal metadataPath persisted: ${dbRow!.metadataPath}`);
  assert(dbRow!.eventsPath === fakeEvents, `internal eventsPath persisted: ${dbRow!.eventsPath}`);
  assert(dbRow!.artifactId === stopped.artifactId, 'artifactId matches');

  // status after stop still no path leak
  const st2 = await svc.status(user.id, started.sessionId);
  assert(st2.session, 'session after stop');
  const st2json = JSON.stringify(st2.session);
  assert(!st2json.includes('metadataPath'), 'post-stop safe session no metadataPath');
  assert(!st2json.includes(fakeMeta), 'post-stop safe session no real path');

  // ── compileToDraft ──
  console.log('── compileToDraft ──');
  const compiled = await svc.compileToDraft(user.id, started.sessionId, agentId, 'hint-ok');
  assert(compiled.skillId, 'skillId returned');
  assert(compiled.reviewStatus === 'AWAITING_USER_CONFIRM', `reviewStatus AWAITING, got ${compiled.reviewStatus}`);
  assert(compiled.sessionId === started.sessionId, 'sessionId on compile result');

  const skill = await prisma.skill.findUnique({ where: { id: compiled.skillId } });
  assert(skill, 'skill exists');
  assert(skill!.origin === 'RECORDED', `origin RECORDED, got ${skill!.origin}`);
  assert(skill!.reviewStatus === 'AWAITING_USER_CONFIRM', 'skill never auto-confirmed');
  assert(skill!.kind === 'COMPUTER_CONTROL', 'kind COMPUTER_CONTROL');

  const afterCompile = await prisma.recordingSession.findUnique({
    where: { id: started.sessionId },
  });
  assert(afterCompile!.status === 'RECORDED', `row RECORDED, got ${afterCompile!.status}`);
  assert(afterCompile!.skillId === compiled.skillId, 'row skillId set');
  assert(afterCompile!.compiledAt != null, 'compiledAt set');

  // ── restart simulation / recoverInterrupted ──
  console.log('── recoverInterrupted ──');
  // Leave a live RECORDING session, then recover on a fresh service instance.
  const svcLeave = new RecordingService(fakeDeps);
  // Clear host-global DB contention from same-user RECORDING if any; start fresh.
  const left = await svcLeave.start(user.id, agentId);
  createdSessionIds.push(left.sessionId);
  assert(left.status === 'RECORDING', 'left session RECORDING');

  const svc2 = new RecordingService(fakeDeps);
  const n = await svc2.recoverInterrupted();
  assert(n >= 1, `recoverInterrupted flipped at least 1, got ${n}`);

  const leftRow = await prisma.recordingSession.findUnique({
    where: { id: left.sessionId },
  });
  assert(leftRow!.status === 'INTERRUPTED', `left session INTERRUPTED, got ${leftRow!.status}`);
  assert(leftRow!.note === 'server restart', `note server restart, got ${leftRow!.note}`);

  console.log('T04 RECORDING OK');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const skills = await prisma.skill.findMany({
        where: { slug: { startsWith: 't04-rec-' } },
        select: { id: true },
      });
      const skillIds = skills.map((s) => s.id);
      await prisma.recordingSession.deleteMany({
        where: {
          OR: [
            { metadataPath: { startsWith: '/tmp/fake/' } },
            { note: 'server restart' },
            { note: 'superseded by new recording' },
            ...(skillIds.length ? [{ skillId: { in: skillIds } }] : []),
          ],
        },
      });
      if (skillIds.length) {
        await prisma.agentSkill.deleteMany({ where: { skillId: { in: skillIds } } });
        await prisma.skillVersion.deleteMany({ where: { skillId: { in: skillIds } } }).catch(() => {});
        await prisma.skill.deleteMany({ where: { id: { in: skillIds } } });
      }
      await prisma.agentSkill.deleteMany({
        where: { agent: { slug: { startsWith: 't04-rec-' } } },
      });
      await prisma.agent.deleteMany({ where: { slug: { startsWith: 't04-rec-' } } });
    } catch (e) {
      console.warn('cleanup warn', e);
    }
    await prisma.$disconnect();
    if (!process.exitCode) process.exit(0);
  });
